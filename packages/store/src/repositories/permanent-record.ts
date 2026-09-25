import { randomUUID } from "node:crypto";
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

/**
 * The permanent record repository. Its prototype carries `promote` and `get`
 * and nothing that updates or deletes, and the table refuses both from any
 * session: a record is fixed at promotion, and a promotion that must be
 * reversed is a new fact rather than a rewrite. The test pins the absence.
 */
export class PermanentRecordRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Promotes an observation. The instant is copied from the observation row
   * to the record by the insert itself, as `insert ... select dated_at from
   * observation`, so it never leaves the database: a copy that round-tripped
   * through a JavaScript Date would be exact only while the writer of that
   * column happened to write whole milliseconds. The pre-read that precedes
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
          .select(["observation.dated_at", "namespace.key_shredded_at"])
          .where("observation.observation_id", "=", input.observationId)
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
        // An insert from a select is positional: the aliases below are for
        // the reader, and it is the order that binds each value to its
        // column, so the select list is in COLUMNS' order. The parameters
        // need no casts; Postgres types each from the column it lands in,
        // verified on 17.7 through pg_prepared_statements.
        const row = await trx
          .insertInto("permanent_record")
          .columns(COLUMNS)
          .expression((eb) =>
            eb
              .selectFrom("observation")
              .select([
                eb.val(recordId).as("record_id"),
                "observation_id",
                eb.val(input.namespaceId).as("namespace_id"),
                "dated_at as original_dated_at",
                eb.val(promotedAt).as("promoted_at"),
                eb.val(input.rescuedBy).as("rescued_by"),
                eb.val(input.confidence).as("confidence"),
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

function toStored(row: Schema["permanent_record"]): StoredPermanentRecord {
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
