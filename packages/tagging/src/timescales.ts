import type { BaselineState } from "./baseline.js";
import { requireScaleFloor } from "./policy.js";

// This module takes only a type from baseline.ts, which is erased, while
// baseline.ts takes timescaleStep and assertTimescales from here as values.
// That is one direction, and it must stay one direction: a value taken from
// baseline.ts here would make a module cycle, which works until a top-level
// constant or a reordered export makes it fail at load time with an
// undefined binding, and no test would see it because tests load in one order.
// The one value taken is from policy.ts, which takes nothing from here.

export interface Timescale {
  mean: number;
  m2: number;
}

/** The four timescale fields of a baseline, as the two pairs. */
export type TimescalePairs = Pick<BaselineState, "fastMean" | "fastM2" | "slowMean" | "slowM2">;

/**
 * The validity of the two pairs: each mean finite, each variance finite and
 * non-negative. This is the one place those four checks are written.
 * assertBaseline calls it for the whole state and timescaleDivergence for
 * the fields it reads, so a refusal reads identically wherever it comes
 * from, and timescales.test.ts holds the two callers in agreement case by
 * case rather than leaving it to a sentence.
 */
export function assertTimescales(pairs: TimescalePairs): void {
  if (!Number.isFinite(pairs.fastMean)) throw new RangeError(`baseline fastMean must be finite, got ${pairs.fastMean}`);
  if (!Number.isFinite(pairs.fastM2)) throw new RangeError(`baseline fastM2 must be finite, got ${pairs.fastM2}`);
  if (pairs.fastM2 < 0) throw new RangeError(`baseline fastM2 must be non-negative, got ${pairs.fastM2}`);
  if (!Number.isFinite(pairs.slowMean)) throw new RangeError(`baseline slowMean must be finite, got ${pairs.slowMean}`);
  if (!Number.isFinite(pairs.slowM2)) throw new RangeError(`baseline slowM2 must be finite, got ${pairs.slowM2}`);
  if (pairs.slowM2 < 0) throw new RangeError(`baseline slowM2 must be non-negative, got ${pairs.slowM2}`);
}

/**
 * One exponentially weighted step. The mean moves by alpha times the
 * deviation; the variance is the standard incremental form,
 * (1 − alpha) × (m2 + alpha × delta²), which is what makes m2 here the
 * weighted variance rather than a sum. The first observation seeds both,
 * because a weighted mean started from zero would spend its first steps
 * climbing toward the data rather than describing it.
 *
 * Finite in does not guarantee finite out: two finite operands can have a
 * difference, or a squared difference, that does not fit a double. The
 * result is checked here because this is a public function, and a caller
 * that is not updateBaseline never reaches that function's exit check.
 */
export function timescaleStep(prev: Timescale, x: number, alpha: number, first: boolean): Timescale {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must lie in (0, 1), got ${alpha}`);
  if (!Number.isFinite(x)) throw new RangeError(`observation must be finite, got ${x}`);
  if (first) return { mean: x, m2: 0 };
  const delta = x - prev.mean;
  const mean = prev.mean + alpha * delta;
  const m2 = (1 - alpha) * (prev.m2 + alpha * delta * delta);
  if (!Number.isFinite(mean) || !Number.isFinite(m2)) {
    throw new RangeError(`timescale step from ${prev.mean} with ${x} does not fit a double`);
  }
  return { mean, m2 };
}

/**
 * How far the fast spread has departed from the slow one: the log of their
 * ratio, with the floor added to both so that a zero variance on either
 * side divides nothing and the value is always finite. Zero when they agree,
 * positive when the recent past is noisier than the reference, negative
 * when it is calmer.
 *
 * Only the two pairs are checked on the way in, by the same predicate the
 * baseline's own check uses, so a negative variance is named as such rather
 * than surfacing as the NaN its square root would become. The rest of the
 * state, the count, the Welford pair and the robust pair, is not read here
 * and is not judged here. The floor is checked next, and the result last:
 * the smallest positive floor over the largest spread is a quotient that
 * underflows to zero, whose log is an infinity, and that is refused rather
 * than returned.
 *
 * Exposed and not acted on. Whether the divergence should itself gate a tag
 * is a claim about adversarial behaviour that nothing has measured yet, so
 * this package computes it and carries it out, and tag.test.ts holds that
 * no decision depends on it.
 */
export function timescaleDivergence(state: BaselineState, floor: number): number {
  assertTimescales(state);
  requireScaleFloor(floor);
  const fast = Math.sqrt(state.fastM2) + floor;
  const slow = Math.sqrt(state.slowM2) + floor;
  const divergence = Math.log(fast / slow);
  if (!Number.isFinite(divergence)) {
    throw new RangeError(`timescale divergence of ${state.channel}/${state.aspect} is not finite`);
  }
  return divergence;
}
