import { requireMinObservations, type Policy } from "./policy.js";

// This module takes requireMinObservations and a type from policy.ts, which
// itself takes only a type from reading.ts, and nothing from any other module
// of the package, so no cycle is possible. tag.ts takes calibrateG0 and
// uncertaintyOf from here as values, and nothing here reaches back.

// The two policy fields this module reads are checked where they are read,
// under the wording assertPolicy gives them, so a refusal reads identically
// whether the pipeline's entry or the arithmetic itself notices. A zero
// minimum count divides zero by zero at count zero, and is refused by
// requireMinObservations, the one predicate for it, in policy.ts; a zero
// scale divides zero by zero at surprise zero, and is refused here. Both
// would leave as a NaN, and no NaN leaves this package.
function requireSurpriseScale(policy: Policy): number {
  const tau = policy.surpriseScale;
  if (!(tau > 0) || !Number.isFinite(tau)) {
    throw new RangeError(`policy.surpriseScale must be a positive finite number, got ${tau}`);
  }
  return tau;
}

/**
 * How little history stands behind a baseline, as a number in (0, 1]: one
 * before any observation, one half at the minimum count, falling toward
 * zero as the count grows and never reaching it. The minimum count is the
 * pseudo-count, so that a counterparty at exactly the threshold of being
 * taggable is scored at half confidence rather than full.
 */
export function uncertaintyOf(count: number, policy: Policy): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  const minObservations = requireMinObservations(policy);
  return minObservations / (count + minObservations);
}

/**
 * The calibrated g0: weight × (1 − uncertainty) × (1 − exp(−|surprise| / τ)).
 *
 * Bounded by the weight, and so by one, for every finite surprise, because
 * each factor lies in [0, 1]; no clamp is applied afterwards and none is
 * needed. Monotone in |surprise|, because the last factor is; strictly
 * decreasing in uncertainty, because the middle one is. The tag table's
 * finiteness check on g0 is therefore a backstop and never the thing that
 * first notices a problem.
 *
 * The magnitude is read here and the sign is not: direction is information
 * a later milestone may want, and it leaves this package on the result
 * untouched, from surpriseOf and not from here.
 *
 * τ is policy.surpriseScale, the surprise at which g0 reaches 1 − 1/e of
 * its ceiling for a counterparty with no uncertainty. It is uncalibrated.
 *
 * The weight arrives as a bare number, and this function cannot tell a
 * calibrated one from the policy's unmeasured value; channelWeight is where
 * that split is made, and the result that carries g0 is where it has to be
 * named. Taking the weight rather than the channel is what lets the two
 * properties above be held over every weight in (0, 1] and not only over
 * the seven the shipped files happen to carry.
 */
export function calibrateG0(surprise: number, uncertainty: number, weight: number, policy: Policy): number {
  if (!Number.isFinite(surprise)) throw new RangeError(`surprise must be finite, got ${surprise}`);
  if (!(uncertainty >= 0 && uncertainty <= 1)) {
    throw new RangeError(`uncertainty must lie in [0, 1], got ${uncertainty}`);
  }
  if (!(weight > 0 && weight <= 1)) throw new RangeError(`weight must lie in (0, 1], got ${weight}`);
  const tau = requireSurpriseScale(policy);
  const evidence = 1 - Math.exp(-Math.abs(surprise) / tau);
  return weight * (1 - uncertainty) * evidence;
}
