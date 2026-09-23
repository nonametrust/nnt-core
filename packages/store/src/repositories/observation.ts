import { randomUUID } from "node:crypto";
import {
  datedAt, deriveIdempotencyKey, observationSchema,
  type Observation, type WireObservation,
} from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { open, payloadAad, seal } from "../crypto.js";
import {
  CiphertextRejected, IdempotencyKeyMismatch, ObservationNotFound, mapPgError,
} from "../errors.js";
import type { NamespaceRepository } from "./namespace.js";

export interface AppendResult {
  observation: Observation;
  created: boolean;
}

// The one insert failure that means "already stored": Postgres's
// unique_violation, on the constraint 0002_observation.sql names for the key.
// The constraint is matched by name and not by SQLSTATE alone because the
// primary key is unique too, and a collision there would be a different
// problem wearing the same code. It is looked at on the driver's raw error,
// before `mapPgError` runs: mapped, the same failure is a ConstraintViolation,
// and to this repository a duplicate is the retry it exists for, not a
// failure.
const UNIQUE_VIOLATION = "23505";
const IDEMPOTENCY_CONSTRAINT = "observation_idempotency";

function isDuplicateKey(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, constraint } = e as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === IDEMPOTENCY_CONSTRAINT;
}

export class ObservationRepository {
  constructor(
    private readonly db: Db,
    private readonly namespaces: NamespaceRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Writing the same source event twice is the indexer's normal retry path,
   * not a defect, so a repeat returns the stored observation and reports
   * `created: false` rather than raising. The distinction between "already
   * stored" and "conflicting" is drawn on the idempotency key alone, which is
   * what the key exists for.
   *
   * A key the caller supplied is compared with the derived one, not replaced
   * by it. Replaced, a caller that wrote under key K and then asked for K
   * would be told nothing is there about an observation this store said it
   * created. The comparison comes before the pre-read so a mismatch is never
   * answered with `created: false` either: a wrong key is a wrong key whether
   * or not the observation happens to be stored already.
   */
  async append(wire: WireObservation): Promise<AppendResult> {
    const parsed = observationSchema.parse(wire) as Observation;
    const key = deriveIdempotencyKey(parsed.source, parsed.channel, parsed.namespace);
    if (parsed.idempotencyKey !== undefined && parsed.idempotencyKey !== key) {
      throw new IdempotencyKeyMismatch(
        `idempotency key ${parsed.idempotencyKey} was supplied, but this observation derives to ${key}`,
      );
    }

    const existing = await this.byIdempotencyKey(key);
    if (existing) return { observation: existing, created: false };

    const ns = await this.namespaces.ensure(parsed.namespace);
    const observationId = randomUUID();
    const ingestedAt = this.clock.now();
    const stored = {
      ...parsed,
      observationId,
      idempotencyKey: key,
      ingestedAt: ingestedAt.toISOString(),
    } as Observation;

    // datedAt is the single reader of a date off an observation, and calling
    // it here is why this package needs no exemption in the repository's
    // single-date-reader gate. Note that the gate matches those field names
    // inside comments too, so this one describes the rule without naming
    // them.
    const dated = datedAt(stored);
    const datedColumn = dated === null ? null : new Date(dated);

    // The payload is bound to every column written beside it, as the Date
    // the column will hold, so that a column rewritten afterwards refuses
    // the read. `read` rebuilds the same binding from the same columns.
    const dataKey = await this.namespaces.dataKey(ns.namespaceId);
    const sealed = seal(dataKey, JSON.stringify(stored), payloadAad({
      namespaceId: ns.namespaceId,
      observationId,
      idempotencyKey: key,
      evidenceKind: stored.evidenceKind,
      channel: stored.channel,
      kind: stored.kind,
      producer: stored.source.producer,
      ingestedAt,
      datedAt: datedColumn,
    }));

    try {
      await this.db
        .insertInto("observation")
        .values({
          observation_id: observationId,
          idempotency_key: key,
          namespace_id: ns.namespaceId,
          channel: stored.channel,
          kind: stored.kind,
          evidence_kind: stored.evidenceKind,
          dated_at: datedColumn,
          ingested_at: ingestedAt,
          producer: stored.source.producer,
          payload_nonce: sealed.nonce,
          payload_tag: sealed.tag,
          payload_ciphertext: sealed.ciphertext,
        })
        .execute();
    } catch (e) {
      // A concurrent writer may have inserted the same key between the read
      // above and this insert. That is a duplicate, not a failure, and it is
      // the only failure that is one. Re-reading after any other error would
      // let a row some other writer stored stand in for the one this call
      // failed to store, and the caller would be told "already stored" about
      // a failure it never heard of.
      if (isDuplicateKey(e)) {
        const again = await this.byIdempotencyKey(key);
        if (again) return { observation: again, created: false };
      }
      throw mapPgError(e) ?? e;
    }
    return { observation: stored, created: true };
  }

  async get(observationId: string): Promise<Observation> {
    const found = await this.read("observation_id", observationId);
    if (!found) throw new ObservationNotFound(`no observation ${observationId}`);
    return found;
  }

  async byIdempotencyKey(key: string): Promise<Observation | null> {
    return this.read("idempotency_key", key);
  }

  /**
   * The one read path. Both public reads go through it because both must
   * rebuild the associated data from the same six columns the write bound it
   * to; two hand-copied selects are how those inputs would eventually diverge,
   * and the failure would be a payload that opens on one path and not the
   * other. The payload is not compared to the columns after it opens: a
   * column that disagrees with it does not open at all.
   */
  private async read(
    column: "observation_id" | "idempotency_key",
    value: string,
  ): Promise<Observation | null> {
    const row = await this.db
      .selectFrom("observation")
      .select([
        "observation_id", "namespace_id", "idempotency_key", "evidence_kind", "channel", "kind",
        "dated_at", "ingested_at", "producer",
        "payload_nonce", "payload_tag", "payload_ciphertext",
      ])
      .where(column, "=", value)
      .executeTakeFirst();
    if (!row) return null;
    // Raises NamespaceShredded when the key is gone, which is the whole point
    // of shredding: the row survives and the content does not.
    const dataKey = await this.namespaces.dataKey(row.namespace_id);
    const json = open(
      dataKey,
      { nonce: row.payload_nonce, tag: row.payload_tag, ciphertext: row.payload_ciphertext },
      payloadAad({
        namespaceId: row.namespace_id,
        observationId: row.observation_id,
        idempotencyKey: row.idempotency_key,
        evidenceKind: row.evidence_kind,
        channel: row.channel,
        kind: row.kind,
        producer: row.producer,
        ingestedAt: row.ingested_at,
        datedAt: row.dated_at,
      }),
    );
    const parsed = observationSchema.parse(JSON.parse(json)) as Observation;
    // The envelope already binds the row's primary key, so a payload that
    // opens here belongs to this row. This is the second reading of the same
    // rule, kept because the docstring above claims the store never serves a
    // payload under an identifier that is not its own, and a claim this cheap
    // to enforce should not rest on one layer.
    if (parsed.observationId !== row.observation_id) {
      throw new CiphertextRejected(
        `payload on row ${row.observation_id} carries observation id ${String(parsed.observationId)}`,
      );
    }
    return parsed;
  }
}
