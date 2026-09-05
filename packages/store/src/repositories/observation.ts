import { randomUUID } from "node:crypto";
import {
  datedAt, deriveIdempotencyKey, observationSchema,
  type Observation, type WireObservation,
} from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { open, payloadAad, seal } from "../crypto.js";
import { ObservationNotFound, mapPgError } from "../errors.js";
import type { NamespaceRepository } from "./namespace.js";

export interface AppendResult {
  observation: Observation;
  created: boolean;
}

interface EncryptedRow {
  namespace_id: string;
  idempotency_key: string;
  payload_nonce: Buffer;
  payload_tag: Buffer;
  payload_ciphertext: Buffer;
}

// The one insert failure that means "already stored": Postgres's
// unique_violation, on the constraint 0002_observation.sql names for the key.
// The constraint is matched by name and not by SQLSTATE alone because the
// primary key is unique too, and a collision there would be a different
// problem wearing the same code.
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
   */
  async append(wire: WireObservation): Promise<AppendResult> {
    const parsed = observationSchema.parse(wire) as Observation;
    const key = deriveIdempotencyKey(parsed.source, parsed.channel, parsed.namespace);

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

    const dataKey = await this.namespaces.dataKey(ns.namespaceId);
    const sealed = seal(dataKey, JSON.stringify(stored), payloadAad(ns.namespaceId, key));
    // datedAt is the single reader of a date off an observation, and calling
    // it here is why this package needs no exemption in the repository's
    // single-date-reader gate. Note that the gate matches those field names
    // inside comments too, so this one describes the rule without naming
    // them.
    const dated = datedAt(stored);

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
          dated_at: dated === null ? null : new Date(dated),
          ingested_at: ingestedAt,
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
    const row = await this.db
      .selectFrom("observation")
      .select([
        "namespace_id", "idempotency_key",
        "payload_nonce", "payload_tag", "payload_ciphertext",
      ])
      .where("observation_id", "=", observationId)
      .executeTakeFirst();
    if (!row) throw new ObservationNotFound(`no observation ${observationId}`);
    return this.decrypt(row);
  }

  async byIdempotencyKey(key: string): Promise<Observation | null> {
    const row = await this.db
      .selectFrom("observation")
      .select([
        "namespace_id", "idempotency_key",
        "payload_nonce", "payload_tag", "payload_ciphertext",
      ])
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
    return row ? this.decrypt(row) : null;
  }

  private async decrypt(row: EncryptedRow): Promise<Observation> {
    // Raises NamespaceShredded when the key is gone, which is the whole point
    // of shredding: the row survives and the content does not.
    const dataKey = await this.namespaces.dataKey(row.namespace_id);
    const json = open(
      dataKey,
      { nonce: row.payload_nonce, tag: row.payload_tag, ciphertext: row.payload_ciphertext },
      payloadAad(row.namespace_id, row.idempotency_key),
    );
    return observationSchema.parse(JSON.parse(json)) as Observation;
  }
}
