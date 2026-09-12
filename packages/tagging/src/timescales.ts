import { assertBaseline, type BaselineState } from "./baseline.js";

// baseline.ts calls timescaleStep and this module calls assertBaseline, so
// the two form a module cycle. It is safe because both sides bind function
// declarations and neither calls across the cycle while it is being
// evaluated, whichever module is entered first. Do not add a top-level
// constant here that calls into baseline.ts, because whichever module is
// evaluated first would see an uninitialised binding. The alternative,
// checking the two variances here by hand, would restate the baseline's own
// refusals and drift from them.

export interface Timescale {
  mean: number;
  m2: number;
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
 * The state is checked on the way in, by the baseline's own refusals, so a
 * negative variance is named as such rather than surfacing as the NaN its
 * square root would become. The floor is checked next, and the result last:
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
  assertBaseline(state);
  if (!(floor > 0) || !Number.isFinite(floor)) {
    throw new RangeError(`scale floor must be positive and finite, got ${floor}`);
  }
  const fast = Math.sqrt(state.fastM2) + floor;
  const slow = Math.sqrt(state.slowM2) + floor;
  const divergence = Math.log(fast / slow);
  if (!Number.isFinite(divergence)) {
    throw new RangeError(`timescale divergence of ${state.channel}/${state.aspect} is not finite`);
  }
  return divergence;
}
