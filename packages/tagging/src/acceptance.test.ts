import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { validateObservation, type Observation } from "@nonametrust/schema";
import type { BaselineState } from "./baseline.js";
import { CALIBRATION_V0, MEASURED_CHANNELS, type Calibration } from "./calibration.js";
import { POLICY_V0, scaleFloorFor, type Policy } from "./policy.js";
import { readObservation } from "./reading.js";
import { robustScale } from "./scale.js";
import {
  tagObservation,
  type AspectContext,
  type TagDecision,
  type TaggingResult,
} from "./tag.js";

// The six acceptance criteria of M2, from the design's section 14:
//
//   1. No tag is produced below the minimum observation count.
//   2. A repeated deviation refreshes rather than stacks.
//   3. One extreme observation cannot move a baseline past its bound.
//   4. A state observation never yields two tags inside one window.
//   5. No surprise is ever infinite or NaN, at any MAD including zero.
//   6. The tagging and store baseline shapes agree field for field.
//
// The per-module suites hold each in isolation: 1 in threshold.test.ts, 2
// and 4 in tag.test.ts, 3 in baseline.test.ts, 5 in scale.test.ts, 6 in
// gates/baseline-shape.test.ts. This file runs them together on one corpus,
// in the order the engine will, so that a criterion cannot be met by a
// component that no longer composes with its neighbours. The clock is a
// column of the corpus: twenty-two simulated days run in milliseconds.

const policy = POLICY_V0;
const calibration = CALIBRATION_V0;
const namespaceId = "11111111-1111-4111-8111-111111111111";
const fixtures = fileURLToPath(new URL("../../schema/fixtures/", import.meta.url));

// The engine's clock reads a little after each event's instant, as it would
// on a synchronous path where the ledger closes and is then read. The tag's
// instant must be the event's and not the call's, and with the two equal
// nothing could tell them apart; fifteen seconds is enough to tell.
const ENGINE_LAG_MS = 15_000;

function fixture(rel: string): Observation {
  const raw = JSON.parse(readFileSync(join(fixtures, rel), "utf8")) as unknown;
  const result = validateObservation(raw);
  if (!result.ok) throw new Error(`${rel}: ${result.errors.join("; ")}`);
  return result.value;
}

/** An event fixture re-dated to `instant` with a source reference of its own. */
function eventAt(o: Observation, instant: string, ref: string, payload?: Record<string, unknown>): Observation {
  return {
    ...o,
    observedAt: instant,
    source: { ...o.source, ref, fetchedAt: instant },
    ...(payload === undefined ? {} : { payload }),
  } as Observation;
}

const day = (d: number, time: string): string => `2026-09-${String(d).padStart(2, "0")}T${time}`;
const readAfter = (instant: string): Date => new Date(new Date(instant).getTime() + ENGINE_LAG_MS);
const AMOUNTS = ["0.2500000", "0.2600000", "0.2400000"];
const QUOTES = ["0.25", "0.26", "0.24"];

interface Entry {
  day: number;
  at: Date;
  observation: Observation;
}

function corpus(): Entry[] {
  const volume = fixture("volume.json");
  const price = fixture("price.json");
  const trustline = fixture("protocol.json");
  const away = fixture("day-twelve/address-moved-away.json");
  const back = fixture("day-twelve/address-moved-back.json");
  const entries: Entry[] = [];
  for (let d = 1; d <= 22; d++) {
    const morning = day(d, "08:00:05.000Z");
    entries.push({
      day: d, at: readAfter(morning),
      observation: eventAt(volume, morning, `op:pay:${d}`, { amount: AMOUNTS[d % 3]!, assetCode: "USDC", direction: "in" }),
    });
    // A fixed subscription, the same five XLM every morning: an aspect whose
    // spread is exactly zero for the whole corpus.
    entries.push({
      day: d, at: readAfter(morning),
      observation: eventAt(volume, morning, `op:sub:${d}`, { amount: "5.0000000", assetCode: "XLM", direction: "in" }),
    });
    const quoteAt = day(d, "08:00:00.412Z");
    entries.push({
      day: d, at: readAfter(quoteAt),
      observation: eventAt(price, quoteAt, `req:quote:${d}`, { quoted: d === 21 ? "500" : QUOTES[d % 3]!, unit: "USDC" }),
    });
    // The standing condition, re-evaluated each morning. The observation is
    // the same one; a state is not re-emitted, it holds. It has no instant
    // of its own, so the call's is what stamps it.
    entries.push({ day: d, at: new Date(morning), observation: trustline });
    if (d === 5) {
      const at = day(5, "08:30:00.000Z");
      entries.push({
        day: d, at: readAfter(at),
        observation: eventAt(volume, at, "op:pay:early-large", { amount: "500.0000000", assetCode: "USDC", direction: "in" }),
      });
    }
    if (d === 12) {
      entries.push({ day: d, at: readAfter("2026-09-12T08:14:00.000Z"), observation: away });
      entries.push({ day: d, at: readAfter("2026-09-12T16:47:00.000Z"), observation: back });
    }
  }
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

interface HeldTag {
  g0: number;
  taggedAt: Date;
  refreshCount: number;
  saturationState: "open" | "saturated";
}

// The caller's arithmetic, mirrored: strengthAt lives in packages/store. A
// fresh tag's suppression factor is one, so the exponent is the elapsed time
// over the half-life and nothing else.
function decayedAt(tag: HeldTag, at: Date, halfLifeMs: number): number {
  const elapsed = at.getTime() - tag.taggedAt.getTime();
  if (elapsed <= 0) return tag.g0;
  return tag.g0 * Math.pow(0.5, elapsed / halfLifeMs);
}

interface Step extends Entry {
  result: TaggingResult;
}

interface InForce {
  policy: Policy;
  calibration: Calibration;
}

/**
 * The loop the engine will run: for each entry, fetch the baseline and the
 * live tag for every aspect the observation reads into, tag, and store what
 * came back. Baselines and tags are keyed by channel and aspect within the
 * one namespace.
 */
function run(inForce: InForce = { policy, calibration }): Step[] {
  const baselines = new Map<string, BaselineState>();
  const tags = new Map<string, HeldTag>();
  const steps: Step[] = [];
  for (const entry of corpus()) {
    const contexts = new Map<string, AspectContext>();
    for (const r of readObservation(entry.observation)) {
      const key = `${r.channel}/${r.aspect}`;
      const tag = tags.get(key);
      contexts.set(r.aspect, {
        baseline: baselines.get(key) ?? null,
        liveTag: tag === undefined
          ? null
          : { ...tag, decayedStrength: decayedAt(tag, entry.at, inForce.calibration.halfLifeMs) },
      });
    }
    const result = tagObservation({
      namespaceId, observation: entry.observation, at: entry.at, contexts,
      policy: inForce.policy, calibration: inForce.calibration,
    });
    for (const x of result.readings) {
      const key = `${x.reading.channel}/${x.reading.aspect}`;
      if (x.baseline !== null) baselines.set(key, x.baseline);
      const d = x.decision;
      if (d !== null) {
        tags.set(key, {
          g0: d.g0, taggedAt: d.taggedAt,
          refreshCount: d.kind === "refresh" ? d.refreshCount : 0,
          saturationState: d.kind === "refresh" ? d.saturationState : "open",
        });
      }
    }
    steps.push({ ...entry, result });
  }
  return steps;
}

interface Made {
  day: number;
  channel: string;
  aspect: string;
  decision: TagDecision;
}

function decisionsOf(steps: Step[]): Made[] {
  return steps.flatMap((s) =>
    s.result.readings
      .filter((r) => r.decision !== null)
      .map((r) => ({ day: s.day, channel: r.reading.channel, aspect: r.reading.aspect, decision: r.decision! })),
  );
}

/** `day:channel:kind` per decision, sorted, the one-line shape of a run. */
function summaryOf(made: Made[]): string[] {
  return made.map((m) => `${m.day}:${m.channel}:${m.decision.kind}`).sort();
}

/** The store's check constraints on the baseline table, restated in value. */
function satisfiesStoreChecks(s: BaselineState): boolean {
  const finite = (x: number): boolean => Number.isFinite(x);
  return (
    Number.isSafeInteger(s.count) && s.count >= 0 &&
    finite(s.mean) && finite(s.m2) && s.m2 >= 0 &&
    (s.medianEst === null || finite(s.medianEst)) &&
    (s.madEst === null || (finite(s.madEst) && s.madEst >= 0)) &&
    (s.medianEst === null) === (s.madEst === null) &&
    finite(s.fastMean) && finite(s.fastM2) && s.fastM2 >= 0 &&
    finite(s.slowMean) && finite(s.slowM2) && s.slowM2 >= 0
  );
}

const steps = run();
const made = decisionsOf(steps);
const priceSteps = steps.filter((s) => s.observation.channel === "price");

describe("criterion 1: no tag below the minimum observation count", () => {
  it("makes no continuous decision on a cold verdict anywhere in the corpus", () => {
    for (const s of steps) {
      for (const r of s.result.readings) {
        if (r.reading.kind !== "continuous") continue;
        if (r.decision !== null) expect(r.verdict?.kind, `day ${s.day} ${r.reading.aspect}`).toBe("measured");
      }
    }
  });

  it("leaves the day-five large payment untagged, since five payments are not a history", () => {
    const early = steps.find((s) => s.observation.source.ref === "op:pay:early-large")!;
    const [reading] = early.result.readings;
    expect(reading?.verdict).toEqual({ kind: "cold", count: 5, minObservations: policy.minObservations });
    expect(reading?.decision).toBeNull();
  });

  it("is cold on price through day ten and measured from day eleven", () => {
    for (const s of priceSteps) {
      const kind = s.result.readings[0]!.verdict?.kind;
      expect(kind, `day ${s.day}`).toBe(s.day <= policy.minObservations ? "cold" : "measured");
    }
  });

  it("opens its first continuous tag on day twenty-one and not before", () => {
    const continuous = made.filter((m) => m.channel === "price" || m.channel === "volume");
    expect(continuous.length).toBeGreaterThan(0);
    expect(continuous[0]!.day).toBe(21);
    expect(continuous[0]!.aspect).toBe("quoted/USDC");
  });
});

describe("criterion 2: a repeated deviation refreshes rather than stacks", () => {
  const address = made.filter((m) => m.channel === "address_integrity");

  it("turns the day-twelve change and revert into one tag and one refresh", () => {
    expect(address.map((m) => m.decision.kind)).toEqual(["new", "refresh"]);
    const [opened, refreshed] = address.map((m) => m.decision);
    if (opened?.kind !== "new" || refreshed?.kind !== "refresh") throw new Error("expected new then refresh");
    expect(opened.taggedAt.toISOString()).toBe("2026-09-12T08:14:00.000Z");
    expect(refreshed.taggedAt.toISOString()).toBe("2026-09-12T16:47:00.000Z");
    expect(refreshed.refreshCount).toBe(1);
    expect(refreshed.saturationState).toBe("open");
    const decayed = decayedAt({ ...opened, refreshCount: 0, saturationState: "open" }, refreshed.taggedAt, calibration.halfLifeMs);
    // Eight hours of decay leave the opened strength below the fresh g0, so
    // the maximum is the fresh g0 here; tag.test.ts holds the other operand.
    expect(decayed).toBeLessThan(opened.g0);
    expect(refreshed.g0).toBeCloseTo(Math.max(decayed, opened.g0) + policy.refreshIncrement, 12);
    expect(refreshed.g0).toBeLessThan(decayed + opened.g0);
  });

  it("carries the original instant on the first decision, the day-twelve date the brief will show", () => {
    expect(address[0]!.decision.taggedAt.toISOString().slice(0, 10)).toBe("2026-09-12");
  });
});

describe("criterion 3: one extreme observation cannot move a baseline past its bound", () => {
  const floor = scaleFloorFor(policy, "price", "quoted/USDC");
  const before = priceSteps.find((s) => s.day === 20)!.result.readings[0]!.baseline!;
  const at21 = priceSteps.find((s) => s.day === 21)!.result.readings[0]!;
  const after = at21.baseline!;

  it("tags the five-hundred-unit quote against twenty ordinary ones", () => {
    expect(at21.decision?.kind).toBe("new");
    if (at21.verdict?.kind === "measured") {
      expect(at21.verdict.crosses).toBe(true);
      expect(at21.verdict.surprise).toBeGreaterThan(1000);
    }
  });

  it("moves the location and the spread by no more than the band over the count", () => {
    const bound = policy.winsorMadMultiple * robustScale(before, floor) / (before.count + 1);
    expect(Math.abs(after.medianEst! - before.medianEst!)).toBeLessThanOrEqual(bound + 1e-12);
    expect(Math.abs(after.madEst! - before.madEst!)).toBeLessThanOrEqual(bound + 1e-12);
    expect(Math.abs(after.mean - before.mean)).toBeLessThanOrEqual(bound + 1e-12);
    expect(Math.abs(after.medianEst! - 0.25)).toBeLessThan(0.02);
  });

  it("finds the next ordinary morning unsurprising", () => {
    const at22 = priceSteps.find((s) => s.day === 22)!.result.readings[0]!;
    expect(at22.decision).toBeNull();
    if (at22.verdict?.kind !== "measured") throw new Error("expected measured");
    expect(at22.verdict.crosses).toBe(false);
    expect(Math.abs(at22.verdict.surprise)).toBeLessThan(1);
  });
});

describe("criterion 4: a state observation never yields two tags inside one window", () => {
  const trustline = made.filter((m) => m.channel === "protocol");

  it("opens the trustline tag once, on day one, and refreshes it on every later morning", () => {
    expect(trustline).toHaveLength(22);
    expect(trustline.map((m) => m.decision.kind)).toEqual(["new", ...Array(21).fill("refresh")]);
    const last = trustline[21]!.decision;
    if (last.kind !== "refresh") throw new Error("expected refresh");
    expect(last.refreshCount).toBe(21);
  });

  it("carries the instant forward each morning, so the seven-day window sees one tag", () => {
    let previous = 0;
    for (const m of trustline) {
      expect(m.decision.taggedAt.getTime()).toBeGreaterThan(previous);
      previous = m.decision.taggedAt.getTime();
    }
    const inWeek = trustline.filter((m) => m.day >= 15 && m.day <= 21);
    expect(inWeek.filter((m) => m.decision.kind === "new")).toHaveLength(0);
  });

  it("grows the held strength by at most the increment each morning and stays under the ceiling", () => {
    // Each morning's refresh is the maximum of the decayed strength and the
    // fresh categorical g0, plus the increment. On the second morning a day's
    // decay has taken the opened strength below the fresh g0, so the fresh
    // operand wins and the rise is the increment exactly; from the third
    // morning the decayed operand wins and the rise is the increment less a
    // day's decay, strictly positive and strictly less. Under the shipped
    // increment the walk does not reach the ceiling inside twenty-two days.
    // A walk that rose by the full increment every morning would be a
    // refresh that had forgotten to decay; one that reached the ceiling here
    // would have stacked.
    let previous = trustline[0]!.decision.g0;
    for (const m of trustline.slice(1)) {
      const d = m.decision;
      if (d.kind !== "refresh") throw new Error("expected refresh");
      expect(d.saturationState, `day ${m.day}`).toBe("open");
      expect(d.g0, `day ${m.day}`).toBeGreaterThan(previous);
      if (m.day === 2) expect(d.g0 - previous).toBeCloseTo(policy.refreshIncrement, 12);
      else expect(d.g0 - previous, `day ${m.day}`).toBeLessThan(policy.refreshIncrement);
      expect(d.g0, `day ${m.day}`).toBeLessThan(policy.g0Ceiling);
      previous = d.g0;
    }
  });
});

describe("criterion 5: no surprise is ever infinite or NaN", () => {
  it("holds on every measured verdict in the corpus, including the day-twenty-one quote", () => {
    let measured = 0;
    for (const s of steps) {
      for (const r of s.result.readings) {
        if (r.verdict?.kind !== "measured") continue;
        measured += 1;
        expect(Number.isFinite(r.verdict.surprise), `day ${s.day} ${r.reading.aspect}`).toBe(true);
        expect(Number.isFinite(r.verdict.threshold)).toBe(true);
        if (r.timescaleDivergence !== null) expect(Number.isFinite(r.timescaleDivergence)).toBe(true);
      }
    }
    expect(measured).toBeGreaterThan(20);
  });

  it("holds at a spread of exactly zero, which the fixed subscription keeps for the whole corpus", () => {
    // The five-XLM payment is the same every morning, so its spread never
    // leaves zero and every measured verdict on it divides by the floor. A
    // test that found no such verdict would be green for nothing, so the
    // count is asserted.
    let zeroSpread = 0;
    for (const s of steps) {
      for (const r of s.result.readings) {
        if (r.reading.aspect !== "amount/XLM/in" || r.verdict?.kind !== "measured") continue;
        zeroSpread += 1;
        expect(r.baseline?.madEst).toBe(0);
        expect(Number.isFinite(r.verdict.surprise)).toBe(true);
        expect(r.verdict.surprise).toBe(0);
      }
    }
    expect(zeroSpread).toBeGreaterThanOrEqual(12);
  });
});

describe("criterion 6, in value: every baseline the corpus produces is one the store admits", () => {
  it("satisfies the baseline table's checks at every step", () => {
    for (const s of steps) {
      for (const r of s.result.readings) {
        if (r.baseline === null) continue;
        expect(satisfiesStoreChecks(r.baseline), `day ${s.day} ${r.reading.aspect}`).toBe(true);
      }
    }
  });

  it("produces a g0 the tag table admits on every decision", () => {
    for (const m of made) {
      expect(Number.isFinite(m.decision.g0)).toBe(true);
      expect(m.decision.g0).toBeGreaterThanOrEqual(0);
      expect(m.decision.g0).toBeLessThanOrEqual(policy.g0Ceiling);
      if (m.decision.kind === "refresh") expect(m.decision.refreshCount).toBeGreaterThan(0);
    }
  });
});

describe("together", () => {
  it("is deterministic over the corpus, so a second run is the first", () => {
    expect(run()).toEqual(steps);
  });

  it("names the policy and calibration versions on every result and every decision", () => {
    for (const s of steps) {
      expect(s.result).toMatchObject({ policyVersion: "policy-v0", calibrationVersion: "calibration-v0" });
    }
    for (const m of made) {
      expect(m.decision).toMatchObject({ policyVersion: "policy-v0", calibrationVersion: "calibration-v0" });
    }
  });

  it("names on every decision whether the calibration or the policy produced its weight", () => {
    // Naming the calibration version is not the same as the calibration
    // having produced the number. Price is unmeasured and takes the policy's
    // weight, which equals the weakest measured one, so the version and the
    // number alone cannot tell the day-twenty-one price decision from a
    // content decision. The source can, and the corpus has one of each.
    const sources = new Set<string>();
    for (const m of made) {
      const measured = (MEASURED_CHANNELS as readonly string[]).includes(m.channel);
      expect(m.decision.weightSource, `day ${m.day} ${m.channel}`).toBe(measured ? "calibration" : "policy");
      sources.add(m.decision.weightSource);
    }
    expect([...sources].sort()).toEqual(["calibration", "policy"]);
  });

  it("scores the price decision with the policy's weight and the categorical ones with the calibration's", () => {
    // The formulas restated rather than the functions called, so that a
    // factor dropped in g0.ts or in the categorical branch is not dropped
    // from the expectation too.
    const quote = made.find((m) => m.channel === "price")!;
    const at21 = priceSteps.find((s) => s.day === 21)!.result.readings[0]!;
    if (at21.verdict?.kind !== "measured") throw new Error("expected measured");
    const count = priceSteps.find((s) => s.day === 20)!.result.readings[0]!.baseline!.count;
    const uncertainty = policy.minObservations / (count + policy.minObservations);
    const evidence = 1 - Math.exp(-Math.abs(at21.verdict.surprise) / policy.surpriseScale);
    expect(quote.decision.g0).toBeCloseTo(policy.unmeasuredChannelWeight * (1 - uncertainty) * evidence, 12);
    expect(quote.decision.surprise).toBe(at21.verdict.surprise);

    const trustline = made.find((m) => m.channel === "protocol")!.decision;
    const address = made.find((m) => m.channel === "address_integrity")!.decision;
    expect(trustline.g0).toBeCloseTo(calibration.channelWeights.protocol.weight * policy.categoricalBase, 12);
    expect(address.g0).toBeCloseTo(calibration.channelWeights.address_integrity.weight * policy.categoricalBase, 12);
    expect(trustline.surprise).toBeNull();
    expect(address.surprise).toBeNull();
  });

  it("makes exactly the decisions the scenario describes and no others", () => {
    const trustline = Array.from({ length: 22 }, (_, i) => `${i + 1}:protocol:${i === 0 ? "new" : "refresh"}`);
    expect(summaryOf(made)).toEqual(
      [...trustline, "12:address_integrity:new", "12:address_integrity:refresh", "21:price:new"].sort(),
    );
  });
});

describe("under another policy and calibration version", () => {
  // The same corpus under values no shipped field shares: a minimum count of
  // seven and an increment of 0.07. What must move, moves; what must not,
  // does not; and every result names the versions that produced it rather
  // than the ones it was written against.
  const overridden: InForce = {
    policy: { ...policy, version: "policy-v0-acceptance-override", minObservations: 7, refreshIncrement: 0.07 },
    calibration: { ...calibration, version: "calibration-v0-acceptance-override" },
  };
  const other = run(overridden);
  const otherMade = decisionsOf(other);

  it("moves the cold boundary to the overridden count", () => {
    for (const s of other.filter((s) => s.observation.channel === "price")) {
      expect(s.result.readings[0]!.verdict?.kind, `day ${s.day}`).toBe(s.day <= 7 ? "cold" : "measured");
    }
    const early = other.find((s) => s.observation.source.ref === "op:pay:early-large")!;
    expect(early.result.readings[0]!.verdict).toEqual({ kind: "cold", count: 5, minObservations: 7 });
  });

  it("names the overridden versions on every result and decision", () => {
    for (const s of other) {
      expect(s.result).toMatchObject({
        policyVersion: "policy-v0-acceptance-override", calibrationVersion: "calibration-v0-acceptance-override",
      });
    }
    for (const m of otherMade) {
      expect(m.decision).toMatchObject({
        policyVersion: "policy-v0-acceptance-override", calibrationVersion: "calibration-v0-acceptance-override",
      });
    }
  });

  it("refreshes by the overridden increment", () => {
    const [opened, refreshed] = otherMade.filter((m) => m.channel === "address_integrity").map((m) => m.decision);
    if (opened?.kind !== "new" || refreshed?.kind !== "refresh") throw new Error("expected new then refresh");
    expect(refreshed.g0).toBeCloseTo(opened.g0 + 0.07, 12);
  });

  it("saturates the trustline tag at the ceiling and holds it there, which the shipped increment never reaches", () => {
    // Section 10: a saturated tag refreshes its instant and its count but not
    // its g0, so once the walk reaches the ceiling every later morning is
    // the ceiling exactly. Asserted structurally, with the first saturated
    // morning required to exist so the loop after it is not green for
    // nothing.
    const walk = otherMade.filter((m) => m.channel === "protocol").map((m) => m.decision);
    const first = walk.findIndex((d) => d.kind === "refresh" && d.saturationState === "saturated");
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(walk.length - 1);
    for (const [i, d] of walk.entries()) {
      if (i === 0) continue;
      if (d.kind !== "refresh") throw new Error("expected refresh");
      if (i < first) {
        expect(d.saturationState, `morning ${i + 1}`).toBe("open");
        expect(d.g0, `morning ${i + 1}`).toBeLessThan(overridden.policy.g0Ceiling);
      } else {
        expect(d.saturationState, `morning ${i + 1}`).toBe("saturated");
        expect(d.g0, `morning ${i + 1}`).toBe(overridden.policy.g0Ceiling);
      }
    }
  });

  it("makes the same decisions on the same days, since none of the six criteria turns on the overridden values", () => {
    expect(summaryOf(otherMade)).toEqual(summaryOf(made));
  });
});
