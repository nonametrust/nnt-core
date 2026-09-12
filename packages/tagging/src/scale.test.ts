import { describe, it, expect } from "vitest";
import { emptyBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { POLICY_V0, scaleFloorFor, type Policy } from "./policy.js";
import { robustScale, surpriseOf } from "./scale.js";

const ns = "11111111-1111-4111-8111-111111111111";

// The call throws this repository's refusal, and the refusal names the
// cause the test claims. Class alone proves less than it reads: the
// observation check and the deviation check in surpriseOf are each shadowed
// by a later check that refuses the same input for a different reason, and
// deleting either left the class-only test green.
function refuses(fn: () => unknown, cause: RegExp): void {
  expect(fn).toThrow(RangeError);
  expect(fn).toThrow(cause);
}

function withSpread(location: number, spread: number | null): BaselineState {
  return {
    ...emptyBaseline(ns, "volume", "amount/USDC/in"),
    count: spread === null ? 0 : 20,
    mean: location, medianEst: spread === null ? null : location, madEst: spread,
  };
}

describe("robustScale", () => {
  it("is the spread when the spread is above the floor", () => {
    expect(robustScale(withSpread(100, 2), 0.05)).toBe(2);
  });

  it("is the floor when the spread is below it, including at zero", () => {
    expect(robustScale(withSpread(100, 0), 0.05)).toBe(0.05);
    expect(robustScale(withSpread(100, 0.001), 0.05)).toBe(0.05);
  });

  it("is the floor before any observation, so the first observation is clipped against something", () => {
    expect(robustScale(withSpread(0, null), 0.05)).toBe(0.05);
  });

  it("refuses a floor that is not positive, since a zero floor is the zero-spread hole reopened", () => {
    expect(() => robustScale(withSpread(100, 0), 0)).toThrow(RangeError);
    expect(() => robustScale(withSpread(100, 0), -1)).toThrow(RangeError);
    expect(() => robustScale(withSpread(100, 0), Number.NaN)).toThrow(RangeError);
  });

  // An infinite floor passes the sign check and would make every scale
  // infinite, so every surprise zero: the hole reopened from the other side.
  it("refuses an infinite floor, which would make every surprise zero", () => {
    expect(() => robustScale(withSpread(100, 0), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  // A negative spread is below every floor, so max() would return the floor
  // and hide the corruption; a NaN spread would come out of max() as NaN.
  // Both are the baseline's own refusals, applied here before the arithmetic.
  it("refuses a state whose spread is negative or not a number", () => {
    expect(() => robustScale(withSpread(100, -1), 0.05)).toThrow(RangeError);
    expect(() => robustScale(withSpread(100, Number.NaN), 0.05)).toThrow(RangeError);
  });
});

describe("surpriseOf", () => {
  it("is the signed deviation in units of the scale", () => {
    expect(surpriseOf(106, withSpread(100, 2), 0.05)).toBeCloseTo(3, 12);
    expect(surpriseOf(94, withSpread(100, 2), 0.05)).toBeCloseTo(-3, 12);
  });

  it("is zero at the location", () => {
    expect(surpriseOf(100, withSpread(100, 2), 0.05)).toBe(0);
  });

  // The zero-spread case the M1 ledger carried: a robust z-score with zero
  // spread yields infinity or NaN from the same expression, and the store
  // refuses both. Infinity does not merely fail to rank; it destroys
  // magnitude, so two zero-spread triggers could not be ordered.
  it("is finite at zero spread, and larger for the larger deviation", () => {
    const flat = withSpread(100, 0);
    const small = surpriseOf(100.01, flat, 0.05);
    const large = surpriseOf(500, flat, 0.05);
    expect(Number.isFinite(small)).toBe(true);
    expect(Number.isFinite(large)).toBe(true);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeCloseTo(0.2, 12);
  });

  it("refuses to measure against a baseline with no location", () => {
    expect(() => surpriseOf(1, withSpread(0, null), 0.05)).toThrow(RangeError);
  });

  it("refuses a non-finite observation", () => {
    refuses(() => surpriseOf(Number.NaN, withSpread(100, 2), 0.05), /^observation must be finite/);
    refuses(() => surpriseOf(Number.POSITIVE_INFINITY, withSpread(100, 2), 0.05), /^observation must be finite/);
  });

  it("refuses rather than returns an overflow, so no infinity leaves this function", () => {
    // A deviation of 2e308 does not fit a double before it is divided.
    refuses(() => surpriseOf(Number.MAX_VALUE, withSpread(-Number.MAX_VALUE, 1), 1), /^deviation of /);
  });

  // The floor and state refusals belong to robustScale, and surpriseOf must
  // reach them through it: an inlined maximum of spread and floor would
  // return zero for every observation under an infinite floor, and a number
  // rather than a refusal against a corrupt state, with the terminal
  // quotient check still green. Each refusal is matched on its own cause, so
  // the test cannot pass on a later check firing for a different reason.
  it("refuses what robustScale refuses, naming the same cause", () => {
    refuses(() => surpriseOf(101, withSpread(100, 0), Number.POSITIVE_INFINITY), /^scale floor must be a positive finite number/);
    refuses(() => surpriseOf(101, withSpread(100, 0), 0), /^scale floor must be a positive finite number/);
    refuses(() => surpriseOf(101, withSpread(100, -1), 0.05), /^baseline madEst must be non-negative/);
    refuses(() => surpriseOf(101, { ...withSpread(100, 2), medianEst: 90 }, 0.05), /has location 90 apart from mean 100/);
  });

  // The other overflow: the deviation fits a double and the quotient does
  // not. The floor here is not one the policy declares; it is the smallest
  // positive one the arithmetic admits, chosen to reach the division.
  it("refuses a quotient that overflows even when the deviation did not", () => {
    refuses(() => surpriseOf(1e300, withSpread(0, 0), 1e-300), /^surprise of /);
  });
});

// Acceptance criterion 5, over a grid rather than a case: every spread
// including zero, every floor the policy declares, deviations from nothing
// to the largest the arithmetic admits, and a baseline warmed by the real
// update rather than built by hand.
describe("no surprise is ever infinite or NaN", () => {
  // Every floor the policy declares. A floor of 1e-300 against a deviation
  // of 1e300 overflows the double and is refused, which is the property the
  // overflow test above holds; the grid is about the floors that exist.
  const floors = [
    ...Object.values(POLICY_V0.scaleFloor.byChannel),
    ...Object.values(POLICY_V0.scaleFloor.byAspect),
  ];
  const spreads = [0, 1e-300, 1e-9, 0.05, 1, 1e6, 1e300];
  const deviations = [0, 1e-300, 1e-9, 1, 1e6, 1e300, -1e300];

  it("holds on the grid", () => {
    for (const floor of floors) {
      for (const spread of spreads) {
        for (const d of deviations) {
          const z = surpriseOf(100 + d, withSpread(100, spread), floor);
          expect(Number.isFinite(z), `floor ${floor} spread ${spread} deviation ${d}`).toBe(true);
        }
      }
    }
  });

  it("holds against a baseline that has only ever seen one value", () => {
    let s = emptyBaseline(ns, "volume", "amount/USDC/in");
    const floor = scaleFloorFor(POLICY_V0, "volume", "amount/USDC/in");
    for (let i = 0; i < 50; i++) s = updateBaseline(s, 0.25, robustScale(s, floor), POLICY_V0);
    expect(s.madEst).toBe(0);
    for (const x of [0.25, 0.26, 500, 1e300]) {
      expect(Number.isFinite(surpriseOf(x, s, floor))).toBe(true);
    }
    expect(surpriseOf(500, s, floor)).toBeCloseTo((500 - 0.25) / floor, 6);
  });

  // The same path under a policy whose floors are not the shipped ones. At
  // zero spread the surprise is the deviation over the floor and nothing
  // else, so this is where a floor read from the wrong field, or a floor
  // ignored in favour of a constant, shows: the shipped aspect floor and
  // channel floor are 0.05 and 1, and neither appears here.
  it("holds at zero spread under floors the shipped policy does not declare, and divides by the one the aspect names", () => {
    const policy: Policy = {
      ...POLICY_V0,
      scaleFloor: {
        byChannel: { ...POLICY_V0.scaleFloor.byChannel, volume: 7 },
        byAspect: { "volume/amount/USDC/in": 0.5 },
      },
    };
    for (const [aspect, expectedFloor] of [["amount/USDC/in", 0.5], ["amount/XLM/in", 7]] as const) {
      const floor = scaleFloorFor(policy, "volume", aspect);
      expect(floor).toBe(expectedFloor);
      let s = emptyBaseline(ns, "volume", aspect);
      for (let i = 0; i < 50; i++) s = updateBaseline(s, 0.25, robustScale(s, floor), policy);
      expect(s.madEst).toBe(0);
      expect(robustScale(s, floor)).toBe(expectedFloor);
      const z = surpriseOf(500, s, floor);
      expect(Number.isFinite(z)).toBe(true);
      expect(z).toBeCloseTo((500 - 0.25) / expectedFloor, 6);
      expect(z).not.toBeCloseTo((500 - 0.25) / 0.05, 6);
      expect(z).not.toBeCloseTo((500 - 0.25) / 1, 6);
    }
  });
});
