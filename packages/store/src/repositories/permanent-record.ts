import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import {
  ObservationNotFound, PermanentRecordNotFound, StateNotPromotable, mapPgError,
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

export class PermanentRecordRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Promotes an observation. The instant is read off the observation row and
   * written to the record inside one transaction, on one connection, so the
   * copy and the write are a single unit and nothing can be copied from one
   * session and written in another. What actually makes the copied value
   * stable is that observation accepts no UPDATE; what makes the copy
   * checked is the trigger, which compares the written value against the
   * live source row at the moment of the insert and raises NNT04, which
   * `mapPgError` turns into TimestampAltered. The repository cannot reach
   * that refusal on its own, and that is the trigger's point: it is there
   * for the writer that is not this one.
   *
   * Two refusals are named here rather than left to the database. A source
   * that does not exist is ObservationNotFound, because the row was looked
   * for and the identifier is known. A state is StateNotPromotable: its
   * dated_at is null and original_dated_at is not null, so the column would
   * refuse it as a 23502, and a caller could not tell a promoted state from
   * a broken disk. A namespace the observation does not belong to, a second
   * promotion of the same observation and a confidence outside the unit
   * interval are constraint violations and come back as the driver's error,
   * with the constraint name on it, as tag's `open` does for the same kinds
   * of caller defect.
   *
   * The row comes back from `returning`, so what is reported is what was
   * stored and not what was meant to be.
   */
  async promote(input: PromoteInput): Promise<StoredPermanentRecord> {
    const recordId = randomUUID();
    const promotedAt = this.clock.now();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const source = await trx
          .selectFrom("observation")
          .select(["dated_at"])
          .where("observation_id", "=", input.observationId)
          .executeTakeFirst();
        if (!source) throw new ObservationNotFound(`no observation ${input.observationId} to promote`);
        if (source.dated_at === null) {
          throw new StateNotPromotable(
            `observation ${input.observationId} is a state, and a state has no instant to preserve`,
          );
        }
        const row = await trx
          .insertInto("permanent_record")
          .values({
            record_id: recordId,
            observation_id: input.observationId,
            namespace_id: input.namespaceId,
            original_dated_at: source.dated_at,
            promoted_at: promotedAt,
            rescued_by: input.rescuedBy,
            confidence: input.confidence,
          })
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
