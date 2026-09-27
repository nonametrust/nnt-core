import { sql, type Selectable } from "kysely";
import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import { BaselineStale, mapPgError } from "../errors.js";

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
    // Public and readonly so a composition root can assert every repository
    // shares one clock -- see `surface.test.ts`. Exposing it is not a check: a
    // reader of one repository still cannot tell whose clock this is.
    readonly clock: Clock,
  ) {}

  /**
   * Writes the state for its (namespace, channel, aspect), stamped at the
   * clock's instant, ONLY IF the stored row is still at the count the caller
   * read. The row comes back from `returning`, so what is reported is what was
   * stored.
   *
   * `expectedCount` is the `n` the caller read before folding, or `null` when it
   * read no row at all. It is a PARAMETER and not a field on `BaselineState`,
   * deliberately: `gates/baseline-shape.test.ts` holds that shape equal field for
   * field between `@nonametrust/tagging` and this package, and tagging's
   * arithmetic has no business carrying a concurrency token.
   *
   * WHY OPTIMISTIC AT ALL (R9, closing F14). This was `on conflict do update`
   * with no predicate, and that is last-writer-wins. Measured: two writers each
   * read `count = 10`, each folded one observation, each wrote `count = 11` with
   * a different mean, both statements succeeded, and the row ended at 11 with one
   * observation's contribution gone and NO ERROR ANYWHERE. Chosen over a per-pair
   * advisory lock because the advisory key space is already shared and
   * unallocated, with a measured deadlock history.
   *
   * A value outside what the table admits, NaN and the infinities among them, is
   * refused by the check constraints and raised as ConstraintViolation with
   * SQLSTATE 23514 and the constraint's name on it, as tag's refusals are; a
   * namespace with no row is the same class under 23503.
   *
   * Composes on a `Transaction`, and must: R10 makes the fold and the tag write
   * one unit of work, so a stale tag rolls the fold back with it.
   */
  async upsert(state: BaselineState, expectedCount: number | null): Promise<StoredBaseline> {
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
    let row;
    try {
      row = await this.db
        .insertInto("baseline")
        .values({
          namespace_id: state.namespaceId,
          channel: state.channel,
          aspect: state.aspect,
          ...values,
        })
        .onConflict((oc) => {
          const update = oc.columns(["namespace_id", "channel", "aspect"]).doUpdateSet(values);
          // `expectedCount` is null when the caller read no row. There is then no
          // count to match, and a conflict means its read was stale -- so the
          // predicate is one nothing satisfies, and the zero-row branch below
          // reports it. Written as a false predicate rather than an impossible
          // number, because `n >= 0` is the table's rule and not this method's.
          return expectedCount === null
            ? update.where(sql<boolean>`false`)
            : update.where("baseline.n", "=", expectedCount);
        })
        .returning(COLUMNS)
        .executeTakeFirst();
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
    if (row !== undefined) return toStored(row);
    // Zero rows is two conditions with two cures, told apart the way `refresh`
    // tells `TagRefreshStale` from `TagNotFound`: a caller given the wrong one
    // retries forever or gives up wrongly.
    const live = await this.db
      .selectFrom("baseline")
      .select("n")
      .where("namespace_id", "=", state.namespaceId)
      .where("channel", "=", state.channel)
      .where("aspect", "=", state.aspect)
      .executeTakeFirst();
    if (live === undefined) {
      // Unreachable through the insert path -- nothing deletes a baseline row, so
      // a conflict means a row is there. Named rather than swallowed, because an
      // invariant that stops holding should say so instead of returning a lie.
      throw new BaselineStale(
        `baseline ${state.namespaceId}/${state.channel}/${state.aspect} neither conflicted ` +
          `nor exists; the row was deleted between the write and this read`,
      );
    }
    // Says what is true rather than what is likely: the row is not at the count
    // this fold was built on. Usually that is another fold landing first; it is
    // also what a caller handing a count that skips a step sees.
    throw new BaselineStale(
      `baseline ${state.namespaceId}/${state.channel}/${state.aspect} is not at count ` +
        `${expectedCount === null ? "(none)" : expectedCount}, which this fold was built on; ` +
        `re-read the baseline and fold again`,
    );
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
