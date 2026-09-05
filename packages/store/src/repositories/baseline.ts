import type { Selectable } from "kysely";
import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import { mapPgError } from "../errors.js";

/**
 * A baseline's state, as M2's arithmetic will produce it and as this
 * repository stores it. Welford state as `count`, `mean`, `m2`; robust state
 * as `medianEst`, `madEst`, null until an estimator has produced them; the
 * two timescales as the fast and slow pairs. Nothing here is computed in
 * this package.
 */
export interface BaselineState {
  namespaceId: string;
  channel: string;
  aspect: string;
  count: number;
  mean: number;
  m2: number;
  medianEst: number | null;
  madEst: number | null;
  fastMean: number;
  fastM2: number;
  slowMean: number;
  slowM2: number;
}

export interface StoredBaseline extends BaselineState {
  updatedAt: Date;
}

const COLUMNS = [
  "namespace_id", "channel", "aspect", "n", "mean", "m2", "median_est", "mad_est",
  "fast_mean", "fast_m2", "slow_mean", "slow_m2", "updated_at",
] as const;

/**
 * The baseline repository. A baseline is current state and not evidence, so
 * `upsert` replaces the row: the whole state is written every time, and every
 * field of it is required, because an update that carried some fields and
 * defaulted the rest would reset an estimator to zero with no error anywhere.
 */
export class BaselineRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Writes the state for its (namespace, channel, aspect), replacing what was
   * there, stamped at the clock's instant. The row comes back from
   * `returning`, so what is reported is what was stored.
   *
   * A value outside what the table admits, NaN and the infinities among
   * them, is refused by the check constraints and comes back as the driver's
   * error with SQLSTATE 23514 and the constraint's name on it, as tag's raw
   * refusals do; a namespace with no row is 23503.
   */
  async upsert(state: BaselineState): Promise<StoredBaseline> {
    const values = {
      n: state.count,
      mean: state.mean,
      m2: state.m2,
      median_est: state.medianEst,
      mad_est: state.madEst,
      fast_mean: state.fastMean,
      fast_m2: state.fastM2,
      slow_mean: state.slowMean,
      slow_m2: state.slowM2,
      updated_at: this.clock.now(),
    };
    try {
      const row = await this.db
        .insertInto("baseline")
        .values({
          namespace_id: state.namespaceId,
          channel: state.channel,
          aspect: state.aspect,
          ...values,
        })
        .onConflict((oc) => oc.columns(["namespace_id", "channel", "aspect"]).doUpdateSet(values))
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toStored(row);
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
  }

  /** Every baseline the namespace has, in channel and aspect order. */
  async forNamespace(namespaceId: string): Promise<StoredBaseline[]> {
    const rows = await this.db
      .selectFrom("baseline")
      .select(COLUMNS)
      .where("namespace_id", "=", namespaceId)
      .orderBy("channel")
      .orderBy("aspect")
      .execute();
    return rows.map(toStored);
  }
}

// The row type is the Schema's, as read, so a column added to db.ts without
// a place in COLUMNS fails to compile at the call sites above. The rest
// below closes the other gap: `count` is `n` in SQL, so this mapper is
// written by hand, and a hand-written mapper can be handed a column and drop
// it. Every column not named in the destructuring lands in `unmapped`, and
// a non-empty `unmapped` does not satisfy an object with no properties.
function toStored(row: Selectable<Schema["baseline"]>): StoredBaseline {
  const {
    namespace_id, channel, aspect, n, mean, m2, median_est, mad_est,
    fast_mean, fast_m2, slow_mean, slow_m2, updated_at, ...unmapped
  } = row;
  unmapped satisfies Record<string, never>;
  // The driver hands a bigint back as a string. Number() of a value past
  // 2^53 would round silently, and a count that is off by one is a Welford
  // mean that is wrong from then on; refusing is the only honest answer.
  const count = Number(n);
  if (!Number.isSafeInteger(count)) {
    throw new RangeError(`baseline count ${n} is outside the safe integer range`);
  }
  return {
    namespaceId: namespace_id,
    channel,
    aspect,
    count,
    mean,
    m2,
    medianEst: median_est,
    madEst: mad_est,
    fastMean: fast_mean,
    fastM2: fast_m2,
    slowMean: slow_mean,
    slowM2: slow_m2,
    updatedAt: updated_at,
  };
}
