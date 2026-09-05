import type { StoredTag } from "./repositories/tag.js";

/**
 * A tag's strength at an instant, derived and never stored.
 *
 * Deriving rather than storing has two consequences the design depends on.
 * The nightly job becomes the only writer, so a determinism test over a fixed
 * corpus is meaningful. And any historical strength is reproducible from the
 * audit log, because nothing was overwritten to produce today's number.
 *
 * Suppression multiplies elapsed time rather than subtracting from g0, so a
 * suppressed tag decays faster and never reaches zero. That is what makes
 * suppression accelerated decay rather than deletion.
 *
 * Before `taggedAt` the strength is g0: a tag has no history before it
 * existed, and returning something larger would let a clock skew invent
 * evidence.
 *
 * The half-life is an argument and not a column because it is a calibration
 * input that M2 owns; storing it here would freeze a number this milestone
 * has no basis for.
 *
 * A double underflows to exactly zero once the exponent passes about 1074,
 * which is 1074 half-lives of suppressed time. That is not clamped away: a
 * positive floor would be a number that is not a function of the stored tag,
 * and the row is still there and still read at every call either way.
 * strength.test.ts pins the boundary.
 */
export function strengthAt(tag: StoredTag, instant: Date, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) throw new RangeError("halfLifeMs must be positive");
  const elapsed = instant.getTime() - tag.taggedAt.getTime();
  if (elapsed <= 0) return tag.g0;
  return tag.g0 * Math.pow(0.5, (elapsed * tag.suppressionFactor) / halfLifeMs);
}
