import { assertBaseline, type BaselineState } from "./baseline.js";
import type { Policy } from "./policy.js";
import type { ContinuousChannel } from "./reading.js";
import { robustScale, surpriseOf } from "./scale.js";

// This module takes values from baseline.ts and scale.ts and a type each
// from policy.ts and reading.ts. Nothing here reaches back into any of them,
// and nothing imports this module yet; tag.ts will.

// The three policy fields this module reads are checked where they are
// read, under the wording assertPolicy gives them, so a refusal reads the
// same whether the pipeline's entry or the arithmetic notices. A zero
// minimum count makes the shrinkage divide zero by zero at count zero; a
// NaN base or coefficient leaves as a NaN threshold. Neither leaves this
// package.
function requireMinObservations(policy: Policy): number {
  const n = policy.minObservations;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`policy.minObservations must be a positive integer, got ${n}`);
  }
  return n;
}

function requireNonNegativeField(name: "thresholdBase" | "noiseCoefficient", policy: Policy): number {
  const value = policy[name];
  if (!(value >= 0) || !Number.isFinite(value)) {
    throw new RangeError(`policy.${name} must be a non-negative finite number, got ${value}`);
  }
  return value;
}

/**
 * The namespace's observed noise on this aspect, as the robust scale over
 * the magnitude of its location. Dimensionless, so a quarter-unit payment
 * stream and a thousand-unit one with the same relative spread read the
 * same, which is what lets one prior per channel stand in for a fleet. The
 * floor is added to the location so that a location of zero divides
 * nothing.
 *
 * The state goes through robustScale before the location is looked at, so
 * a row this arithmetic could not have written is refused under the
 * baseline's own message and not under a vaguer one about its location.
 * The quotient is checked because a floor far smaller than the scale can
 * carry it past a double, and no infinity leaves here.
 */
export function noiseOf(state: BaselineState, floor: number): number {
  const scale = robustScale(state, floor);
  if (state.medianEst === null) {
    throw new RangeError(`baseline ${state.channel}/${state.aspect} has no location to measure noise against`);
  }
  const noise = scale / (Math.abs(state.medianEst) + floor);
  if (!Number.isFinite(noise)) {
    throw new RangeError(`noise of ${state.channel}/${state.aspect}, a scale of ${scale} over a location of ${state.medianEst}, does not fit a double`);
  }
  return noise;
}

/**
 * The observed noise pulled toward the channel's prior with the weight of
 * the minimum count. At exactly the minimum the two halves are equal; at
 * ten times it the prior is a tenth. This is the parent spec's shrinkage
 * toward a fleet-wide prior, with the prior a declared constant because
 * v0 has no fleet to aggregate and a store read would cross the boundary.
 */
export function shrinkNoise(noise: number, count: number, prior: number, policy: Policy): number {
  if (!(noise >= 0) || !Number.isFinite(noise)) throw new RangeError(`noise must be non-negative and finite, got ${noise}`);
  if (!(prior >= 0) || !Number.isFinite(prior)) throw new RangeError(`prior must be non-negative and finite, got ${prior}`);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`count must be a non-negative integer, got ${count}`);
  const m = requireMinObservations(policy);
  const shrunk = (count * noise + m * prior) / (count + m);
  // The combination lies between the two inputs, so a finite answer always
  // exists; what can fail is the product of a large count and a large noise
  // on the way there. Refused, not returned.
  if (!Number.isFinite(shrunk)) {
    throw new RangeError(`noise ${noise} shrunk over ${count} observations toward ${prior} does not fit a double`);
  }
  return shrunk;
}

/**
 * θ_tag: the base threshold raised in proportion to the noise. Where a
 * namespace's observed noise is high the threshold rises with it, so an
 * adversary who cannot lower their own surprise gains nothing by raising
 * everyone's noise. Monotone in the noise and equal to the base at zero.
 *
 * The product is checked on the way out: a finite base times a finite
 * factor can still overflow, and a threshold of infinity is a gate nothing
 * crosses, which is the silent absence of a tag this package refuses to
 * produce.
 */
export function tagThreshold(noise: number, policy: Policy): number {
  if (!(noise >= 0) || !Number.isFinite(noise)) throw new RangeError(`noise must be non-negative and finite, got ${noise}`);
  const base = requireNonNegativeField("thresholdBase", policy);
  const coefficient = requireNonNegativeField("noiseCoefficient", policy);
  const threshold = base * (1 + coefficient * noise);
  if (!Number.isFinite(threshold)) {
    throw new RangeError(`threshold of ${base} raised by ${coefficient} times a noise of ${noise} does not fit a double`);
  }
  return threshold;
}

export type SurpriseVerdict =
  | { kind: "cold"; count: number; minObservations: number }
  | { kind: "measured"; surprise: number; noise: number; threshold: number; crosses: boolean };

/**
 * The verdict on one continuous reading against its baseline as it stands
 * before the reading joins it.
 *
 * Cold start is explicit: below the minimum count there is no verdict, only
 * the count and the bar it fell short of, whatever the value was. This is
 * what makes acceptance criterion 1 a property of the function and not of
 * any caller. A null baseline is a counterparty nobody has seen and is
 * cold at count zero.
 *
 * A baseline that is not null is checked before its count is read. A row
 * this arithmetic could not have written is refused, under the baseline's
 * own message, and is not reported cold on the strength of a count that
 * cannot be trusted; a refusal is never turned into the absence of a tag.
 * The same holds above the count, where surpriseOf's refusals propagate.
 *
 * Above the count: the signed surprise, the shrunk noise, the threshold it
 * yields, and whether the magnitude crosses it. The sign is carried, since
 * direction is information; the gate reads the magnitude.
 */
export function judgeSurprise(
  value: number,
  state: BaselineState | null,
  channel: ContinuousChannel,
  floor: number,
  policy: Policy,
): SurpriseVerdict {
  const minObservations = requireMinObservations(policy);
  if (state !== null) assertBaseline(state);
  const count = state === null ? 0 : state.count;
  if (state === null || count < minObservations) {
    return { kind: "cold", count, minObservations };
  }
  const surprise = surpriseOf(value, state, floor);
  const noise = shrinkNoise(noiseOf(state, floor), count, policy.fleetPrior[channel], policy);
  const threshold = tagThreshold(noise, policy);
  return { kind: "measured", surprise, noise, threshold, crosses: Math.abs(surprise) >= threshold };
}
