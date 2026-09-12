import { describe, it, expect } from "vitest";
import { emptyBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { POLICY_V0 } from "./policy.js";
import { timescaleDivergence, timescaleStep } from "./timescales.js";

const ns = "11111111-1111-4111-8111-111111111111";
const policy = POLICY_V0;
const scale = 2;
const floor = 0.05;

function fed(state: BaselineState, values: number[]): BaselineState {
  return values.reduce((s, v) => updateBaseline(s, v, scale, policy), state);
}

const steady = fed(emptyBaseline(ns, "volume", "amount/USDC/in"), Array(20).fill(100));

describe("timescaleStep", () => {
  it("seeds the pair from the first observation", () => {
    expect(timescaleStep({ mean: 0, m2: 0 }, 42, 0.2, true)).toEqual({ mean: 42, m2: 0 });
  });

  // Seeding from a pair that was not at rest: whatever the pair held is
  // discarded, not blended. A seed that kept the old variance, or moved the
  // old mean by alpha, would pass the case above where both are zero.
  it("seeds from the first observation whatever the pair held before", () => {
    expect(timescaleStep({ mean: 5, m2: 3 }, 42, 0.2, true)).toEqual({ mean: 42, m2: 0 });
  });

  it("moves the mean by alpha times the deviation and the variance by the weighted square", () => {
    // From (100, 0) with an observation of 106 at alpha 0.2: the mean moves
    // to 101.2 and the variance to 0.8 × 0.2 × 36.
    const next = timescaleStep({ mean: 100, m2: 0 }, 106, 0.2, false);
    expect(next.mean).toBeCloseTo(101.2, 12);
    expect(next.m2).toBeCloseTo(5.76, 12);
  });

  // The variance carries the previous value forward under the same weight,
  // so a step with no deviation decays it and does not zero it. From
  // (100, 10) with an observation of 100 at alpha 0.2 the variance is 8.
  it("decays the variance by one minus alpha on a step with no deviation", () => {
    const next = timescaleStep({ mean: 100, m2: 10 }, 100, 0.2, false);
    expect(next.mean).toBe(100);
    expect(next.m2).toBeCloseTo(8, 12);
  });

  it("refuses an alpha outside (0, 1) and a non-finite observation", () => {
    expect(() => timescaleStep({ mean: 0, m2: 0 }, 1, 0, false)).toThrow(RangeError);
    expect(() => timescaleStep({ mean: 0, m2: 0 }, 1, 1, false)).toThrow(RangeError);
    expect(() => timescaleStep({ mean: 0, m2: 0 }, Number.NaN, 0.2, false)).toThrow(RangeError);
  });

  // The class alone proves little: an alpha of zero or one produces a finite
  // pair, so the test above does hold the alpha guard, but a NaN observation
  // would also be refused by the finiteness check on the result, under a
  // message naming the wrong cause. Each refusal is held on its own message.
  it.each([
    ["an alpha of zero", 1, 0],
    ["an alpha of one", 1, 1],
    ["a negative alpha", 1, -0.2],
    ["a NaN alpha", 1, Number.NaN],
  ])("refuses %s by name", (_what, x, alpha) => {
    expect(() => timescaleStep({ mean: 0, m2: 0 }, x, alpha, false)).toThrow(/alpha must lie in \(0, 1\)/);
  });

  it.each([
    ["a NaN observation", Number.NaN],
    ["an infinite observation", Number.POSITIVE_INFINITY],
  ])("refuses %s by name, on the seeding step too", (_what, x) => {
    expect(() => timescaleStep({ mean: 0, m2: 0 }, x, 0.2, false)).toThrow(/observation must be finite/);
    expect(() => timescaleStep({ mean: 0, m2: 0 }, x, 0.2, true)).toThrow(/observation must be finite/);
  });

  // Two finite operands whose difference does not fit a double. The step is
  // a public function, so the refusal lives here and not only in the exit
  // check of updateBaseline, which a direct caller never passes through.
  it("refuses a result that does not fit a double, even from finite operands", () => {
    expect(() => timescaleStep({ mean: -1e308, m2: 0 }, 1e308, 0.2, false)).toThrow(RangeError);
    expect(() => timescaleStep({ mean: -1e308, m2: 0 }, 1e308, 0.2, false)).toThrow(/does not fit a double/);
    expect(() => timescaleStep({ mean: 0, m2: 0 }, 1e160, 0.2, false)).toThrow(/does not fit a double/);
  });
});

describe("the two pairs inside updateBaseline", () => {
  it("are seeded together by the first observation", () => {
    const s = updateBaseline(emptyBaseline(ns, "volume", "amount/USDC/in"), 7, scale, policy);
    expect(s).toMatchObject({ fastMean: 7, fastM2: 0, slowMean: 7, slowM2: 0 });
  });

  it("move the fast pair further than the slow one on the same run", () => {
    const s = fed(steady, [106, 106, 106]);
    expect(s.fastMean - 100).toBeGreaterThan(s.slowMean - 100);
    expect(s.fastM2).toBeGreaterThan(s.slowM2);
  });

  // The pairs see the clipped value, like every other estimator. With a
  // band of ±6 around 100 and alpha 0.2 the fast mean moves by exactly 1.2
  // however large the observation is.
  it("read the clipped value, so a huge observation moves the fast mean by alpha times the band", () => {
    const s = updateBaseline(steady, 1e12, scale, policy);
    expect(s.fastMean).toBeCloseTo(101.2, 12);
    expect(s.slowMean).toBeCloseTo(100.12, 12);
  });

  // Every other test runs the shipped policy, whose alphas are 0.2 and 0.02.
  // The test above tells the fast weight from the slow one, but a step
  // reading the literal 0.2 where the policy's field belongs would pass it.
  // With the alphas overridden to 0.5 and 0.1 and one observation at the
  // band's edge, the fast pair is (103, 9) and the slow pair (100.6, 3.24);
  // under the shipped values or swapped they are something else.
  it("are moved under the policy's own two alphas, read from their fields and not from a literal", () => {
    const wide = { ...policy, fastAlpha: 0.5, slowAlpha: 0.1 };
    const s = updateBaseline(steady, 106, scale, wide);
    expect(s.fastMean).toBeCloseTo(103, 12);
    expect(s.fastM2).toBeCloseTo(9, 12);
    expect(s.slowMean).toBeCloseTo(100.6, 12);
    expect(s.slowM2).toBeCloseTo(3.24, 12);
  });

  // The step refuses its own overflow, and on the case baseline.test.ts uses
  // for the exit check, a deviation of 3e154, it does so first, since
  // 0.2 × 3e154 × 3e154 is already past the largest double. That left the
  // exit check of updateBaseline pinned by nothing, and the sweep showed it.
  // At a count of one Welford's increment is d² / 2 and the fast step's is
  // at most 0.16 × d², so a deviation of 2.5e154 inside a band of 3e154
  // overflows m2 and neither pair, and only the exit check refuses it.
  it("still refuse a non-finite state on exit, on a case the steps themselves admit", () => {
    const s = updateBaseline(emptyBaseline(ns, "volume", "amount/USDC/in"), 0, 1e154, policy);
    expect(() => timescaleStep({ mean: 0, m2: 0 }, 2.5e154, policy.fastAlpha, false)).not.toThrow();
    expect(() => updateBaseline(s, 2.5e154, 1e154, policy)).toThrow(/baseline m2 must be finite/);
  });

  // The band is centred on the location, which is the mean, so the clipped
  // value is the mean plus the half-width of 6 and the Welford mean moves by
  // 6 / (n + 1), exactly as before the pairs were wired in.
  it("leave the Welford and robust estimators exactly where they were going", () => {
    const before = fed(steady, [103, 97, 105]);
    const next = updateBaseline(before, 1e6, scale, policy);
    expect(next.count).toBe(before.count + 1);
    expect(next.mean).toBeCloseTo(before.mean + 6 / next.count, 12);
    expect(next.medianEst).toBe(next.mean);
  });
});

describe("timescaleDivergence", () => {
  it("is zero on a stream with no spread, since both variances are zero", () => {
    expect(timescaleDivergence(steady, floor)).toBe(0);
  });

  // The adversary's move is to inflate the variance so that a later
  // deviation reads as ordinary. Clipping bounds each step, so the burst
  // can only push the fast variance up in bounded steps; the slow variance
  // lags, and the ratio between them is the burst made visible.
  it("goes positive during a burst of inflated variance", () => {
    const burst = fed(steady, [106, 94, 106, 94, 106]);
    expect(burst.fastM2).toBeGreaterThan(burst.slowM2);
    expect(timescaleDivergence(burst, floor)).toBeGreaterThan(0);
  });

  it("goes negative once a long calm follows the burst, since the fast pair forgets first", () => {
    const calm = fed(fed(steady, [106, 94, 106, 94, 106]), Array(100).fill(100));
    expect(timescaleDivergence(calm, floor)).toBeLessThan(0);
  });

  it("is finite at zero spread, because the floor is added to both sides", () => {
    expect(Number.isFinite(timescaleDivergence(steady, floor))).toBe(true);
    expect(Number.isFinite(timescaleDivergence(emptyBaseline(ns, "volume", "x"), floor))).toBe(true);
  });

  it("refuses a floor that is not positive", () => {
    expect(() => timescaleDivergence(steady, 0)).toThrow(RangeError);
  });

  it("is a pure function of the state", () => {
    const burst = fed(steady, [106, 94, 106]);
    expect(timescaleDivergence(burst, floor)).toBe(timescaleDivergence(burst, floor));
  });

  // The sign tests above are satisfied by any monotone reading of the two
  // variances, the log of their ratio without the square roots included, or
  // their plain difference. The value pins the form: spreads of 3 and 1,
  // each lifted by a floor of 1, give the log of 2, and swapped give its
  // negative.
  it("is the log of the ratio of the two spreads, each lifted by the floor", () => {
    expect(timescaleDivergence({ ...steady, fastM2: 9, slowM2: 1 }, 1)).toBeCloseTo(Math.log(2), 12);
    expect(timescaleDivergence({ ...steady, fastM2: 1, slowM2: 9 }, 1)).toBeCloseTo(-Math.log(2), 12);
  });

  // At zero spread a zero floor gives the log of 0/0, which the finiteness
  // check at the end refuses on its own, so the class alone would be green
  // with the floor guard deleted. Held on the message.
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["infinite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("refuses a floor that is %s by name", (_what, bad) => {
    expect(() => timescaleDivergence(steady, bad)).toThrow(/scale floor must be positive and finite/);
  });

  // A negative variance would give a NaN square root and be refused at the
  // end under the divergence's own message; the state is checked first, so
  // the refusal names the cause the baseline's own checks name.
  it("refuses what assertBaseline refuses, naming the same cause", () => {
    expect(() => timescaleDivergence({ ...steady, fastM2: -1 }, floor)).toThrow(/baseline fastM2 must be non-negative/);
    expect(() => timescaleDivergence({ ...steady, slowM2: Number.NaN }, floor)).toThrow(/baseline slowM2 must be finite/);
    expect(() => timescaleDivergence({ ...steady, medianEst: 200 }, floor)).toThrow(/apart from mean/);
  });

  // Both sides finite and positive, and the quotient still not: the smallest
  // positive double over the largest spread underflows to zero, whose log is
  // an infinity. Refused rather than returned.
  it("refuses a ratio that underflows to nothing rather than returning an infinity", () => {
    const wide = { ...steady, slowM2: Number.MAX_VALUE };
    expect(() => timescaleDivergence(wide, Number.MIN_VALUE)).toThrow(/timescale divergence of volume\/amount\/USDC\/in is not finite/);
  });
});
