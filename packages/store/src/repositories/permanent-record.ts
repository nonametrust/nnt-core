import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { open, permanentAad, seal, type KeyRing } from "../crypto.js";
import { assertRetentionPolicy, type RetentionPolicy } from "../retention.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";
import { observationSchema, type Observation } from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import { refuseWriteInsideTransaction, type Db, type Schema } from "../db.js";
import {
  NamespaceShredded, ObservationNotFound, PermanentRecordNotFound, StateNotPromotable, mapPgError,
} from "../errors.js";

/**
 * What a promotion stores. `originalDatedAt` is the source observation's own
 * instant and `promotedAt` is the clock's; the two are nine days apart in the
 * whitepaper's scenario and every window downstream depends on the first one
 * surviving. `rescuedBy` names the trigger event that caused the promotion,
 * or null for one that was not rescued by a trigger.
 */
export interface StoredPermanentRecord {
  recordId: string;
  observationId: string;
  namespaceId: string;
  originalDatedAt: Date;
  promotedAt: Date;
  rescuedBy: string | null;
  confidence: number;
}

export interface PromoteInput {
  observationId: string;
  namespaceId: string;
  rescuedBy: string | null;
  confidence: number;
}

const COLUMNS = [
  "record_id", "observation_id", "namespace_id", "original_dated_at",
  "promoted_at", "rescued_by", "confidence",
] as const;

// The payload columns are kept OUT of COLUMNS on purpose. That list is the
// metadata surface: `get` selects it and returns it to callers, and a
// shredded namespace's record must stay listable. The ciphertext is read
// only by `read`, which opens it.
const PAYLOAD_COLUMNS = ["payload_nonce", "payload_tag", "payload_ciphertext"] as const;

/**
 * The permanent record repository. Its prototype carries `promote` and `get`
 * and nothing that updates or deletes, and the table refuses both from any
 * session: a record is fixed at promotion, and a promotion that must be
 * reversed is a new fact rather than a rewrite. The test pins the absence.
 */
export class PermanentRecordRepository {
  constructor(
    private readonly db: Db,
    // The ring and the policy are here so `promote` can build repositories
    // bound to its OWN transaction and read through them (R21). Reads
    // compose on a transaction; that is the half of R21 this repository
    // depends on, and it is why "inside the same transaction" in Task 9's
    // text is true rather than aspirational.
    private readonly ring: KeyRing,
    // Public and readonly so a composition root can assert every repository
    // shares one clock -- see `surface.test.ts`. Exposing it is not a check: a
    // reader of one repository still cannot tell whose clock this is.
    readonly clock: Clock,
    private readonly policy: RetentionPolicy,
  ) {
    assertRetentionPolicy(policy);
  }

  /**
   * Promotes an observation. The instant is copied from the observation row
   * to the record by the insert itself, as `insert ... select dated_at from
   * observation`, so it never leaves the database: a copy that round-tripped
   * through a JavaScript Date would be exact only while the writer of that
   * column happened to write whole milliseconds.
   *
   * That argument is still right about the COLUMN and is now only half
   * true of this method: the binding below renders both instants
   * through a JavaScript Date, so it is exact to the millisecond and
   * blind below it. A sub-millisecond move of `promoted_at` opens --
   * measured -- and nothing but this note stands against it, because
   * `permanent_record_date_preserved` guards the other instant only
   * and the store's own writer never produces one. Recorded rather
   * than fixed: a microsecond-exact rendering is a change to
   * `crypto.ts`'s instant part and to every envelope that uses it. The pre-read that precedes
   * it is for the refusals named below, and both statements run inside one
   * transaction on one connection, so they are a single unit. What makes
   * the copied value stable is that observation accepts no UPDATE; what
   * makes the copy checked is the trigger, which compares the written value
   * against the live source row at the moment of the insert and raises
   * NNT04, which `mapPgError` turns into TimestampAltered. The repository
   * cannot reach that refusal on its own, and that is the trigger's point:
   * it is there for the writer that is not this one.
   *
   * Three refusals are named here rather than left to the database. A
   * source that does not exist is ObservationNotFound, because the row was
   * looked for and the identifier is known. A state is StateNotPromotable:
   * its dated_at is null and original_dated_at is not null, so the column
   * would refuse it as a 23502, and a caller could not tell a promoted
   * state from a broken disk. A source in a shredded namespace is
   * NamespaceShredded, and here the database would not refuse at all: the
   * observation row survives a shred and its instant is still readable. A
   * promotion exists to make evidence surface in a later brief, and evidence
   * whose content can never be read again can only produce a reason nobody
   * can explain, so it is refused for the price of the join. The namespace
   * read is the observation's own, not the caller's; whether the caller's
   * agrees with it is the composite foreign key's question.
   *
   * A namespace the observation does not belong to, a second promotion of
   * the same observation and a confidence outside the unit interval are
   * constraint violations and come back as `ConstraintViolation`, carrying
   * the SQLSTATE and the constraint name, so a caller tells them apart by
   * class rather than by message.
   *
   * The row comes back from `returning`, so what is reported is what was
   * stored and not what was meant to be.
   */
  async promote(input: PromoteInput): Promise<StoredPermanentRecord> {
    refuseWriteInsideTransaction(this.db, "promote");
    const recordId = randomUUID();
    const promotedAt = this.clock.now();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const source = await trx
          .selectFrom("observation")
          .innerJoin("namespace", "namespace.namespace_id", "observation.namespace_id")
          .select([
            "observation.dated_at", "namespace.key_shredded_at",
            // Canonical spellings, because the seal below binds BYTES. A
            // uuid column accepts any case and brace form and stores the
            // canonical lowercase, so a caller's own string and the string
            // `read` rebuilds from the row are not always the same bytes --
            // and a promotion sealed under the caller's spelling wrote a
            // complete-looking record whose payload never opened. Measured.
            // The same rule NamespaceRepository states for its own wraps:
            // bind to what the database reports, never to what was passed.
            sql<string>`observation.observation_id::text`.as("canonical_observation_id"),
            sql<string>`${input.namespaceId}::uuid::text`.as("canonical_namespace_id"),
            // Canonical for the same reason as the two above: a uuid column
            // accepts any case and brace form, so the caller's spelling and
            // the string `read` rebuilds from the row are not always the
            // same bytes -- which is exactly the defect that produced a
            // complete-looking record whose payload never opened.
            sql<string | null>`${input.rescuedBy}::uuid::text`.as("canonical_rescued_by"),
          ])
          .where("observation.observation_id", "=", input.observationId)
          // The namespace row is LOCKED, not merely read. `key_shredded_at`
          // below is a check, and a check without a lock is a window: review
          // committed an erasure between this read and the insert and got a
          // permanent copy of an erased counterparty's evidence, with no
          // refusal and no block. A second check after the write would have
          // the same window one statement further along.
          //
          // `for no key update` is the mode `shred` itself takes, so the two
          // serialise; the observation's own row is deliberately left
          // unlocked (`of namespace`), because it is append-only and nothing
          // may move it anyway. The foreign key does not close this: its
          // FOR KEY SHARE does not conflict with FOR NO KEY UPDATE.
          .modifyEnd(sql`for no key update of namespace`)
          .executeTakeFirst();
        if (!source) throw new ObservationNotFound(`no observation ${input.observationId} to promote`);
        if (source.key_shredded_at !== null) {
          throw new NamespaceShredded(
            `observation ${input.observationId} is in a namespace shredded at ${source.key_shredded_at.toISOString()}`,
          );
        }
        if (source.dated_at === null) {
          throw new StateNotPromotable(
            `observation ${input.observationId} is a state, and a state has no instant to preserve`,
          );
        }
        // The rescue itself (Task 9). Repositories bound to THIS transaction,
        // which R21 makes legitimate: reads compose on a transaction even
        // though writes do not, so Task 9's "inside the same transaction" is
        // literal. `get` opens the payload under the month key and therefore
        // raises NamespaceShredded or PayloadExpired here -- before any row
        // is written -- which is the refusal a promotion after expiry owes
        // its caller. Until this existed `promote` never opened the
        // observation at all and an expired promotion succeeded while
        // rescuing nothing.
        const txNamespaces = new NamespaceRepository(trx, this.ring, this.clock, this.policy);
        const observation = await new ObservationRepository(
          trx, txNamespaces, this.clock, this.policy,
        ).get(input.observationId);

        // Re-sealed under the NAMESPACE key and not the month key, which is
        // the whole point: the month key dies on the retention clock and
        // this must outlive it, while an erasure of the counterparty space
        // still takes it. Copying the month-sealed ciphertext across would
        // produce a record that expires with the thing it was meant to
        // rescue.
        const sealed = seal(
          await txNamespaces.dataKey(source.canonical_namespace_id),
          JSON.stringify(observation),
          permanentAad({
            recordId,
            observationId: source.canonical_observation_id,
            namespaceId: source.canonical_namespace_id,
            rescuedBy: source.canonical_rescued_by,
            confidence: input.confidence,
            originalDatedAt: source.dated_at,
            promotedAt,
          }),
        );

        // An insert from a select is positional: the aliases below are for
        // the reader, and it is the order that binds each value to its
        // column, so the select list is in COLUMNS' order. The parameters
        // need no casts; Postgres types each from the column it lands in,
        // verified on 17.7 through pg_prepared_statements.
        const row = await trx
          .insertInto("permanent_record")
          .columns([...COLUMNS, ...PAYLOAD_COLUMNS])
          .expression((eb) =>
            eb
              .selectFrom("observation")
              .select([
                eb.val(recordId).as("record_id"),
                "observation_id",
                eb.val(source.canonical_namespace_id).as("namespace_id"),
                "dated_at as original_dated_at",
                eb.val(promotedAt).as("promoted_at"),
                // The canonical spelling, so the column and the binding hold
                // the same bytes.
                eb.val(source.canonical_rescued_by).as("rescued_by"),
                eb.val(input.confidence).as("confidence"),
                eb.val(sealed.nonce).as("payload_nonce"),
                eb.val(sealed.tag).as("payload_tag"),
                eb.val(sealed.ciphertext).as("payload_ciphertext"),
              ])
              .where("observation_id", "=", input.observationId),
          )
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        return toStored(row);
      });
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
  }

  /**
   * The rescued observation itself, opened under the NAMESPACE key.
   *
   * The binding is rebuilt from the row's own columns, so a record whose
   * identity, observation, namespace or either instant has been moved does
   * not open -- the same rule the observation read follows, and the reason a
   * ciphertext lifted from another record cannot be attributed here.
   *
   * Re-parsed through the schema rather than returned as JSON, so what comes
   * back is the observation the schema admits and not whatever bytes the
   * column held. `get` stays metadata-only and keeps working for a shredded
   * namespace; this is the call that refuses.
   */
  async read(recordId: string): Promise<Observation> {
    const row = await this.db
      .selectFrom("permanent_record")
      .select([...COLUMNS, ...PAYLOAD_COLUMNS])
      .where("record_id", "=", recordId)
      .executeTakeFirst();
    if (!row) throw new PermanentRecordNotFound(`no permanent record ${recordId}`);
    const namespaces = new NamespaceRepository(this.db, this.ring, this.clock, this.policy);
    const plain = open(
      await namespaces.dataKey(row.namespace_id),
      { nonce: row.payload_nonce, tag: row.payload_tag, ciphertext: row.payload_ciphertext },
      permanentAad({
        recordId: row.record_id,
        observationId: row.observation_id,
        namespaceId: row.namespace_id,
        rescuedBy: row.rescued_by,
        confidence: row.confidence,
        originalDatedAt: row.original_dated_at,
        promotedAt: row.promoted_at,
      }),
    );
    return observationSchema.parse(JSON.parse(plain)) as Observation;
  }

  async get(recordId: string): Promise<StoredPermanentRecord> {
    const row = await this.db
      .selectFrom("permanent_record")
      .select(COLUMNS)
      .where("record_id", "=", recordId)
      .executeTakeFirst();
    if (!row) throw new PermanentRecordNotFound(`no permanent record ${recordId}`);
    return toStored(row);
  }
}

// Takes only the METADATA columns, which is what `get` selects and what a
// shredded namespace's record must still yield. Typed as a Pick rather
// than the whole row so that adding a payload column to the table cannot
// quietly oblige every caller of this to carry a ciphertext.
function toStored(
  row: Pick<Schema["permanent_record"], (typeof COLUMNS)[number]>,
): StoredPermanentRecord {
  return {
    recordId: row.record_id,
    observationId: row.observation_id,
    namespaceId: row.namespace_id,
    originalDatedAt: row.original_dated_at,
    promotedAt: row.promoted_at,
    rescuedBy: row.rescued_by,
    confidence: row.confidence,
  };
}
