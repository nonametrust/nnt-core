import { randomUUID } from "node:crypto";
import {
  datedAt, deriveIdempotencyKey, observationSchema,
  type Observation, type WireObservation,
} from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { sql } from "kysely";
import { open, payloadAad, seal } from "../crypto.js";
import { periodOf } from "../retention.js";
import {
  CiphertextRejected, IdempotencyKeyMismatch, ObservationNotFound, mapPgError,
} from "../errors.js";
import { PERIOD_TEXT, type NamespaceRepository } from "./namespace.js";

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

    // The month the payload is keyed under, from INGEST time, so a new
    // observation lands in the month it is written in. Minting is idempotent
    // and never revives an expired month, so a re-delivery of an old month
    // finds the row exactly as retention left it.
    //
    // A previous version of this comment said a new observation can THEREFORE
    // never land in an expired month. That is false and review measured it:
    // with `graceDays: 0` -- a policy assertRetentionPolicy explicitly admits
    // -- a month expires at its own close, so a sweep running at 00:00 on the
    // first can shred the month an append captured its instant in at
    // 23:59:59.999 the night before. The append then throws PayloadExpired
    // and the observation is dropped at write time, which is the one thing
    // this design says it does not do.
    //
    // The general condition is that the grace must exceed the skew between
    // the appending clock and the sweeping one; at the shipped ninety days it
    // is unreachable outside a simulated clock. It is recorded in the plan's
    // §2c rather than fixed here, because the fix is a shape for the result
    // of `append` and that shape belongs to Task 8.
    //
    // Minted before the insert because the foreign key requires the row, and
    // the foreign key exists so that this ordering is a constraint rather
    // than a habit.
    const period = periodOf(ingestedAt);
    await this.namespaces.periodKey(ns.namespaceId, period);

    // The payload is bound to every column written beside it, as the Date
    // the column will hold, so that a column rewritten afterwards refuses
    // the read. `read` rebuilds the same binding from the same columns.
    const dataKey = await this.namespaces.openPeriodKey(ns.namespaceId, period);
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
          period,
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
    // `period` is rendered rather than selected: a `date` read back as a
    // driver Date is local midnight, which is the previous month's last day
    // east of UTC, and the key it would then look up is the wrong one.
    //
    // Through the shared PERIOD_TEXT rather than a second copy of the format
    // string: one pattern in two files is the drift this docstring warns
    // about everywhere else.
    //
    // Honest about what this buys: NOT much, and a previous version of this
    // comment claimed a joint defence that review showed does not exist. The
    // connection pins DateStyle=ISO, and under ISO the two renderings are the
    // same string. Under a non-ISO style the read fails earlier anyway --
    // node-pg cannot parse the timestamptz text the server sends and every
    // instant arrives as null -- and the period lookup would still have
    // worked, because Postgres parses '01.09.2026'::date in the same session
    // that rendered it. So the PIN is the defence; this is a belt, kept
    // because it costs nothing and does not depend on a session setting, and
    // it is held by no test. Said plainly rather than dressed up: the earlier
    // claim that mutating both together failed was true only because
    // removing the pin breaks the pin's OWN unit test.
    const found = await sql<{
      observation_id: string; namespace_id: string; idempotency_key: string;
      evidence_kind: string; channel: string; kind: string;
      dated_at: Date | null; ingested_at: Date; producer: string; period: string;
      payload_nonce: Buffer; payload_tag: Buffer; payload_ciphertext: Buffer;
    }>`
      select observation_id, namespace_id, idempotency_key, evidence_kind, channel, kind,
             dated_at, ingested_at, producer, ${PERIOD_TEXT(sql`period`)} as period,
             payload_nonce, payload_tag, payload_ciphertext
      from observation
      where ${sql.ref(column)} = ${value}`.execute(this.db);
    const row = found.rows[0];
    if (!row) return null;
    // Raises NamespaceShredded when the namespace key is gone and
    // PayloadExpired when only this month's is, in that order: an operator
    // told a month expired, when the counterparty space was erased on
    // request, would go looking for a retention sweep instead.
    const dataKey = await this.namespaces.openPeriodKey(row.namespace_id, row.period);
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
