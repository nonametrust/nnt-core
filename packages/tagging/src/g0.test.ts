import { describe, it, expect } from "vitest";
import { CHANNELS } from "@nonametrust/schema";
import { CALIBRATION_V0, MEASURED_CHANNELS, channelWeight } from "./calibration.js";
import { POLICY_V0, assertPolicy } from "./policy.js";
import { calibrateG0, uncertaintyOf } from "./g0.js";

const policy = POLICY_V0;
const surprises = [0, 0.5, 1, 2, 3, 3.5, 5, 10, 100, 1e6, 1e300];

/** The exact message of a refusing call, so two refusals can be held equal. */
function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (e) {
    if (e instanceof RangeError) return e.message;
    throw e;
  }
  throw new Error("expected a RangeError and got none");
}

describe("uncertaintyOf", () => {
  it("is one before any observation and one half at the minimum count", () => {
    expect(uncertaintyOf(0, policy)).toBe(1);
    expect(uncertaintyOf(policy.minObservations, policy)).toBe(0.5);
  });

  it("falls as the count rises and never reaches zero", () => {
    let previous = uncertaintyOf(0, policy);
    for (const count of [1, 5, 10, 20, 100, 1000, 1e6]) {
      const u = uncertaintyOf(count, policy);
      expect(u).toBeLessThan(previous);
      expect(u).toBeGreaterThan(0);
      previous = u;
    }
  });

  it("refuses a count that is not a non-negative integer", () => {
    expect(() => uncertaintyOf(-1, policy)).toThrow(RangeError);
    expect(() => uncertaintyOf(1.5, policy)).toThrow(RangeError);
    expect(() => uncertaintyOf(Number.NaN, policy)).toThrow(RangeError);
  });
});

describe("calibrateG0", () => {
  it("is bounded by the weight for any finite surprise, and never leaves [0, 1]", () => {
    for (const w of [0.05, 0.6227, 0.9674, 1]) {
      for (const u of [0, 0.25, 0.5, 0.9]) {
        for (const z of [...surprises, ...surprises.map((s) => -s)]) {
          const g0 = calibrateG0(z, u, w, policy);
          expect(Number.isFinite(g0)).toBe(true);
          expect(g0).toBeGreaterThanOrEqual(0);
          expect(g0).toBeLessThanOrEqual(w);
          expect(g0).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("is monotone in the magnitude of the surprise, strictly on the range the double resolves", () => {
    let previous = -1;
    for (const z of surprises) {
      const g0 = calibrateG0(z, 0.2, 0.9, policy);
      expect(g0).toBeGreaterThanOrEqual(previous);
      previous = g0;
    }
    expect(calibrateG0(3.5, 0.2, 0.9, policy)).toBeGreaterThan(calibrateG0(3, 0.2, 0.9, policy));
    expect(calibrateG0(10, 0.2, 0.9, policy)).toBeGreaterThan(calibrateG0(5, 0.2, 0.9, policy));
  });

  it("reads the magnitude, so a deviation below the location scores like one above it", () => {
    expect(calibrateG0(-4, 0.2, 0.9, policy)).toBe(calibrateG0(4, 0.2, 0.9, policy));
  });

  // The same deviation scores more cautiously for a counterparty with
  // little history, and the ordering is strict: less history never scores
  // higher.
  it("is strictly decreasing in uncertainty", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      const g0 = calibrateG0(4, u, 0.9, policy);
      expect(g0).toBeLessThan(previous);
      previous = g0;
    }
  });

  it("scores the same surprise lower at ten observations than at a hundred", () => {
    const young = calibrateG0(4, uncertaintyOf(10, policy), 0.9674, policy);
    const old = calibrateG0(4, uncertaintyOf(100, policy), 0.9674, policy);
    expect(young).toBeLessThan(old);
  });

  it("scales with the channel weight, and so with the study's precision", () => {
    const strong = calibrateG0(4, 0.2, channelWeight("volume", CALIBRATION_V0, policy), policy);
    const broad = calibrateG0(4, 0.2, channelWeight("protocol", CALIBRATION_V0, policy), policy);
    expect(strong).toBeGreaterThan(broad);
    for (const c of MEASURED_CHANNELS) {
      const w = channelWeight(c, CALIBRATION_V0, policy);
      expect(calibrateG0(1e6, 0, w, policy)).toBeCloseTo(w, 12);
    }
  });

  it("is zero at zero surprise, so no deviation earns nothing", () => {
    expect(calibrateG0(0, 0.2, 0.9, policy)).toBe(0);
  });

  it("gives the worked number: weight 0.9674, twenty observations, a surprise of four", () => {
    // (1 − 1/3) × (1 − e^(−4/3)) × 0.9674 = 0.4749…
    expect(calibrateG0(4, uncertaintyOf(20, policy), 0.9674, policy)).toBeCloseTo(0.4749, 3);
  });

  it("refuses a non-finite surprise, an uncertainty outside [0, 1] and a weight outside (0, 1]", () => {
    expect(() => calibrateG0(Number.NaN, 0.2, 0.9, policy)).toThrow(RangeError);
    expect(() => calibrateG0(Number.POSITIVE_INFINITY, 0.2, 0.9, policy)).toThrow(RangeError);
    expect(() => calibrateG0(4, -0.1, 0.9, policy)).toThrow(RangeError);
    expect(() => calibrateG0(4, 1.1, 0.9, policy)).toThrow(RangeError);
    expect(() => calibrateG0(4, 0.2, 0, policy)).toThrow(RangeError);
    expect(() => calibrateG0(4, 0.2, 1.5, policy)).toThrow(RangeError);
  });
});

// What the brief's tests leave open, found by mutating the implementation
// under them: every literal the shipped policy collides with, every refusal
// asserted by class alone, and the two policy fields this module reads.
describe("uncertaintyOf, beyond the brief", () => {
  // Under the shipped policy a literal 10 in either position is invisible.
  // With a pseudo-count of four the three values are exact in binary, so
  // toBe rather than toBeCloseTo.
  it("reads the pseudo-count from the policy's own field, and not from a literal", () => {
    const small = { ...policy, minObservations: 4 };
    expect(uncertaintyOf(0, small)).toBe(1);
    expect(uncertaintyOf(4, small)).toBe(0.5);
    expect(uncertaintyOf(12, small)).toBe(0.25);
    expect(uncertaintyOf(10, small)).not.toBe(uncertaintyOf(10, policy));
  });

  it("refuses a negative, fractional, NaN or unsafe count under the count's own message", () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => uncertaintyOf(count, policy)).toThrow(`count must be a non-negative integer, got ${count}`);
    }
  });

  // A zero pseudo-count divides zero by zero at count zero. It is refused
  // here under the wording assertPolicy gives it, held equal case by case,
  // so the refusal reads the same whichever side notices first.
  it("refuses a policy whose minimum count is not a positive integer, under assertPolicy's own message", () => {
    for (const minObservations of [0, -1, 2.5, Number.NaN]) {
      const broken = { ...policy, minObservations };
      const message = refusalOf(() => assertPolicy(broken));
      expect(message).toBe(`policy.minObservations must be a positive integer, got ${minObservations}`);
      expect(() => uncertaintyOf(0, broken)).toThrow(message);
      expect(() => uncertaintyOf(20, broken)).toThrow(message);
    }
  });
});

describe("calibrateG0, beyond the brief", () => {
  // In the shipped policy surpriseScale, thresholdBase and winsorMadMultiple
  // are all 3, so a read from the wrong field, or a literal 3, passes every
  // test that uses POLICY_V0. Only the scale moves here; the other two stay
  // at 3, and a surprise of three reaches 1 − e^(−3) only if the scale is
  // the field that was changed.
  it("reads the scale from the policy's own field, and not from a literal or a neighbour", () => {
    const sharp = { ...policy, surpriseScale: 1 };
    expect(sharp.thresholdBase).toBe(3);
    expect(sharp.winsorMadMultiple).toBe(3);
    expect(calibrateG0(3, 0, 1, sharp)).toBeCloseTo(1 - Math.exp(-3), 12);
    expect(calibrateG0(3, 0, 1, policy)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(calibrateG0(3, 0, 1, sharp)).toBeGreaterThan(calibrateG0(3, 0, 1, policy));
  });

  // The closed end of the uncertainty interval: a counterparty with no
  // history at all is admitted and scores exactly nothing, rather than being
  // refused. The brief's tests stop at 0.99.
  it("admits an uncertainty of one and scores it zero", () => {
    expect(calibrateG0(4, 1, 0.9, policy)).toBe(0);
    expect(calibrateG0(1e300, 1, 1, policy)).toBe(0);
  });

  it("names the cause of each refusal", () => {
    expect(() => calibrateG0(Number.NaN, 0.2, 0.9, policy)).toThrow("surprise must be finite, got NaN");
    expect(() => calibrateG0(Number.NEGATIVE_INFINITY, 0.2, 0.9, policy)).toThrow("surprise must be finite, got -Infinity");
    expect(() => calibrateG0(4, -0.1, 0.9, policy)).toThrow("uncertainty must lie in [0, 1], got -0.1");
    expect(() => calibrateG0(4, 1.1, 0.9, policy)).toThrow("uncertainty must lie in [0, 1], got 1.1");
    expect(() => calibrateG0(4, Number.NaN, 0.9, policy)).toThrow("uncertainty must lie in [0, 1], got NaN");
    expect(() => calibrateG0(4, 0.2, 0, policy)).toThrow("weight must lie in (0, 1], got 0");
    expect(() => calibrateG0(4, 0.2, 1.5, policy)).toThrow("weight must lie in (0, 1], got 1.5");
    expect(() => calibrateG0(4, 0.2, Number.NaN, policy)).toThrow("weight must lie in (0, 1], got NaN");
  });

  // A zero scale divides zero by zero at surprise zero and gives a NaN; an
  // infinite one scores every surprise zero. Both are refused under the
  // wording assertPolicy gives the field, held equal case by case.
  it("refuses a policy whose scale is not positive and finite, under assertPolicy's own message", () => {
    for (const surpriseScale of [0, -3, Number.POSITIVE_INFINITY, Number.NaN]) {
      const broken = { ...policy, surpriseScale };
      const message = refusalOf(() => assertPolicy(broken));
      expect(message).toBe(`policy.surpriseScale must be a positive finite number, got ${surpriseScale}`);
      expect(() => calibrateG0(0, 0.2, 0.9, broken)).toThrow(message);
      expect(() => calibrateG0(4, 0.2, 0.9, broken)).toThrow(message);
    }
  });
});

// Every channel, not one, through the weight and into g0. The dispatch that
// picks a measured channel's weight from the calibration and an unmeasured
// one's from the policy is exercised on all seven here, and the complement
// of the measured set is held closed.
describe("g0 across the channels", () => {
  const score = (channel: (typeof CHANNELS)[number]) =>
    calibrateG0(4, uncertaintyOf(20, policy), channelWeight(channel, CALIBRATION_V0, policy), policy);

  it("scores every measured channel at its own calibrated weight, and volume highest", () => {
    const confidence = 1 - uncertaintyOf(20, policy);
    const evidence = 1 - Math.exp(-4 / policy.surpriseScale);
    for (const c of MEASURED_CHANNELS) {
      expect(score(c), c).toBeCloseTo(CALIBRATION_V0.channelWeights[c].weight * confidence * evidence, 12);
    }
    for (const c of CHANNELS) expect(score(c), c).toBeLessThanOrEqual(score("volume"));
  });

  it("leaves exactly latency and price to the policy's weight", () => {
    const unmeasured = CHANNELS.filter((c) => !(MEASURED_CHANNELS as readonly string[]).includes(c));
    expect([...unmeasured].sort()).toEqual(["latency", "price"]);
    for (const c of unmeasured) {
      expect(score(c), c).toBe(calibrateG0(4, uncertaintyOf(20, policy), policy.unmeasuredChannelWeight, policy));
    }
  });

  // The number does not carry its provenance. The policy's unmeasured
  // weight is the weakest measured weight by construction, so latency and
  // content score bit for bit the same g0 from the same surprise, one under
  // an uncalibrated number and one under a measured one. A reader who has
  // only g0 cannot tell them apart; the channel on the decision, read
  // against MEASURED_CHANNELS, is what does.
  it("scores an unmeasured channel identically to the weakest measured one, so g0 alone does not say which", () => {
    expect(policy.unmeasuredChannelWeight).toBe(CALIBRATION_V0.channelWeights.content.weight);
    expect(score("latency")).toBe(score("content"));
    expect(score("price")).toBe(score("content"));
  });
});
