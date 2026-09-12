import { assertBaseline, type BaselineState } from "./baseline.js";
import { requireScaleFloor } from "./policy.js";

/**
 * The scale a deviation is measured in: the baseline's spread, or the floor
 * when the spread is smaller, including when it is zero.
 *
 * The spread is madEst, the winsorized running mean absolute deviation that
 * baseline.ts documents; it is not a median absolute deviation, and the
 * resistance it carries is the clip's, not the estimator's.
 *
 * The floor is what bounds the zero-spread case. Surprise is a deviation
 * over a scale, and a counterparty whose every payment was the same amount
 * has a spread of exactly zero; the expression is then undefined, and the
 * store refuses the infinity and the NaN it yields. Refusing to tag such a
 * counterparty is a hole an adversary can sit in; falling back to the
 * Welford deviation reintroduces the non-robust estimator at the one point
 * the robust one was chosen for. So the floor, one per (channel, aspect) in
 * the policy, declared uncalibrated, and never the quantity's granularity.
 *
 * Before any observation the spread is null and the scale is the floor, so
 * the first update has a band to clip against.
 *
 * The state is checked on the way in, by the baseline's own refusals: a
 * negative spread would sit below every floor and max() would hide it, and
 * a NaN spread would come out of max() as NaN.
 */
export function robustScale(state: BaselineState, floor: number): number {
  assertBaseline(state);
  requireScaleFloor(floor);
  return Math.max(state.madEst ?? 0, floor);
}

/**
 * The signed robust z-score of an observation against its baseline. Signed:
 * the tag gate reads the magnitude, but direction is information a later
 * milestone may want and discarding it here cannot be undone. An
 * unexpectedly large payment is a signal, and so is the small test payment
 * that precedes a loss.
 *
 * Always finite. The scale is never zero, so division cannot produce an
 * infinity from a finite deviation; a deviation that itself overflows a
 * double is refused rather than divided, and a quotient that overflows
 * because the floor is far smaller than the deviation is refused rather
 * than returned. No infinity is constructed here to be caught later.
 *
 * The scale is taken before the deviation, so a refusal names its cause in
 * order: the observation, the state, the floor, the location, the
 * deviation, the quotient.
 */
export function surpriseOf(x: number, state: BaselineState, floor: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`observation must be finite, got ${x}`);
  const scale = robustScale(state, floor);
  if (state.medianEst === null) {
    throw new RangeError(`baseline ${state.channel}/${state.aspect} has no location to measure against`);
  }
  const deviation = x - state.medianEst;
  if (!Number.isFinite(deviation)) {
    throw new RangeError(`deviation of ${x} from ${state.medianEst} does not fit a double`);
  }
  const z = deviation / scale;
  if (!Number.isFinite(z)) {
    throw new RangeError(`surprise of ${x}, a deviation of ${deviation} over a scale of ${scale}, does not fit a double`);
  }
  return z;
}
