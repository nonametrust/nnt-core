import { describe, it, expect } from "vitest";
import { emptyBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { POLICY_V0, assertPolicy, scaleFloorFor } from "./policy.js";
import { CONTINUOUS_CHANNELS, type ContinuousChannel } from "./reading.js";
import { robustScale, surpriseOf } from "./scale.js";
import { judgeSurprise, noiseOf, shrinkNoise, tagThreshold } from "./threshold.js";

const ns = "11111111-1111-4111-8111-111111111111";
const policy = POLICY_V0;
const floor = scaleFloorFor(policy, "volume", "amount/USDC/in");

/** A baseline built by the real update from `values`. */
function warmed(values: number[]): BaselineState {
  return values.reduce(
    (s, v) => updateBaseline(s, v, robustScale(s, floor), policy),
    emptyBaseline(ns, "volume", "amount/USDC/in"),
  );
}

/** A baseline written by hand, for a chosen count, location and spread. */
function shaped(count: number, location: number, spread: number): BaselineState {
  return { ...emptyBaseline(ns, "volume", "amount/USDC/in"), count, mean: location, medianEst: location, madEst: spread };
}

// Acceptance criterion 1. Below the minimum count the verdict is cold for
// any value at all, against a baseline the real update built and against
// no baseline. The categorical channels are not judged here and never
// reach this function; their independence from the count is Task 9's.
describe("no tag is produced below the minimum observation count", () => {
  it("is cold from zero up to one short of the minimum, whatever the observation", () => {
    let s = emptyBaseline(ns, "volume", "amount/USDC/in");
    for (let n = 0; n < policy.minObservations; n++) {
      for (const value of [0.25, 500, 1e12, -1e12]) {
        const verdict = judgeSurprise(value, n === 0 ? null : s, "volume", floor, policy);
        expect(verdict, `count ${n} value ${value}`).toEqual({ kind: "cold", count: n, minObservations: policy.minObservations });
      }
      s = updateBaseline(s, 0.25, robustScale(s, floor), policy);
    }
    expect(s.count).toBe(policy.minObservations);
  });

  it("is measured at exactly the minimum", () => {
    const s = warmed(Array(policy.minObservations).fill(0.25));
    const verdict = judgeSurprise(500, s, "volume", floor, policy);
    expect(verdict.kind).toBe("measured");
    if (verdict.kind === "measured") expect(verdict.crosses).toBe(true);
  });

  it("is cold for a null baseline, which is every counterparty nobody has seen", () => {
    expect(judgeSurprise(1e12, null, "volume", floor, policy)).toEqual({
      kind: "cold", count: 0, minObservations: policy.minObservations,
    });
  });
});

describe("tagThreshold", () => {
  it("is the base at zero noise and rises with noise", () => {
    expect(tagThreshold(0, policy)).toBe(policy.thresholdBase);
    let previous = tagThreshold(0, policy);
    for (const noise of [0.01, 0.1, 0.5, 1, 5]) {
      const t = tagThreshold(noise, policy);
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
  });

  it("refuses a negative or non-finite noise", () => {
    expect(() => tagThreshold(-0.1, policy)).toThrow(RangeError);
    expect(() => tagThreshold(Number.NaN, policy)).toThrow(RangeError);
  });
});

describe("noiseOf", () => {
  it("is the scale over the location, so it is the same number in any unit", () => {
    expect(noiseOf(shaped(40, 100, 5), 0.05)).toBeCloseTo(5 / 100.05, 12);
    expect(noiseOf(shaped(40, 1000, 50), 0.5)).toBeCloseTo(50 / 1000.5, 12);
  });

  it("is finite at a location of zero and at a spread of zero", () => {
    expect(Number.isFinite(noiseOf(shaped(40, 0, 0), 0.05))).toBe(true);
    expect(noiseOf(shaped(40, 0, 0), 0.05)).toBe(1);
  });

  it("refuses a baseline with no location", () => {
    expect(() => noiseOf(emptyBaseline(ns, "volume", "x"), 0.05)).toThrow(RangeError);
  });
});

describe("the fleet prior", () => {
  it("is the midpoint at exactly the minimum count", () => {
    expect(shrinkNoise(0.1, policy.minObservations, 0.5, policy)).toBeCloseTo(0.3, 12);
  });

  it("fades as history accumulates", () => {
    const observed = 0.1;
    const prior = 0.5;
    let previous = shrinkNoise(observed, policy.minObservations, prior, policy);
    for (const count of [20, 50, 100, 1000, 1e6]) {
      const shrunk = shrinkNoise(observed, count, prior, policy);
      expect(Math.abs(shrunk - observed)).toBeLessThan(Math.abs(previous - observed));
      previous = shrunk;
    }
    expect(previous).toBeCloseTo(observed, 4);
  });

  it("reaches the verdict through the channel's own constant", () => {
    const s = shaped(policy.minObservations, 100, 0.5);
    const verdict = judgeSurprise(101, s, "volume", 0.05, policy);
    if (verdict.kind !== "measured") throw new Error("expected measured");
    const observed = noiseOf(s, 0.05);
    expect(verdict.noise).toBeCloseTo((observed + policy.fleetPrior.volume) / 2, 12);
    expect(verdict.threshold).toBeCloseTo(tagThreshold(verdict.noise, policy), 12);
  });
});

describe("the adaptive threshold", () => {
  // Two baselines at the same location and count, one quiet and one noisy.
  // The same surprise, in robust z units, crosses under the quiet baseline
  // and not under the noisy one. This is the threshold doing its work
  // against an adversary who raised the noise: the deviation is already
  // measured in units of that noise, and the threshold rises on top.
  it("lets the same surprise cross under a quiet baseline and not under a noisy one", () => {
    const quiet = shaped(40, 100, 0.5);
    const noisy = shaped(40, 100, 30);
    const quietVerdict = judgeSurprise(100 + 3.5 * 0.5, quiet, "volume", 0.05, policy);
    const noisyVerdict = judgeSurprise(100 + 3.5 * 30, noisy, "volume", 0.05, policy);
    if (quietVerdict.kind !== "measured" || noisyVerdict.kind !== "measured") throw new Error("expected measured");
    expect(quietVerdict.surprise).toBeCloseTo(3.5, 9);
    expect(noisyVerdict.surprise).toBeCloseTo(3.5, 9);
    expect(quietVerdict.threshold).toBeLessThan(noisyVerdict.threshold);
    expect(quietVerdict.crosses).toBe(true);
    expect(noisyVerdict.crosses).toBe(false);
  });

  it("reads the magnitude, so a deviation below the location crosses too", () => {
    const s = shaped(40, 100, 0.5);
    const verdict = judgeSurprise(100 - 10 * 0.5, s, "volume", 0.05, policy);
    if (verdict.kind !== "measured") throw new Error("expected measured");
    expect(verdict.surprise).toBeLessThan(0);
    expect(verdict.crosses).toBe(true);
  });

  it("carries the signed surprise out of the verdict untouched", () => {
    const s = shaped(40, 100, 0.5);
    const low = judgeSurprise(90, s, "volume", 0.05, policy);
    const high = judgeSurprise(110, s, "volume", 0.05, policy);
    if (low.kind !== "measured" || high.kind !== "measured") throw new Error("expected measured");
    expect(low.surprise).toBeCloseTo(-high.surprise, 12);
  });

  it("is a pure function of its arguments", () => {
    const s = shaped(40, 100, 0.5);
    expect(judgeSurprise(103, s, "volume", 0.05, policy)).toEqual(judgeSurprise(103, s, "volume", 0.05, policy));
  });
});

// What the brief's tests leave open, found by mutating the implementation
// under them: every literal the shipped policy collides with, every guard
// with no test against it, every refusal asserted by class alone, and the
// paths the brief never reaches, which are a negative location, a channel
// other than volume, a surprise exactly at the threshold, and a corrupt row.
//
// The shipped policy is a poor witness for four of the fields this module
// reads. thresholdBase, surpriseScale and winsorMadMultiple are one number;
// noiseCoefficient, g0Ceiling and two channel floors are another; three of
// the four fleet priors are a third; only minObservations stands alone. So
// where a field is overridden below it is overridden to a value no other
// shipped field carries, and the neighbours are held apart from it rather
// than pinned to what they happen to be today.

function refusalOf(call: () => unknown): string {
  try {
    call();
  } catch (e) {
    if (e instanceof RangeError) return e.message;
    throw e;
  }
  throw new Error("expected a RangeError and got none");
}

/** A hand-shaped baseline on a chosen channel, for the per-channel prior. */
function shapedOn(channel: ContinuousChannel, count: number, location: number, spread: number): BaselineState {
  return { ...emptyBaseline(ns, channel, "x"), count, mean: location, medianEst: location, madEst: spread };
}

describe("no tag is produced below the minimum observation count, beyond the brief", () => {
  // The minimum is the policy's field and not a literal. Under a minimum of
  // seven the seventh observation is the first that can be judged, and a
  // history of ten, warm under the shipped policy, is cold under twelve.
  it("reads the minimum from the policy, so a different policy is cold up to its own count", () => {
    const seven = { ...policy, minObservations: 7 };
    const twelve = { ...policy, minObservations: 12 };
    let s = emptyBaseline(ns, "volume", "amount/USDC/in");
    for (let n = 0; n < 7; n++) {
      expect(judgeSurprise(1e12, n === 0 ? null : s, "volume", floor, seven)).toEqual({ kind: "cold", count: n, minObservations: 7 });
      s = updateBaseline(s, 0.25, robustScale(s, floor), seven);
    }
    expect(judgeSurprise(1e12, s, "volume", floor, seven).kind).toBe("measured");
    expect(judgeSurprise(1e12, null, "volume", floor, seven)).toEqual({ kind: "cold", count: 0, minObservations: 7 });
    const ten = warmed(Array(10).fill(0.25));
    expect(judgeSurprise(1e12, ten, "volume", floor, policy).kind).toBe("measured");
    expect(judgeSurprise(1e12, ten, "volume", floor, twelve)).toEqual({ kind: "cold", count: 10, minObservations: 12 });
  });

  it("is cold at count zero for an empty baseline that is not null", () => {
    expect(judgeSurprise(1e12, emptyBaseline(ns, "volume", "amount/USDC/in"), "volume", floor, policy)).toEqual({
      kind: "cold", count: 0, minObservations: policy.minObservations,
    });
  });

  // A row this arithmetic could not have written is refused before its
  // count is read, under the baseline's own message. It is not reported
  // cold on the strength of a count that cannot be trusted, and a negative
  // count in particular is not "below the minimum".
  it("refuses a corrupt row below the minimum rather than reporting it cold", () => {
    const empty = emptyBaseline(ns, "volume", "amount/USDC/in");
    expect(() => judgeSurprise(1, { ...empty, count: 3 }, "volume", floor, policy))
      .toThrow("baseline volume/amount/USDC/in has 3 observations and no robust pair");
    expect(() => judgeSurprise(1, { ...shaped(3, 100, 1), mean: 99 }, "volume", floor, policy))
      .toThrow("baseline volume/amount/USDC/in has location 100 apart from mean 99");
    expect(() => judgeSurprise(1, shaped(-1, 100, 1), "volume", floor, policy))
      .toThrow("baseline count must be a non-negative integer, got -1");
  });

  // A zero minimum would make every history warm and the shrinkage divide
  // zero by zero. It is refused up front, for a null state too, under the
  // wording assertPolicy gives it.
  it("refuses a policy whose minimum is not a positive integer, for a null state and a warm one alike", () => {
    for (const minObservations of [0, -1, 2.5, Number.NaN]) {
      const broken = { ...policy, minObservations };
      const message = refusalOf(() => assertPolicy(broken));
      expect(message).toBe(`policy.minObservations must be a positive integer, got ${minObservations}`);
      expect(() => judgeSurprise(1, null, "volume", floor, broken)).toThrow(message);
      expect(() => judgeSurprise(1, warmed(Array(20).fill(0.25)), "volume", floor, broken)).toThrow(message);
    }
  });
});

describe("judgeSurprise, beyond the brief", () => {
  // The standing ruling: a refusal is never turned into the absence of a
  // tag. What surpriseOf refuses, this refuses, under surpriseOf's message.
  it("propagates surpriseOf's refusal and never returns cold in its place", () => {
    const s = warmed(Array(20).fill(0.25));
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => judgeSurprise(value, s, "volume", floor, policy)).toThrow(`observation must be finite, got ${value}`);
    }
    expect(() => judgeSurprise(1, s, "volume", 0, policy)).toThrow("scale floor must be positive and finite, got 0");
  });

  // The gate is closed at the threshold: a magnitude exactly equal to it
  // crosses. With the coefficient at zero the threshold is the base to the
  // bit, and the base, the scale and the deviation are all exact in binary.
  it("crosses at a magnitude exactly equal to the threshold", () => {
    const flat = { ...policy, thresholdBase: 2.5, noiseCoefficient: 0 };
    const s = shaped(40, 100, 1);
    const at = judgeSurprise(102.5, s, "volume", 1, flat);
    const under = judgeSurprise(102.4375, s, "volume", 1, flat);
    const below = judgeSurprise(97.5, s, "volume", 1, flat);
    if (at.kind !== "measured" || under.kind !== "measured" || below.kind !== "measured") throw new Error("expected measured");
    expect(at.threshold).toBe(2.5);
    expect(at.surprise).toBe(2.5);
    expect(at.crosses).toBe(true);
    expect(under.crosses).toBe(false);
    expect(below.surprise).toBe(-2.5);
    expect(below.crosses).toBe(true);
  });

  it("carries surpriseOf's own number, to the bit", () => {
    const s = warmed([0.25, 0.3, 0.2, 0.25, 0.35, 0.25, 0.15, 0.25, 0.3, 0.25, 0.25]);
    const verdict = judgeSurprise(0.7, s, "volume", floor, policy);
    if (verdict.kind !== "measured") throw new Error("expected measured");
    expect(verdict.surprise).toBe(surpriseOf(0.7, s, floor));
  });

  it("leaves the state it judged untouched", () => {
    const s = warmed(Array(12).fill(0.25));
    const before = structuredClone(s);
    judgeSurprise(500, s, "volume", floor, policy);
    judgeSurprise(500, shaped(3, 1, 1), "volume", floor, policy);
    expect(s).toEqual(before);
  });
});

describe("the fleet prior, beyond the brief", () => {
  // Three of the four shipped priors are one number, so a read from the
  // wrong channel, or a literal, passes every test on volume. Four priors
  // no other shipped field carries, and a verdict on each channel.
  it("is the constant of the channel that was judged, for each of the four", () => {
    const distinct = { ...policy, fleetPrior: { volume: 0.11, price: 0.23, latency: 0.37, cluster_proximity: 0.41 } };
    const noises: number[] = [];
    for (const channel of CONTINUOUS_CHANNELS) {
      const s = shapedOn(channel, policy.minObservations, 100, 0.5);
      const verdict = judgeSurprise(101, s, channel, 0.05, distinct);
      if (verdict.kind !== "measured") throw new Error("expected measured");
      expect(verdict.noise, channel).toBeCloseTo((noiseOf(s, 0.05) + distinct.fleetPrior[channel]) / 2, 12);
      noises.push(verdict.noise);
    }
    expect(new Set(noises).size).toBe(CONTINUOUS_CHANNELS.length);
  });

  // The pseudo-count is the policy's minimum and not a literal. Under a
  // minimum of seven the midpoint sits at seven, and ten is past it.
  it("shrinks over the policy's own minimum, and not over a literal", () => {
    const seven = { ...policy, minObservations: 7 };
    expect(shrinkNoise(0.1, 7, 0.5, seven)).toBeCloseTo(0.3, 12);
    expect(shrinkNoise(0.1, 10, 0.5, seven)).toBeCloseTo((10 * 0.1 + 7 * 0.5) / 17, 12);
    expect(shrinkNoise(0.1, 10, 0.5, seven)).not.toBeCloseTo(0.3, 12);
  });

  it("refuses a noise, a prior or a count it cannot shrink, each under its own message", () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => shrinkNoise(bad, 10, 0.5, policy)).toThrow(`noise must be non-negative and finite, got ${bad}`);
      expect(() => shrinkNoise(0.1, 10, bad, policy)).toThrow(`prior must be non-negative and finite, got ${bad}`);
    }
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => shrinkNoise(0.1, count, 0.5, policy)).toThrow(`count must be a non-negative integer, got ${count}`);
    }
  });

  it("refuses a shrinkage whose arithmetic overflows on the way to a finite answer", () => {
    expect(() => shrinkNoise(1e308, 2 ** 53 - 1, 0.5, policy)).toThrow("does not fit a double");
    expect(shrinkNoise(1e290, 2 ** 53 - 1, 0.5, policy) / 1e290).toBeCloseTo(1, 12);
  });

  it("refuses a policy whose minimum is not a positive integer, under assertPolicy's own message", () => {
    for (const minObservations of [0, -1, 2.5, Number.NaN]) {
      const broken = { ...policy, minObservations };
      const message = refusalOf(() => assertPolicy(broken));
      expect(() => shrinkNoise(0.1, 0, 0.5, broken)).toThrow(message);
      expect(() => shrinkNoise(0.1, 20, 0.5, broken)).toThrow(message);
    }
  });
});

describe("tagThreshold, beyond the brief", () => {
  it("refuses under the noise's own message, so the NaN case is not another guard's refusal", () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tagThreshold(bad, policy)).toThrow(`noise must be non-negative and finite, got ${bad}`);
    }
  });

  // Each field overridden alone, to a value no other shipped field carries,
  // so a read from a neighbour or a literal is visible on its own. The
  // neighbours are held apart from the override, not pinned to today's
  // numbers.
  it("reads the base and the coefficient from their own fields, and multiplies", () => {
    const base = { ...policy, thresholdBase: 2.5 };
    const steep = { ...policy, noiseCoefficient: 1.7 };
    const both = { ...policy, thresholdBase: 2.5, noiseCoefficient: 1.7 };
    expect(base.surpriseScale).not.toBe(base.thresholdBase);
    expect(base.winsorMadMultiple).not.toBe(base.thresholdBase);
    expect(steep.g0Ceiling).not.toBe(steep.noiseCoefficient);
    expect(steep.scaleFloor.byChannel.volume).not.toBe(steep.noiseCoefficient);
    expect(tagThreshold(0, base)).toBe(2.5);
    expect(tagThreshold(0.4, base)).toBeCloseTo(2.5 * (1 + policy.noiseCoefficient * 0.4), 12);
    expect(tagThreshold(0.4, steep)).toBeCloseTo(policy.thresholdBase * (1 + 1.7 * 0.4), 12);
    expect(tagThreshold(0.4, both)).toBeCloseTo(2.5 * (1 + 1.7 * 0.4), 12);
    expect(tagThreshold(0.4, both)).not.toBeCloseTo(2.5 + 1.7 * 0.4, 12);
  });

  it("refuses a threshold that does not fit a double", () => {
    const huge = { ...policy, thresholdBase: 1e308 };
    expect(() => tagThreshold(10, huge)).toThrow("threshold of 1e+308 raised by 1 times a noise of 10 does not fit a double");
    expect(Number.isFinite(tagThreshold(0, huge))).toBe(true);
  });

  it("refuses a base or coefficient assertPolicy refuses, under its own message", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const field of ["thresholdBase", "noiseCoefficient"] as const) {
        const broken = { ...policy, [field]: bad };
        const message = refusalOf(() => assertPolicy(broken));
        expect(message).toBe(`policy.${field} must be a non-negative finite number, got ${bad}`);
        expect(() => tagThreshold(0.5, broken)).toThrow(message);
      }
    }
  });
});

describe("noiseOf, beyond the brief", () => {
  it("reads the magnitude of the location, so a negative stream is as noisy as a positive one", () => {
    expect(noiseOf(shaped(40, -100, 5), 0.05)).toBeCloseTo(5 / 100.05, 12);
    expect(noiseOf(shaped(40, -100, 5), 0.05)).toBe(noiseOf(shaped(40, 100, 5), 0.05));
  });

  it("refuses a quotient that does not fit a double", () => {
    expect(() => noiseOf(shaped(40, 0, 1e308), 5e-324)).toThrow("does not fit a double");
  });

  // The state goes through robustScale first, so a row this arithmetic
  // could not have written is refused under the baseline's message and not
  // under the one about a missing location.
  it("refuses a corrupt row under the baseline's own message before it looks for a location", () => {
    const empty = emptyBaseline(ns, "volume", "x");
    expect(() => noiseOf({ ...empty, count: 5 }, 0.05)).toThrow("baseline volume/x has 5 observations and no robust pair");
    expect(() => noiseOf({ ...empty, madEst: 1 }, 0.05)).toThrow("carries one robust estimate without the other");
    expect(() => noiseOf(empty, 0.05)).toThrow("baseline volume/x has no location to measure noise against");
  });
});
