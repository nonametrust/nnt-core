import { describe, it, expect } from "vitest";
import { POLICY_V0 } from "./policy.js";
import { assertBaseline, emptyBaseline, updateBaseline, winsorize, type BaselineState } from "./baseline.js";

const ns = "11111111-1111-4111-8111-111111111111";
const policy = POLICY_V0;

/** A baseline that has seen `values`, each at the given scale. */
function warmed(values: number[], scale: number): BaselineState {
  return values.reduce((s, v) => updateBaseline(s, v, scale, policy), emptyBaseline(ns, "volume", "amount/USDC/in"));
}

describe("emptyBaseline", () => {
  it("has m2 zero at n zero, and the robust pair null together", () => {
    const s = emptyBaseline(ns, "volume", "amount/USDC/in");
    expect(s).toEqual({
      namespaceId: ns, channel: "volume", aspect: "amount/USDC/in",
      count: 0, mean: 0, m2: 0, medianEst: null, madEst: null,
      fastMean: 0, fastM2: 0, slowMean: 0, slowM2: 0,
    });
  });
});

describe("Welford", () => {
  it("reproduces the textbook mean and sum of squared deviations", () => {
    const s = warmed([1, 2, 3, 4], 1e9);
    expect(s.count).toBe(4);
    expect(s.mean).toBeCloseTo(2.5, 12);
    expect(s.m2).toBeCloseTo(5, 12);
  });

  it("has m2 zero after one observation, since one deviation from itself is zero", () => {
    expect(warmed([7], 1).m2).toBe(0);
  });

  it("does not mutate the state it was given", () => {
    const before = warmed([1, 2], 1);
    const frozen = { ...before };
    updateBaseline(before, 3, 1, policy);
    expect(before).toEqual(frozen);
  });
});

describe("the robust pair", () => {
  it("arrives together at the first observation", () => {
    const s = warmed([5], 1);
    expect(s.medianEst).toBe(5);
    expect(s.madEst).toBe(0);
  });

  it("holds a location near the centre and a spread near the typical deviation", () => {
    const s = warmed([10, 12, 8, 11, 9, 10, 12, 8, 11, 9], 1);
    expect(s.medianEst).toBeCloseTo(10, 6);
    expect(s.madEst).toBeGreaterThan(0.5);
    expect(s.madEst).toBeLessThan(2);
  });

  // The interval above admits a spread that is not averaged at all, and one
  // measured from the location after the update rather than before it. The
  // arithmetic written out on three values, with a band wide enough that
  // nothing is clipped, separates the three:
  //
  //   after 10:      location 10, spread 0
  //   after 14:      location 12, spread 0 + (|14 - 10| - 0) / 2 = 2
  //                  (from the new location it would be |14 - 12| / 2 = 1;
  //                   unaveraged it would be 4)
  //   after 6:       location 10, spread 2 + (|6 - 12| - 2) / 3 = 10 / 3
  //                  (from the new location, 2 + (|6 - 10| - 2) / 3 = 8 / 3)
  it("is the running mean of absolute deviations from the location before the update", () => {
    expect(warmed([10, 14], 100).madEst).toBe(2);
    expect(warmed([10, 14, 6], 100).madEst).toBeCloseTo(10 / 3, 12);
  });

  it("refuses a state carrying one estimate and not the other", () => {
    const s = warmed([1, 2], 1);
    expect(() => assertBaseline({ ...s, madEst: null })).toThrow(RangeError);
    expect(() => assertBaseline({ ...s, medianEst: null })).toThrow(RangeError);
    expect(() => updateBaseline({ ...s, madEst: null }, 3, 1, policy)).toThrow(RangeError);
  });
});

describe("assertBaseline", () => {
  const s = warmed([1, 2], 1);

  it.each([
    ["a negative count", { count: -1 }],
    ["a fractional count", { count: 1.5 }],
    ["a count past the safe integers", { count: 2 ** 53 }],
    ["a location with no observations behind it", { count: 0 }],
  ])("refuses %s", (_what, patch) => {
    expect(() => assertBaseline({ ...s, ...patch })).toThrow(RangeError);
  });

  // Every float column of the baseline table is held finite and the two
  // sums of deviations non-negative; a state that breaks either could not
  // have come out of this arithmetic and would poison every update after
  // it, since NaN plus anything is NaN.
  it.each([
    ["a NaN mean", { mean: Number.NaN }],
    ["an infinite m2", { m2: Number.POSITIVE_INFINITY }],
    ["a negative m2", { m2: -1 }],
    ["an infinite location", { medianEst: Number.NEGATIVE_INFINITY }],
    ["a negative spread", { madEst: -0.5 }],
    ["a NaN fast mean", { fastMean: Number.NaN }],
    ["a NaN fast m2", { fastM2: Number.NaN }],
    ["a NaN slow mean", { slowMean: Number.NaN }],
    ["a NaN slow m2", { slowM2: Number.NaN }],
  ])("refuses %s", (_what, patch) => {
    expect(() => assertBaseline({ ...s, ...patch })).toThrow(RangeError);
  });

  // The pair arrives at the first observation, so this row was not written
  // by the arithmetic. Admitted, it would be updated with no location to
  // clip against: five observations at a mean of a hundred, then a million,
  // moved the mean by over a hundred and sixty thousand against a bound of
  // half a unit. M3 will hand this package rows it did not write.
  it("refuses a positive count with no robust pair, on entry to an update too", () => {
    const s = { ...warmed([100, 100, 100, 100, 100], 1), medianEst: null, madEst: null };
    expect(() => assertBaseline(s)).toThrow(RangeError);
    expect(() => updateBaseline(s, 1e6, 1, policy)).toThrow(RangeError);
  });

  it("accepts every state the arithmetic produces along a history", () => {
    let state = emptyBaseline(ns, "volume", "amount/USDC/in");
    expect(() => assertBaseline(state)).not.toThrow();
    for (const v of [3, -7, 1e6, 0, 2.5]) {
      state = updateBaseline(state, v, 1, policy);
      expect(() => assertBaseline(state)).not.toThrow();
    }
  });
});

describe("winsorize", () => {
  it("leaves a value inside the band alone", () => {
    expect(winsorize(103, 100, { multiple: 3, scale: 2 })).toBe(103);
  });

  it("clips to the band's edge on both sides", () => {
    expect(winsorize(1e6, 100, { multiple: 3, scale: 2 })).toBe(106);
    expect(winsorize(-1e6, 100, { multiple: 3, scale: 2 })).toBe(94);
  });

  it("clips nothing when there is no location yet, since there is nothing to clip against", () => {
    expect(winsorize(1e6, null, { multiple: 3, scale: 2 })).toBe(1e6);
  });

  it("refuses a scale that is not positive, and a value that is not finite", () => {
    expect(() => winsorize(1, 0, { multiple: 3, scale: 0 })).toThrow(RangeError);
    expect(() => winsorize(1, 0, { multiple: 3, scale: Number.NaN })).toThrow(RangeError);
    expect(() => winsorize(Number.POSITIVE_INFINITY, 0, { multiple: 3, scale: 1 })).toThrow(RangeError);
  });

  // A NaN observation is the case a guard written as `x === Infinity`
  // would let through: Math.max and Math.min of NaN are NaN, so it would
  // come back as NaN without a word.
  it("refuses a NaN observation, and a NaN location", () => {
    expect(() => winsorize(Number.NaN, 0, { multiple: 3, scale: 1 })).toThrow(RangeError);
    expect(() => winsorize(1, Number.NaN, { multiple: 3, scale: 1 })).toThrow(RangeError);
  });

  it("refuses a multiple that is not positive and finite, since the band would have no width or no edge", () => {
    expect(() => winsorize(1, 0, { multiple: 0, scale: 1 })).toThrow(RangeError);
    expect(() => winsorize(1, 0, { multiple: -3, scale: 1 })).toThrow(RangeError);
    expect(() => winsorize(1, 0, { multiple: Number.POSITIVE_INFINITY, scale: 1 })).toThrow(RangeError);
  });

  // Each factor finite, their product not: the band would have no edge and
  // the bound on every estimate would be infinite, which is no bound.
  it("refuses a band whose half-width overflows, so the bound is finite whenever a value comes back", () => {
    expect(() => winsorize(1, 0, { multiple: 3, scale: 1e308 })).toThrow(RangeError);
    expect(winsorize(1, 0, { multiple: 3, scale: 1e307 })).toBe(1);
  });
});

describe("clip, then update", () => {
  // Twenty observations at 100, location 100. With multiple 3 and scale 2
  // the band is [94, 106]. An observation of 106.5 sits just outside it.
  //
  // Clip first, then update: the value that enters is 106 and the mean
  // moves by 6/21.
  //
  // Update first, then clip: the location would already have moved to
  // 100 + 6.5/21, the band to [94.31, 106.31], the value would sit inside
  // it, and the mean would move by 6.5/21. The two orders give different
  // numbers, and this test pins the first, so a later reordering fails here
  // rather than moving every baseline a little on every outlier.
  it("computes the band from the location before the update, not after", () => {
    const s = warmed(Array(20).fill(100), 2);
    const next = updateBaseline(s, 106.5, 2, policy);
    expect(next.mean).toBeCloseTo(100 + 6 / 21, 12);
    expect(next.mean).not.toBeCloseTo(100 + 6.5 / 21, 12);
    expect(next.medianEst).toBeCloseTo(100 + 6 / 21, 12);
  });

  it("feeds the clipped value to every estimator, so the raw value reaches none of them", () => {
    const s = warmed(Array(20).fill(100), 2);
    const viaRaw = updateBaseline(s, 1e6, 2, policy);
    const viaClipped = updateBaseline(s, winsorize(1e6, s.medianEst, { multiple: 3, scale: 2 }), 2, policy);
    expect(viaRaw).toEqual(viaClipped);
  });
});

// Acceptance criterion 3. The bound is multiple × scale / (n + 1) on every
// estimate, and it holds for any value, of either sign, up to the largest
// double.
describe("one extreme observation cannot move a baseline past its bound", () => {
  const scale = 2;
  const s = warmed(Array(20).fill(100), scale);
  const bound = policy.winsorMadMultiple * scale / (s.count + 1);

  for (const extreme of [1e6, -1e6, 1e300, -1e300, Number.MAX_VALUE]) {
    it(`holds for ${extreme}`, () => {
      const next = updateBaseline(s, extreme, scale, policy);
      expect(Math.abs(next.mean - s.mean)).toBeLessThanOrEqual(bound + 1e-12);
      expect(Math.abs(next.medianEst! - s.medianEst!)).toBeLessThanOrEqual(bound + 1e-12);
      expect(Math.abs(next.madEst! - s.madEst!)).toBeLessThanOrEqual(bound + 1e-12);
      expect(Number.isFinite(next.m2)).toBe(true);
      expect(next.m2).toBeGreaterThanOrEqual(0);
    });
  }

  it("is not a property of the raw arithmetic, which the same observation would move without bound", () => {
    // The Welford step on the raw value, written out: what the bound
    // protects against.
    const rawMean = s.mean + (1e6 - s.mean) / (s.count + 1);
    expect(Math.abs(rawMean - s.mean)).toBeGreaterThan(bound * 1000);
  });

  it("refuses a non-finite observation rather than admitting it", () => {
    expect(() => updateBaseline(s, Number.NaN, scale, policy)).toThrow(RangeError);
    expect(() => updateBaseline(s, Number.POSITIVE_INFINITY, scale, policy)).toThrow(RangeError);
  });
});

describe("the stored shape", () => {
  // The store's check constraints, restated: every float finite, m2 and the
  // spread non-negative, the count a non-negative safe integer. What the
  // arithmetic produces must satisfy them for every input the arithmetic
  // admits, because the database is the rule the next writer cannot go
  // around and not the thing that first notices.
  it("satisfies the baseline table's checks after any admitted update", () => {
    let s = emptyBaseline(ns, "latency", "latencyMs");
    const values = [1840, 12, 90000, 0, 5, 1e300, -1e300, 3, 3, 3];
    for (const v of values) {
      s = updateBaseline(s, v, 50, policy);
      expect(Number.isSafeInteger(s.count) && s.count >= 0).toBe(true);
      for (const f of [s.mean, s.m2, s.medianEst!, s.madEst!, s.fastMean, s.fastM2, s.slowMean, s.slowM2]) {
        expect(Number.isFinite(f)).toBe(true);
      }
      expect(s.m2).toBeGreaterThanOrEqual(0);
      expect(s.madEst!).toBeGreaterThanOrEqual(0);
    }
  });

  // Finite in does not guarantee finite out. With a band half-width of
  // 3e154 the clipped deviation is finite and admitted, and its square, which
  // is what m2 accumulates, is past the largest double. The update refuses
  // the result rather than handing the store an infinity it would reject,
  // or a NaN the next update would carry forever.
  it("refuses to produce a non-finite state, even from finite inputs", () => {
    const s = warmed([0], 1e154);
    expect(() => updateBaseline(s, 1e300, 1e154, policy)).toThrow(RangeError);
  });
});

describe("the location is the mean", () => {
  // medianEst and mean are fed the same clipped value, start from the same
  // first value and move by the same recursion, so they are one number on
  // every row. That identity carries criterion 3 for mean: the band is
  // computed around medianEst and the Welford delta is measured from mean,
  // so mean is bounded only because the two coincide. A change that
  // separates them fails here, and must re-derive the bound for mean
  // before it passes.
  it("holds bit for bit along a history that clips", () => {
    let s = emptyBaseline(ns, "volume", "amount/USDC/in");
    for (const v of [100, 101, 99, 1e6, 100, -1e6, 102, 98, Number.MAX_VALUE, 100]) {
      s = updateBaseline(s, v, 1, policy);
      expect(s.medianEst).toBe(s.mean);
    }
  });
});

describe("the multiple is the policy's winsorMadMultiple", () => {
  // Every other test runs the shipped policy, in which winsorMadMultiple and
  // thresholdBase are both 3, so an update reading the wrong field, or the
  // literal, computes the same bound and passes them all. With the multiple
  // overridden to 1 the band is [98, 102] and the mean moves by 2/21; the
  // other readings still move it by 6/21.
  it("is read from that field and not from another number that happens to be three", () => {
    const narrow = { ...policy, winsorMadMultiple: 1 };
    const s = warmed(Array(20).fill(100), 2);
    const next = updateBaseline(s, 1e6, 2, narrow);
    expect(next.mean - s.mean).toBeCloseTo(2 / 21, 12);
    expect(next.mean - s.mean).not.toBeCloseTo(6 / 21, 12);
  });
});
