import { describe, it, expect } from "vitest";
import type { Observation } from "@nonametrust/schema";
import { emptyBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { CALIBRATION_V0, type Calibration } from "./calibration.js";
import { calibrateG0, uncertaintyOf } from "./g0.js";
import { POLICY_V0, scaleFloorFor, type Policy } from "./policy.js";
import { readObservation, type ContinuousChannel } from "./reading.js";
import { robustScale, surpriseOf } from "./scale.js";
import { timescaleDivergence } from "./timescales.js";
import {
  refreshTag,
  tagObservation,
  type LiveTagInput,
  type ReadingResult,
  type TagDecision,
} from "./tag.js";

const ns = "11111111-1111-4111-8111-111111111111";
const policy = POLICY_V0;
const calibration = CALIBRATION_V0;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const src = {
  producer: "x402-gateway", producerVersion: "0.1.0",
  ref: "req:1", fetchedAt: "2026-09-12T08:14:00.000Z",
};

function event(channel: Observation["channel"], kind: string, payload: Record<string, unknown>, instant: string): Observation {
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "endpoint", id: "https://data.example/x402" },
    channel, evidenceKind: "event", kind, observedAt: instant,
    source: { ...src, ref: `req:${kind}:${instant}` }, payload,
  } as Observation;
}

function state(channel: Observation["channel"], kind: string, payload: Record<string, unknown>, from: string): Observation {
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "endpoint", id: "https://data.example/x402" },
    channel, evidenceKind: "state", kind, validFrom: from, validUntil: null,
    source: { ...src, ref: `op:${kind}:${from}` }, payload,
  } as Observation;
}

const volumeFloor = scaleFloorFor(policy, "volume", "amount/USDC/in");

function warmedVolume(values: number[]): BaselineState {
  return values.reduce(
    (s, v) => updateBaseline(s, v, robustScale(s, volumeFloor), policy),
    emptyBaseline(ns, "volume", "amount/USDC/in"),
  );
}

// The caller's arithmetic, mirrored. strengthAt lives in packages/store and
// this package may not import it, so the tests compute the decayed strength
// the way a caller would and pass it in. The curve is the one strength.ts
// documents: g0 × 0.5^(elapsed / halfLife), g0 before the tag existed.
function decayedAt(tag: { g0: number; taggedAt: Date }, at: Date): number {
  const elapsed = at.getTime() - tag.taggedAt.getTime();
  if (elapsed <= 0) return tag.g0;
  return tag.g0 * Math.pow(0.5, elapsed / calibration.halfLifeMs);
}

function live(over: Partial<LiveTagInput> = {}): LiveTagInput {
  return {
    g0: 0.5, taggedAt: new Date("2026-09-20T08:00:00.000Z"),
    refreshCount: 0, saturationState: "open", decayedStrength: 0.3,
    ...over,
  };
}

/** One observation with one reading, tagged through the entry point. */
interface One {
  observation: Observation;
  at?: Date;
  baseline?: BaselineState | null;
  liveTag?: LiveTagInput | null;
  policy?: Policy;
  calibration?: Calibration;
}

// Every reading here is tagged through tagObservation, the one public path,
// which derives the reading from the observation itself. No test hands in a
// reading: a hand-built one would be the caller-supplied aspect the spec
// says no caller supplies, and the package no longer exposes a function
// that takes one. The context is keyed under the aspect the observation
// reads into, which is what an engine fetching by aspect will do.
function tagOne(over: One): ReadingResult {
  const [reading] = readObservation(over.observation);
  const result = tagObservation({
    namespaceId: ns, observation: over.observation, at: over.at ?? new Date("2026-09-21T09:00:00.000Z"),
    contexts: new Map([[reading!.aspect, { baseline: over.baseline ?? null, liveTag: over.liveTag ?? null }]]),
    policy: over.policy ?? policy, calibration: over.calibration ?? calibration,
  });
  return result.readings[0]!;
}

const bigPayment = event("volume", "payment", { amount: "500.0000000", assetCode: "USDC", direction: "in" }, "2026-09-21T08:00:00.000Z");
const smallPayment = event("volume", "payment", { amount: "0.2600000", assetCode: "USDC", direction: "in" }, "2026-09-21T08:00:00.000Z");
const tinyPayment = event("volume", "payment", { amount: "0.0100000", assetCode: "USDC", direction: "in" }, "2026-09-21T08:00:00.000Z");
const addressChange = event("address_integrity", "payment_address_changed", { previous: "GOLDADDRESS", current: "GNEWADDRESS" }, "2026-09-12T08:14:00.000Z");
const addressRevert = event("address_integrity", "payment_address_changed", { previous: "GNEWADDRESS", current: "GOLDADDRESS" }, "2026-09-12T16:47:00.000Z");
const trustline = state("protocol", "trustline_open", { event: "trustline_created", assetCode: "USDC", issuerKnown: true }, "2026-08-20T11:02:31.000Z");

describe("refreshTag", () => {
  const at = new Date("2026-09-21T08:00:00.000Z");

  it("is the maximum of the decayed strength and the fresh g0, plus the increment", () => {
    const r = refreshTag(live({ decayedStrength: 0.3 }), 0.4, at, policy, "event");
    expect(r.g0).toBeCloseTo(0.45, 12);
    expect(r.saturationState).toBe("open");
  });

  // A later writer who replaces the maximum with a sum opens the pump. The
  // sum here would be 0.7; the maximum plus the increment is 0.45, and the
  // bound holds on a grid, not on one case.
  it("never sums the two strengths", () => {
    const r = refreshTag(live({ decayedStrength: 0.3 }), 0.4, at, policy, "event");
    expect(r.g0).not.toBeCloseTo(0.7, 6);
    // g0 is raised to the grid's top so the decayed strength never exceeds
    // it, which refreshTag refuses; the open path does not read the g0.
    for (const decayed of [0, 0.1, 0.3, 0.5, 0.9]) {
      for (const fresh of [0, 0.1, 0.3, 0.5, 0.9]) {
        const next = refreshTag(live({ g0: 0.9, decayedStrength: decayed }), fresh, at, policy, "event");
        expect(next.g0).toBeLessThanOrEqual(Math.max(decayed, fresh) + policy.refreshIncrement + 1e-12);
      }
    }
  });

  // The maximum is over the decayed strength, not the stored g0. A refresh
  // that took the stored g0 would, together with the moved instant, revive
  // the tag to full at every repeat, which is a pump with a different name.
  it("reads the decayed strength and not the stored g0", () => {
    const r = refreshTag(live({ g0: 0.9, decayedStrength: 0.3 }), 0.4, at, policy, "event");
    expect(r.g0).toBeCloseTo(0.45, 12);
    expect(r.g0).toBeLessThan(0.9);
  });

  it("moves taggedAt forward to the instant, and never backward", () => {
    const forward = refreshTag(live(), 0.4, at, policy, "event");
    expect(forward.taggedAt.toISOString()).toBe("2026-09-21T08:00:00.000Z");
    const earlier = new Date("2026-09-01T00:00:00.000Z");
    const held = refreshTag(live(), 0.4, earlier, policy, "event");
    expect(held.taggedAt.toISOString()).toBe("2026-09-20T08:00:00.000Z");
  });

  it("hands out a copy of the instant, so a caller cannot move a tag by mutating the answer", () => {
    const r = refreshTag(live(), 0.4, at, policy, "event");
    r.taggedAt.setFullYear(2000);
    expect(at.toISOString()).toBe("2026-09-21T08:00:00.000Z");
  });

  it("increments the refresh count", () => {
    expect(refreshTag(live({ refreshCount: 4 }), 0.4, at, policy, "event").refreshCount).toBe(5);
  });

  it("saturates when the increment can no longer raise the strength in full", () => {
    const r = refreshTag(live({ g0: 0.98, decayedStrength: 0.98 }), 0.5, at, policy, "event");
    expect(r.g0).toBe(policy.g0Ceiling);
    expect(r.saturationState).toBe("saturated");
  });

  it("refreshes a saturated tag's instant and count but not its g0", () => {
    const saturated = live({ g0: 1, decayedStrength: 0.2, saturationState: "saturated", refreshCount: 9 });
    const r = refreshTag(saturated, 0.9, at, policy, "event");
    expect(r.g0).toBe(1);
    expect(r.saturationState).toBe("saturated");
    expect(r.refreshCount).toBe(10);
    expect(r.taggedAt.toISOString()).toBe("2026-09-21T08:00:00.000Z");
  });

  // Identical repeats: the maximum makes them idempotent, the increment is
  // what remains, and the increment saturates. A hundred repeats never
  // exceed the ceiling and each raises by at most the increment.
  it("bounds a hundred identical repeats by the ceiling, each raising by at most the increment", () => {
    let tag = live({ g0: 0.4, decayedStrength: 0.4 });
    for (let i = 0; i < 100; i++) {
      const r = refreshTag(tag, 0.4, at, policy, "event");
      expect(r.g0).toBeLessThanOrEqual(policy.g0Ceiling);
      expect(r.g0 - tag.g0).toBeLessThanOrEqual(policy.refreshIncrement + 1e-12);
      tag = { ...tag, g0: r.g0, decayedStrength: r.g0, saturationState: r.saturationState, refreshCount: r.refreshCount };
    }
    expect(tag.saturationState).toBe("saturated");
    expect(tag.g0).toBe(policy.g0Ceiling);
  });

  // A state that is still holding is not a repeat. Its refresh keeps the
  // larger of the decayed strength and the fresh g0, moves the instant and
  // the count, and adds no increment: the maximum is what stops a standing
  // condition fading, and the increment is what a genuine repeat earns.
  // The fixtures here are values no shipped field shares.
  describe("a state that holds", () => {
    it("keeps the fresh g0 when the decayed strength has fallen below it, with no increment", () => {
      const r = refreshTag(live({ g0: 0.44, decayedStrength: 0.31 }), 0.37, at, policy, "state");
      expect(r.g0).toBe(0.37);
      expect(r.saturationState).toBe("open");
    });

    it("keeps the decayed strength when it is the larger, so an earlier repeat is not forgotten", () => {
      const r = refreshTag(live({ g0: 0.44, decayedStrength: 0.41 }), 0.37, at, policy, "state");
      expect(r.g0).toBe(0.41);
    });

    it("moves the instant forward and counts the refresh, like an event", () => {
      const r = refreshTag(live({ refreshCount: 3 }), 0.37, at, policy, "state");
      expect(r.taggedAt.toISOString()).toBe("2026-09-21T08:00:00.000Z");
      expect(r.refreshCount).toBe(4);
    });

    it("does not climb over a hundred mornings, where an event would have saturated", () => {
      let tag = live({ g0: 0.37, decayedStrength: 0.37 });
      for (let i = 0; i < 100; i++) {
        const r = refreshTag(tag, 0.37, at, policy, "state");
        expect(r.g0).toBe(0.37);
        expect(r.saturationState).toBe("open");
        tag = { ...tag, g0: r.g0, decayedStrength: r.g0, saturationState: r.saturationState, refreshCount: r.refreshCount };
      }
      expect(tag.refreshCount).toBe(100);
      const asEvent = refreshTag(live({ g0: 0.37, decayedStrength: 0.37 }), 0.37, at, policy, "event");
      expect(asEvent.g0).toBeCloseTo(0.42, 12);
    });

    it("does not read the increment at all, so an overridden increment changes nothing", () => {
      const shipped = refreshTag(live({ g0: 0.44, decayedStrength: 0.31 }), 0.37, at, policy, "state");
      const other = refreshTag(live({ g0: 0.44, decayedStrength: 0.31 }), 0.37, at, { ...policy, refreshIncrement: 0.07 }, "state");
      expect(other).toEqual(shipped);
    });

    // Section 10's sentence about a saturated tag is kept for both kinds:
    // it refreshes its instant and its count and not its g0. A state cannot
    // saturate on its own, since it adds nothing; a tag saturated by
    // genuine repeats is held at the ceiling by the condition persisting.
    it("holds a saturated tag at its g0, as an event does", () => {
      const saturated = live({ g0: 1, decayedStrength: 0.2, saturationState: "saturated", refreshCount: 9 });
      const r = refreshTag(saturated, 0.37, at, policy, "state");
      expect(r).toEqual(refreshTag(saturated, 0.37, at, policy, "event"));
      expect(r.g0).toBe(1);
      expect(r.refreshCount).toBe(10);
    });

    it("refuses an evidence kind it does not know, rather than treating it as a repeat", () => {
      expect(() => refreshTag(live(), 0.37, at, policy, "State" as never))
        .toThrow(/^evidence must be "event" or "state", got State$/);
    });
  });

  it("does not read the clock into the strength, so two instants give one g0", () => {
    const a = refreshTag(live(), 0.4, new Date("2026-09-21T08:00:00.000Z"), policy, "event");
    const b = refreshTag(live(), 0.4, new Date("2027-09-21T08:00:00.000Z"), policy, "event");
    expect(a.g0).toBe(b.g0);
  });

  it("refuses a strength that is not a finite non-negative number, and an invalid instant", () => {
    expect(() => refreshTag(live({ decayedStrength: Number.NaN }), 0.4, at, policy, "event")).toThrow(RangeError);
    expect(() => refreshTag(live({ decayedStrength: -0.1 }), 0.4, at, policy, "event")).toThrow(RangeError);
    expect(() => refreshTag(live(), Number.POSITIVE_INFINITY, at, policy, "event")).toThrow(RangeError);
    expect(() => refreshTag(live(), 0.4, new Date("not a date"), policy, "event")).toThrow(RangeError);
    expect(() => refreshTag(live({ taggedAt: new Date(Number.NaN) }), 0.4, at, policy, "event")).toThrow(RangeError);
  });
});

describe("tagging one reading on a continuous channel", () => {
  const warm = warmedVolume(Array(20).fill(0.25));

  it("opens a new tag on a crossing surprise, stamped at the event's instant and not the call's", () => {
    const r = tagOne({ observation: bigPayment, baseline: warm });
    expect(r.decision?.kind).toBe("new");
    if (r.decision?.kind !== "new") return;
    expect(r.decision.taggedAt.toISOString()).toBe("2026-09-21T08:00:00.000Z");
    expect(r.decision.channel).toBe("volume");
    expect(r.decision.aspect).toBe("amount/USDC/in");
    // weight 0.9674 × (1 − 10/30) × (1 − e^(−9995/3))
    expect(r.decision.g0).toBeCloseTo(0.6449, 3);
    expect(r.decision.surprise).toBeCloseTo((500 - 0.25) / volumeFloor, 6);
  });

  it("returns no decision below the minimum count and still updates the baseline", () => {
    const cold = warmedVolume(Array(5).fill(0.25));
    const r = tagOne({ observation: bigPayment, baseline: cold });
    expect(r.decision).toBeNull();
    expect(r.verdict).toEqual({ kind: "cold", count: 5, minObservations: policy.minObservations });
    expect(r.baseline?.count).toBe(6);
  });

  it("returns no decision on a surprise below the threshold, and leaves a live tag alone", () => {
    const r = tagOne({ observation: smallPayment, baseline: warm, liveTag: live() });
    expect(r.decision).toBeNull();
    expect(r.verdict?.kind).toBe("measured");
    if (r.verdict?.kind === "measured") expect(r.verdict.crosses).toBe(false);
    expect(r.baseline?.count).toBe(21);
  });

  // The observation is judged against the history it has not yet joined.
  it("judges against the baseline before the update, not after", () => {
    const r = tagOne({ observation: smallPayment, baseline: warm });
    if (r.verdict?.kind !== "measured" || r.baseline === null) throw new Error("expected a measured verdict and a next state");
    expect(r.verdict.surprise).toBeCloseTo(surpriseOf(0.26, warm, volumeFloor), 12);
    expect(r.verdict.surprise).not.toBeCloseTo(surpriseOf(0.26, r.baseline, volumeFloor), 12);
  });

  it("refreshes a live tag rather than opening a second, with the instant moved forward", () => {
    const tag = live({ g0: 0.5, taggedAt: new Date("2026-09-20T08:00:00.000Z") });
    const at = new Date("2026-09-21T09:00:00.000Z");
    const r = tagOne({
      observation: bigPayment, baseline: warm, at,
      liveTag: { ...tag, decayedStrength: decayedAt(tag, at) },
    });
    expect(r.decision?.kind).toBe("refresh");
    if (r.decision?.kind !== "refresh") return;
    expect(r.decision.refreshCount).toBe(1);
    expect(r.decision.taggedAt.toISOString()).toBe("2026-09-21T08:00:00.000Z");
    // max(0.5 × 0.5^(25h / 14d), 0.6449) + 0.05
    expect(r.decision.g0).toBeCloseTo(0.6949, 3);
    expect(r.decision.saturationState).toBe("open");
  });

  it("carries the signed surprise, so a deviation below the location leaves as a negative number", () => {
    const r = tagOne({ observation: tinyPayment, baseline: warm });
    expect(r.decision?.kind).toBe("new");
    expect(r.decision?.surprise).toBeLessThan(0);
    if (r.verdict?.kind === "measured") expect(r.verdict.surprise).toBeCloseTo((0.01 - 0.25) / volumeFloor, 9);
  });

  // The divergence is exposed and not acted on. Two baselines that differ
  // only in their fast and slow pairs give the same decision and different
  // divergences.
  it("does not read the timescale divergence into the decision", () => {
    const calm = tagOne({ observation: bigPayment, baseline: warm });
    const inflated = tagOne({
      observation: bigPayment, baseline: { ...warm, fastM2: 1e6, slowM2: 0 },
    });
    expect(inflated.decision).toEqual(calm.decision);
    expect(inflated.timescaleDivergence).not.toBe(calm.timescaleDivergence);
    expect(inflated.timescaleDivergence).toBeGreaterThan(0);
  });

  it("names the policy and calibration versions on the decision", () => {
    const r = tagOne({ observation: bigPayment, baseline: warm });
    expect(r.decision).toMatchObject({ policyVersion: "policy-v0", calibrationVersion: "calibration-v0" });
  });

  it("refuses a baseline keyed to another aspect or another namespace", () => {
    expect(() => tagOne({
      observation: bigPayment, baseline: { ...warm, aspect: "amount/XLM/in" },
    })).toThrow(RangeError);
    expect(() => tagOne({
      observation: bigPayment, baseline: { ...warm, namespaceId: "22222222-2222-4222-8222-222222222222" },
    })).toThrow(RangeError);
  });

  it("refuses an invalid instant and a policy the arithmetic cannot use", () => {
    expect(() => tagOne({
      observation: bigPayment, baseline: warm, at: new Date("no"),
    })).toThrow(RangeError);
    expect(() => tagOne({
      observation: bigPayment, baseline: warm,
      policy: { ...policy, minObservations: 0 },
    })).toThrow(RangeError);
  });
});

describe("tagging one reading on a categorical channel", () => {
  it("tags from day one, against no baseline, at the channel weight times the categorical base", () => {
    const r = tagOne({ observation: addressChange});
    expect(r.baseline).toBeNull();
    expect(r.verdict).toBeNull();
    expect(r.timescaleDivergence).toBeNull();
    expect(r.decision?.kind).toBe("new");
    expect(r.decision?.g0).toBeCloseTo(0.7984 * policy.categoricalBase, 6);
    expect(r.decision?.surprise).toBeNull();
  });

  it("stamps an event's tag at the event's instant", () => {
    const r = tagOne({ observation: addressChange, at: new Date("2026-09-12T20:00:00.000Z") });
    expect(r.decision?.taggedAt.toISOString()).toBe("2026-09-12T08:14:00.000Z");
  });

  // A state has no instant, and datedAt returns null for it. The tag is
  // stamped at the call's instant, which is the only date in hand.
  it("stamps a state's tag at the call's instant", () => {
    const at = new Date("2026-09-01T08:00:05.000Z");
    const r = tagOne({ observation: trustline, at });
    expect(r.decision?.kind).toBe("new");
    expect(r.decision?.taggedAt.toISOString()).toBe("2026-09-01T08:00:05.000Z");
  });
});

// Acceptance criterion 2. The day-twelve address change and its revert are
// two observations on one (namespace, channel, aspect). The second refreshes
// the first: one tag, its instant moved to the revert, its count at one, its
// g0 the maximum plus the increment and not the sum.
describe("a repeated deviation refreshes rather than stacks", () => {
  it("turns the revert into a refresh of the change", () => {
    const decisions: TagDecision[] = [];
    const first = tagOne({ observation: addressChange, at: new Date("2026-09-12T08:14:00.000Z") });
    decisions.push(first.decision!);
    const opened = { g0: first.decision!.g0, taggedAt: first.decision!.taggedAt };
    const at = new Date("2026-09-12T16:47:00.000Z");
    const second = tagOne({
      observation: addressRevert, at,
      liveTag: { ...opened, refreshCount: 0, saturationState: "open", decayedStrength: decayedAt(opened, at) },
    });
    decisions.push(second.decision!);

    expect(decisions.map((d) => d.kind)).toEqual(["new", "refresh"]);
    const refresh = decisions[1]!;
    if (refresh.kind !== "refresh") throw new Error("expected refresh");
    expect(refresh.refreshCount).toBe(1);
    expect(refresh.taggedAt.toISOString()).toBe("2026-09-12T16:47:00.000Z");
    const decayed = decayedAt(opened, at);
    expect(refresh.g0).toBeCloseTo(Math.max(decayed, opened.g0) + policy.refreshIncrement, 12);
    expect(refresh.g0).toBeLessThan(decayed + opened.g0);
  });
});

// Acceptance criterion 4. A standing condition re-evaluated every morning
// for a week yields one tag, refreshed six times, its instant carried
// forward each day and its strength held rather than grown. The study
// credited a standing condition to every window including the seven-day
// one; this is the arithmetic that does not.
describe("a state observation never yields two tags inside one window", () => {
  it("opens once and refreshes on every later morning", () => {
    const kinds: string[] = [];
    let tag: LiveTagInput | null = null;
    let lastInstant = 0;
    for (let day = 1; day <= 7; day++) {
      const at = new Date(Date.UTC(2026, 8, day, 8, 0, 5));
      const r = tagOne({ observation: trustline, at, liveTag: tag });
      const d = r.decision!;
      kinds.push(d.kind);
      expect(d.taggedAt.getTime()).toBeGreaterThan(lastInstant);
      lastInstant = d.taggedAt.getTime();
      tag = {
        g0: d.g0, taggedAt: d.taggedAt,
        refreshCount: d.kind === "refresh" ? d.refreshCount : 0,
        saturationState: d.kind === "refresh" ? d.saturationState : "open",
        decayedStrength: 0,
      };
      tag.decayedStrength = decayedAt(tag, at);
    }
    expect(kinds).toEqual(["new", "refresh", "refresh", "refresh", "refresh", "refresh", "refresh"]);
    expect(tag?.refreshCount).toBe(6);
  });

  // The condition holding is one fact: the strength neither fades nor
  // climbs. Every morning's g0 is the day-one g0 exactly, while the decayed
  // operand handed in each morning sits strictly below it.
  it("holds the strength flat across the week, neither fading nor climbing", () => {
    let tag: LiveTagInput | null = null;
    const strengths: number[] = [];
    for (let day = 1; day <= 7; day++) {
      const at = new Date(Date.UTC(2026, 8, day, 8, 0, 5));
      if (tag !== null) expect(tag.decayedStrength).toBeLessThan(tag.g0);
      const d: TagDecision = tagOne({ observation: trustline, at, liveTag: tag }).decision!;
      strengths.push(d.g0);
      const held: Omit<LiveTagInput, "decayedStrength"> = {
        g0: d.g0, taggedAt: d.taggedAt, refreshCount: d.kind === "refresh" ? d.refreshCount : 0, saturationState: "open",
      };
      tag = { ...held, decayedStrength: decayedAt(held, new Date(at.getTime() + DAY)) };
    }
    expect(strengths).toEqual(Array(7).fill(0.6496 * policy.categoricalBase));
  });
});

describe("tagObservation", () => {
  const dust = event("cluster_proximity", "dust_received", { clusterId: "cluster:dust-fleet-0031", hops: 2, amount: "0.0000100" }, "2026-09-07T03:41:12.000Z");

  it("returns one result per reading, and treats a missing context as a counterparty nobody has seen", () => {
    const r = tagObservation({
      namespaceId: ns, observation: dust, at: new Date("2026-09-07T03:45:00.000Z"),
      contexts: new Map(), policy, calibration,
    });
    expect(r.readings.map((x) => x.reading.aspect).sort()).toEqual(["amount", "hops"]);
    for (const x of r.readings) {
      expect(x.verdict).toEqual({ kind: "cold", count: 0, minObservations: policy.minObservations });
      expect(x.decision).toBeNull();
      expect(x.baseline?.count).toBe(1);
    }
    expect(r).toMatchObject({ policyVersion: "policy-v0", calibrationVersion: "calibration-v0" });
  });

  it("routes each reading to its own context", () => {
    const hops = warmedVolume(Array(12).fill(2));
    const r = tagObservation({
      namespaceId: ns, observation: dust, at: new Date("2026-09-07T03:45:00.000Z"),
      contexts: new Map([["hops", { baseline: { ...hops, channel: "cluster_proximity", aspect: "hops" }, liveTag: null }]]),
      policy, calibration,
    });
    const byAspect = new Map(r.readings.map((x) => [x.reading.aspect, x]));
    expect(byAspect.get("hops")?.verdict?.kind).toBe("measured");
    expect(byAspect.get("amount")?.verdict?.kind).toBe("cold");
  });

  it("is deterministic", () => {
    const run = () => tagObservation({
      namespaceId: ns, observation: dust, at: new Date("2026-09-07T03:45:00.000Z"),
      contexts: new Map(), policy, calibration,
    });
    expect(run()).toEqual(run());
  });

  it("refuses a policy or a calibration the arithmetic cannot use, before reading anything", () => {
    expect(() => tagObservation({
      namespaceId: ns, observation: dust, at: new Date("2026-09-07T03:45:00.000Z"),
      contexts: new Map(), policy: { ...policy, fastAlpha: 1 }, calibration,
    })).toThrow(RangeError);
    expect(() => tagObservation({
      namespaceId: ns, observation: dust, at: new Date("2026-09-07T03:45:00.000Z"),
      contexts: new Map(), policy, calibration: { ...calibration, halfLifeMs: 0 },
    })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief. Every test from here down was written against a mutant
// that survived the thirty above; the task report's sweep table names which.

function warmed(channel: ContinuousChannel, aspect: string, values: number[]): BaselineState {
  const floor = scaleFloorFor(policy, channel, aspect);
  return values.reduce(
    (s, v) => updateBaseline(s, v, robustScale(s, floor), policy),
    emptyBaseline(ns, channel, aspect),
  );
}

describe("refreshTag's refusals name their cause", () => {
  const at = new Date("2026-09-21T08:00:00.000Z");

  it("refuses a live g0 that is not a finite non-negative number, open or saturated", () => {
    expect(() => refreshTag(live({ g0: Number.NaN }), 0.4, at, policy, "event"))
      .toThrow(/^live tag g0 must be a finite non-negative number/);
    // A saturated tag hands its own g0 back, so a bad one would leave as the answer.
    expect(() => refreshTag(live({ g0: -1, saturationState: "saturated" }), 0.4, at, policy, "event"))
      .toThrow(/^live tag g0 must be a finite non-negative number/);
  });

  it("names the decayed strength, the fresh g0 and each instant", () => {
    expect(() => refreshTag(live({ decayedStrength: Number.NaN }), 0.4, at, policy, "event"))
      .toThrow(/^decayed strength must be a finite non-negative number/);
    expect(() => refreshTag(live(), Number.POSITIVE_INFINITY, at, policy, "event"))
      .toThrow(/^fresh g0 must be a finite non-negative number/);
    expect(() => refreshTag(live({ taggedAt: new Date(Number.NaN) }), 0.4, at, policy, "event"))
      .toThrow(/^live tag instant must be a valid date$/);
    expect(() => refreshTag(live(), 0.4, new Date("not a date"), policy, "event"))
      .toThrow(/^instant must be a valid date$/);
  });

  it("refuses a refresh count that is not a non-negative integer", () => {
    for (const refreshCount of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => refreshTag(live({ refreshCount }), 0.4, at, policy, "event"))
        .toThrow(/^refresh count must be a non-negative integer/);
    }
  });

  // A saturated tag is handed back at its own g0, so one above the ceiling
  // would leave above it on every refresh, unbounded. Refused, not clamped:
  // a clamp would report a changed value under a policy that did not
  // produce it. At the ceiling is fine; the brief's saturated test holds it.
  it("refuses a saturated tag whose g0 lies above the ceiling, naming both", () => {
    const legacy = live({ g0: 7, decayedStrength: 0.2, saturationState: "saturated" });
    expect(() => refreshTag(legacy, 0.9, at, policy, "event"))
      .toThrow(/^saturated tag g0 7 lies above policy\.g0Ceiling 1;/);
    const lowered = live({ g0: 1, decayedStrength: 0.2, saturationState: "saturated" });
    expect(() => refreshTag(lowered, 0.9, at, { ...policy, g0Ceiling: 0.9 }, "event"))
      .toThrow(/^saturated tag g0 1 lies above policy\.g0Ceiling 0\.9;/);
    expect(refreshTag(lowered, 0.9, at, policy, "event").g0).toBe(1);
  });

  // No honest curve returns more than the g0 it started from.
  it("refuses a decayed strength above the live g0, open or saturated", () => {
    expect(() => refreshTag(live({ g0: 0.5, decayedStrength: 0.6 }), 0.4, at, policy, "event"))
      .toThrow(/^decayed strength 0\.6 exceeds the live tag g0 0\.5/);
    expect(() => refreshTag(live({ g0: 0.5, decayedStrength: 0.6, saturationState: "saturated" }), 0.4, at, policy, "event"))
      .toThrow(/^decayed strength 0\.6 exceeds the live tag g0 0\.5/);
    expect(refreshTag(live({ g0: 0.5, decayedStrength: 0.5 }), 0.4, at, policy, "event").g0).toBeCloseTo(0.55, 12);
  });

  // refreshTag is public and does not pass through the entry's assertPolicy,
  // so the two fields it reads are checked where they are read, under
  // assertPolicy's own wording.
  it("refuses an increment or a ceiling assertPolicy refuses, under the same message", () => {
    for (const refreshIncrement of [Number.NaN, -0.1, Number.POSITIVE_INFINITY]) {
      expect(() => refreshTag(live(), 0.4, at, { ...policy, refreshIncrement }, "event"))
        .toThrow(/^policy\.refreshIncrement must be a non-negative finite number/);
    }
    for (const g0Ceiling of [0, 1.5, Number.NaN]) {
      expect(() => refreshTag(live(), 0.4, at, { ...policy, g0Ceiling }, "event"))
        .toThrow(/^policy\.g0Ceiling must lie in \(0, 1\]/);
    }
  });
});

describe("refreshTag reads the increment and the ceiling from their own fields", () => {
  const at = new Date("2026-09-21T08:00:00.000Z");
  // Under the shipped policy the increment, 0.05, equals both aspect floors,
  // and the ceiling, 1, equals the noise coefficient and two channel floors,
  // so a read of the wrong field is invisible at the defaults. The overrides
  // are values no shipped field carries, and the neighbours are held apart
  // from them rather than pinned to today's numbers.
  it("adds the policy's increment and not a literal or a floor", () => {
    const shadow = { ...policy, refreshIncrement: 0.07 };
    expect(shadow.scaleFloor.byAspect["volume/amount/USDC/in"]).not.toBe(0.07);
    const r = refreshTag(live({ decayedStrength: 0.3 }), 0.4, at, shadow, "event");
    expect(r.g0).toBeCloseTo(0.47, 12);
  });

  it("saturates at the policy's ceiling and not at one", () => {
    const shadow = { ...policy, g0Ceiling: 0.9 };
    expect(shadow.noiseCoefficient).not.toBe(0.9);
    const r = refreshTag(live({ g0: 0.88, decayedStrength: 0.88 }), 0.5, at, shadow, "event");
    expect(r.g0).toBe(0.9);
    expect(r.saturationState).toBe("saturated");
  });

  // Exactly reaching the ceiling is saturation: the increment can no longer
  // raise the strength, which is the spec's condition. Binary fractions, so
  // the sum is exact and the test is about the comparison, not rounding.
  it("is saturated when the raised strength lands exactly on the ceiling", () => {
    const shadow = { ...policy, refreshIncrement: 0.25, g0Ceiling: 0.75 };
    const r = refreshTag(live({ decayedStrength: 0.5 }), 0, at, shadow, "event");
    expect(r.g0).toBe(0.75);
    expect(r.saturationState).toBe("saturated");
  });
});

describe("the entry", () => {
  const warm = warmedVolume(Array(20).fill(0.25));

  // The version is what every result names; nothing downstream of the entry
  // reads it, so the entry check is the only one and its message is pinned.
  it("refuses a policy or a calibration that names nothing", () => {
    expect(() => tagOne({ observation: addressChange, policy: { ...policy, version: "" } }))
      .toThrow(/^policy\.version must not be empty$/);
    expect(() => tagOne({ observation: addressChange, calibration: { ...calibration, version: "" } }))
      .toThrow(/^calibration\.version must not be empty$/);
  });

  it("names the versions it was given, not the shipped ones", () => {
    const r = tagOne({
      observation: bigPayment, baseline: warm,
      policy: { ...policy, version: "policy-v0-shadow" },
      calibration: { ...calibration, version: "calibration-v0-shadow" },
    });
    expect(r.decision).toMatchObject({ policyVersion: "policy-v0-shadow", calibrationVersion: "calibration-v0-shadow" });
  });

  it("refuses an event whose instant does not parse, rather than stamping a tag at an invalid date", () => {
    const undated = event("address_integrity", "payment_address_changed", { previous: "GOLDADDRESS", current: "GNEWADDRESS" }, "not an instant");
    expect(() => tagOne({ observation: undated}))
      .toThrow(/^event instant must be a valid date$/);
  });

  it("hands a state's tag a copy of the call's instant, so the caller's date is not shared with the answer", () => {
    const at = new Date("2026-09-01T08:00:05.000Z");
    const r = tagOne({ observation: trustline, at });
    r.decision!.taggedAt.setFullYear(2000);
    expect(at.toISOString()).toBe("2026-09-01T08:00:05.000Z");
  });
});

// The policy's unmeasured weight equals the weakest measured one, and every
// decision names the calibration version, so a latency decision and a
// content decision cannot be told apart by their numbers or their versions.
// The source is what tells them apart, and it is set by calibration.ts from
// the predicate that chooses the weight; provenance.test.ts holds that
// predicate, this holds that the decision carries what it returns.
describe("the weight's source is named on the decision", () => {
  const latencyEvent = event("latency", "response", { latencyMs: 100000 }, "2026-09-21T08:00:00.000Z");
  const memo = event("content", "memo_seen", { text: "pay here", field: "memo" }, "2026-09-21T08:00:00.000Z");

  it("says calibration for a measured channel, continuous or categorical", () => {
    const volume = tagOne({ observation: bigPayment, baseline: warmedVolume(Array(20).fill(0.25)) });
    const content = tagOne({ observation: memo});
    expect(volume.decision).toMatchObject({ weightSource: "calibration", calibrationVersion: "calibration-v0" });
    expect(content.decision).toMatchObject({ weightSource: "calibration", calibrationVersion: "calibration-v0" });
  });

  it("says policy for latency, while still naming the calibration version beside it", () => {
    const latencyWarm = warmed("latency", "latencyMs", Array(20).fill(100));
    const r = tagOne({ observation: latencyEvent, baseline: latencyWarm });
    expect(r.decision?.kind).toBe("new");
    expect(r.decision).toMatchObject({ weightSource: "policy", calibrationVersion: "calibration-v0" });
    // The number is the policy's weight, and the source says so.
    if (r.verdict?.kind !== "measured") throw new Error("expected a measured verdict");
    expect(r.decision?.g0).toBeCloseTo(
      calibrateG0(r.verdict.surprise, uncertaintyOf(20, policy), policy.unmeasuredChannelWeight, policy), 12,
    );
  });

  it("carries the source through a refresh as well", () => {
    const latencyWarm = warmed("latency", "latencyMs", Array(20).fill(100));
    const r = tagOne({ observation: latencyEvent, baseline: latencyWarm, liveTag: live() });
    expect(r.decision).toMatchObject({ kind: "refresh", weightSource: "policy" });
  });
});

describe("the baseline handed in is the reading's own", () => {
  const warm = warmedVolume(Array(20).fill(0.25));

  // The verdict takes the channel and the state as two arguments and reads
  // the fleet prior off the channel; it never compares the two, and a state
  // of one channel judged under another would be measured against the wrong
  // prior with nothing downstream able to notice. This is the verdict's one
  // caller, and this is where the two are pinned equal.
  it("refuses a baseline keyed to another channel, naming both keys", () => {
    expect(() => tagOne({
      observation: bigPayment, baseline: { ...warm, channel: "price" },
    })).toThrow(/^baseline .*\/price\/amount\/USDC\/in is not the baseline for .*\/volume\/amount\/USDC\/in$/);
  });

  it("refuses a corrupt baseline under its own message even when its key is also wrong", () => {
    expect(() => tagOne({
      observation: bigPayment, baseline: { ...warm, aspect: "amount/XLM/in", count: -1 },
    })).toThrow(/^baseline count must be a non-negative integer/);
  });

  it("refuses a baseline offered for a categorical reading, which has none", () => {
    expect(() => tagOne({ observation: addressChange, baseline: warm }))
      .toThrow(/^categorical reading address_integrity\/transition has no baseline/);
  });

  it("starts a first baseline on the reading's own key", () => {
    const r = tagOne({ observation: bigPayment});
    expect(r.baseline).toMatchObject({ namespaceId: ns, channel: "volume", aspect: "amount/USDC/in", count: 1 });
  });

  it("reads the categorical base from the policy and not a literal", () => {
    // 0.65 is shared by no shipped field; the nearest is protocol's weight at 0.6496.
    const r = tagOne({ observation: addressChange, policy: { ...policy, categoricalBase: 0.65 } });
    expect(r.decision?.g0).toBeCloseTo(0.7984 * 0.65, 12);
  });
});

describe("what a reading result carries out", () => {
  const warm = warmedVolume(Array(20).fill(0.25));

  it("reports the divergence of the next state, not of the one handed in", () => {
    const inflated = { ...warm, fastM2: 1e6, slowM2: 0 };
    const r = tagOne({ observation: bigPayment, baseline: inflated });
    expect(r.timescaleDivergence).toBe(timescaleDivergence(r.baseline!, volumeFloor));
    expect(r.timescaleDivergence).not.toBe(timescaleDivergence(inflated, volumeFloor));
  });

  // The standing ruling: a surprise the arithmetic cannot produce is a
  // refusal, and a refusal is never turned into the absence of a tag. The
  // smallest positive floor under a deviation near the largest double is a
  // quotient that does not fit, and surpriseOf refuses it; it must leave
  // here as that refusal, not as a cold verdict with the baseline updated.
  it("lets a surprise refusal out as a refusal, not as no decision", () => {
    const tinyFloor = {
      ...policy,
      scaleFloor: { ...policy.scaleFloor, byAspect: { ...policy.scaleFloor.byAspect, "volume/amount/USDC/in": 5e-324 } },
    };
    expect(() => tagOne({
      observation: bigPayment, baseline: warm, policy: tinyFloor,
    })).toThrow(/does not fit a double$/);
  });
});

describe("tagObservation's entry and routing", () => {
  const at = new Date("2026-09-07T03:45:00.000Z");
  const farDust = event("cluster_proximity", "dust_received", { clusterId: "cluster:dust-fleet-0031", hops: 9, amount: "0.0000100" }, "2026-09-07T03:41:12.000Z");

  // The per-reading step repeats these three checks, so on a readable
  // observation the entry's own are invisible. They are not redundant: the observation is
  // read before any reading is tagged, and an unreadable payload would
  // otherwise be the first thing refused. The entry refuses the policy, the
  // calibration and the instant before it reads anything, and this holds
  // that order by pairing each with a payload that cannot be read.
  it("refuses a policy, a calibration or an instant it cannot use before reading the observation", () => {
    const unreadable = event("cluster_proximity", "dust_received", {}, "2026-09-07T03:41:12.000Z");
    expect(() => tagObservation({ namespaceId: ns, observation: unreadable, at, contexts: new Map(), policy, calibration }))
      .toThrow(/^cluster_proximity payload cannot be read/);
    expect(() => tagObservation({ namespaceId: ns, observation: unreadable, at, contexts: new Map(), policy: { ...policy, version: "" }, calibration }))
      .toThrow(/^policy\.version must not be empty$/);
    expect(() => tagObservation({ namespaceId: ns, observation: unreadable, at, contexts: new Map(), policy, calibration: { ...calibration, version: "" } }))
      .toThrow(/^calibration\.version must not be empty$/);
    expect(() => tagObservation({ namespaceId: ns, observation: unreadable, at: new Date("no"), contexts: new Map(), policy, calibration }))
      .toThrow(/^at must be a valid date$/);
  });

  it("names the versions it was given on the result", () => {
    const r = tagObservation({
      namespaceId: ns, observation: farDust, at, contexts: new Map(),
      policy: { ...policy, version: "policy-v0-shadow" }, calibration: { ...calibration, version: "calibration-v0-shadow" },
    });
    expect(r).toMatchObject({ policyVersion: "policy-v0-shadow", calibrationVersion: "calibration-v0-shadow" });
  });

  it("hands each reading the live tag of its own aspect", () => {
    const hops = warmed("cluster_proximity", "hops", Array(12).fill(2));
    const r = tagObservation({
      namespaceId: ns, observation: farDust, at,
      contexts: new Map([["hops", { baseline: hops, liveTag: live() }]]),
      policy, calibration,
    });
    const byAspect = new Map(r.readings.map((x) => [x.reading.aspect, x]));
    expect(byAspect.get("hops")?.decision).toMatchObject({ kind: "refresh", refreshCount: 1, aspect: "hops" });
    expect(byAspect.get("amount")?.decision).toBeNull();
  });

  // Spec section 3: the aspect is derived from the observation and never
  // supplied by a caller, so an indexer cannot split or merge a history by
  // choosing a string. The only way in is this function, and it reads the
  // observation; a context the caller keys under some other aspect is not
  // a reading and produces nothing. Before this was pinned, a public
  // per-reading function took the reading as an argument, and a price
  // observation handed a hand-built volume reading came back as a volume
  // tag stamped with the price event's instant.
  it("derives the readings from the observation, and a context for an aspect it does not read into produces nothing", () => {
    const quote = event("price", "quote", { quoted: "0.25", unit: "USDC" }, "2026-09-21T08:00:00.412Z");
    const volumeWarm = warmedVolume(Array(20).fill(0.25));
    const r = tagObservation({
      namespaceId: ns, observation: quote, at,
      contexts: new Map([["amount/USDC/in", { baseline: volumeWarm, liveTag: live() }]]),
      policy, calibration,
    });
    expect(r.readings.map((x) => x.reading)).toEqual(readObservation(quote));
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0]!.reading).toEqual({ kind: "continuous", channel: "price", aspect: "quoted/USDC", value: 0.25 });
    expect(r.readings[0]!.verdict).toEqual({ kind: "cold", count: 0, minObservations: policy.minObservations });
    expect(r.readings[0]!.decision).toBeNull();
    expect(r.readings.some((x) => x.reading.channel === "volume")).toBe(false);
  });
});
