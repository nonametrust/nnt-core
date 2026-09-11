import type { Policy } from "./policy.js";

/**
 * A baseline's state, as this package's arithmetic produces it and as
 * packages/store stores it. The two declarations are held equal field for
 * field, name and written type, by the root gate gates/baseline-shape.test.ts;
 * a field added here and not there, or there and not here, fails that gate
 * on the day it is added. The type does not live in schema, because schema
 * is the indexer's contract and the engine's internal state has no business
 * in it, and it does not live in store, because this package may not depend
 * on store.
 *
 * Welford state as count, mean, m2. The robust pair as medianEst, madEst,
 * null together before the first observation and present together from it.
 * The two timescales as the fast and slow pairs, which timescales.ts moves.
 *
 * What the robust pair is, honestly. The columns are named median_est and
 * mad_est, and neither holds the sample median or the median absolute
 * deviation: a constant-space update cannot produce either, because both
 * need the history the store deliberately does not keep. What is held is a
 * winsorized location and a winsorized dispersion, the running mean of
 * values clipped at a multiple of the current scale and the running mean of
 * the clipped absolute deviations from it. That is an online M-estimator,
 * and it has the property the median and the MAD were chosen for, which is
 * bounded influence: one observation moves either estimate by at most
 * multiple × scale / n. Do not "fix" this into a true median: any estimator
 * that needs history cannot be fed from this row.
 *
 * A streaming quantile sketch was the alternative and was rejected on its
 * merits, not for convenience. It needs a step-size parameter, which would
 * be one more uncalibrated number, and it converges worst on exactly the
 * short histories this milestone spends most of its time in, around the
 * minimum observation count.
 *
 * The cost is real and is recorded here rather than hidden. Against a
 * heavily skewed distribution an M-estimator's location sits between the
 * mean and the median, so it is less resistant than a true median would be.
 * If calibration later looks wrong on a skewed channel, this is the first
 * thing to re-examine.
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

/**
 * The state before any observation. m2 is zero because a sum of no squared
 * deviations is zero, which settles the first question 0006 left open; the
 * robust pair is null because there is no location to deviate from yet,
 * which settles the second.
 */
export function emptyBaseline(namespaceId: string, channel: string, aspect: string): BaselineState {
  return {
    namespaceId, channel, aspect,
    count: 0, mean: 0, m2: 0, medianEst: null, madEst: null,
    fastMean: 0, fastM2: 0, slowMean: 0, slowM2: 0,
  };
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`);
}

function requireNonNegative(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`${name} must be non-negative, got ${value}`);
}

/**
 * A state this arithmetic could have produced, and one it can safely take
 * in. The shape it refuses first is a location without a spread or a spread
 * without a location: a spread is a deviation from a location, and one
 * without the other has no meaning. Beyond that it restates the baseline
 * table's checks, every float finite and the sums of deviations
 * non-negative, because a NaN in a running mean is permanent, every later
 * update being NaN plus something, and this is the place that can refuse
 * it before the arithmetic carries it forward.
 */
export function assertBaseline(state: BaselineState): void {
  if ((state.medianEst === null) !== (state.madEst === null)) {
    throw new RangeError(
      `baseline ${state.channel}/${state.aspect} carries one robust estimate without the other`,
    );
  }
  if (!Number.isSafeInteger(state.count) || state.count < 0) {
    throw new RangeError(`baseline count must be a non-negative integer, got ${state.count}`);
  }
  if (state.count === 0 && state.medianEst !== null) {
    throw new RangeError("a baseline with no observations cannot carry a location");
  }
  requireFinite("baseline mean", state.mean);
  requireNonNegative("baseline m2", state.m2);
  if (state.medianEst !== null) requireFinite("baseline medianEst", state.medianEst);
  if (state.madEst !== null) requireNonNegative("baseline madEst", state.madEst);
  requireFinite("baseline fastMean", state.fastMean);
  requireNonNegative("baseline fastM2", state.fastM2);
  requireFinite("baseline slowMean", state.slowMean);
  requireNonNegative("baseline slowM2", state.slowM2);
}

export interface ClipRule {
  multiple: number;
  scale: number;
}

/**
 * The observation clipped to `location ± multiple × scale`. This is the
 * bounded-influence protection: no single observation moves any estimator
 * by more than multiple × scale / n, whatever its value.
 *
 * With no location there is no band, and the value passes through: the
 * first observation is the location.
 *
 * The scale is an argument and not read off the state here, because the
 * scale carries the floor that scale.ts owns, and the floor is what keeps
 * a counterparty with a perfectly regular history from having a band of
 * zero width, which would freeze its baseline at the first value forever.
 */
export function winsorize(x: number, location: number | null, rule: ClipRule): number {
  requireFinite("observation", x);
  if (!(rule.scale > 0) || !Number.isFinite(rule.scale)) {
    throw new RangeError(`scale must be positive and finite, got ${rule.scale}`);
  }
  if (!(rule.multiple > 0) || !Number.isFinite(rule.multiple)) {
    throw new RangeError(`multiple must be positive and finite, got ${rule.multiple}`);
  }
  if (location === null) return x;
  requireFinite("location", location);
  const half = rule.multiple * rule.scale;
  // A half-width that overflowed is a band that clips nothing, and the bound
  // this function exists to hold would be infinite. Refused, so the bound is
  // finite whenever a value comes back.
  requireFinite("band half-width", half);
  return Math.min(Math.max(x, location - half), location + half);
}

/**
 * The next state after one observation. Clip first, then update: an update
 * that used the raw value and clipped afterwards would already have moved
 * the mean, and the band would have been computed around a location the
 * outlier had already pulled. baseline.test.ts pins the order by a case
 * where the two orders give different numbers.
 *
 * Welford's recursion for mean and m2 in the standard streaming form: every
 * observation counts the same forever, which is what these two are for and
 * why the fast and slow pairs exist beside them.
 *
 * The robust pair: the location is the running mean of clipped values and
 * the spread the running mean of clipped absolute deviations from the
 * location before the update. Neither is the sample median or the median
 * absolute deviation, which constant space cannot hold; both have the
 * property those were chosen for, that one observation moves them by at
 * most multiple × scale / n. The interface's docstring says what was
 * considered instead and what this choice costs.
 *
 * The fast and slow pairs are carried unchanged here and moved by
 * timescales.ts, which Task 6 wires in.
 *
 * The state is checked on the way in and on the way out. Finite in does
 * not guarantee finite out: a scale large enough to overflow the band's
 * half-width clips nothing, and the Welford delta can then overflow. A
 * non-finite result is refused here rather than handed to the store.
 */
export function updateBaseline(state: BaselineState, x: number, scale: number, policy: Policy): BaselineState {
  assertBaseline(state);
  const clipped = winsorize(x, state.medianEst, { multiple: policy.winsorMadMultiple, scale });

  const count = state.count + 1;
  const delta = clipped - state.mean;
  const mean = state.mean + delta / count;
  const m2 = state.m2 + delta * (clipped - mean);

  let medianEst: number;
  let madEst: number;
  if (state.medianEst === null || state.madEst === null) {
    medianEst = clipped;
    madEst = 0;
  } else {
    medianEst = state.medianEst + (clipped - state.medianEst) / count;
    madEst = state.madEst + (Math.abs(clipped - state.medianEst) - state.madEst) / count;
  }

  const next: BaselineState = { ...state, count, mean, m2, medianEst, madEst };
  assertBaseline(next);
  return next;
}
