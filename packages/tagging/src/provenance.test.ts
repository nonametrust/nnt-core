import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CHANNELS } from "@nonametrust/schema";
import {
  CALIBRATION_V0,
  MEASURED_CHANNELS,
  assertCalibration,
  channelWeight,
  channelWeightWithSource,
  precisionAtEvenPrior,
} from "./calibration.js";
import { POLICY_V0, assertPolicy, scaleFloorFor } from "./policy.js";
import { CONTINUOUS_CHANNELS } from "./reading.js";

const DAY = 24 * 60 * 60 * 1000;
const study = fileURLToPath(new URL("../fixtures/study/", import.meta.url));

function rows(file: string): Record<string, string>[] {
  const lines = readFileSync(study + file, "utf8").trim().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

// Each calibration entry names the study result it comes from, and this
// suite recomputes it from the vendored aggregate. A weight edited by hand
// fails here; a weight that moves because the audit moved a rate is changed
// in the fixture first, and the constant second.
describe("calibration against the study", () => {
  const table = rows("signal_table_30d.csv");

  it("carries a weight for every measured channel, and the signal it was measured as", () => {
    expect(Object.keys(CALIBRATION_V0.channelWeights).sort()).toEqual([...MEASURED_CHANNELS].sort());
    for (const c of MEASURED_CHANNELS) {
      const entry = CALIBRATION_V0.channelWeights[c];
      expect(table.some((r) => r.signal === entry.signal), `${c}: ${entry.signal} is not in the table`).toBe(true);
    }
  });

  it("derives each weight as precision at an even prior from the 30-day rates, add-one smoothed", () => {
    for (const c of MEASURED_CHANNELS) {
      const entry = CALIBRATION_V0.channelWeights[c];
      const row = table.find((r) => r.signal === entry.signal)!;
      const victimN = Number(row.victim_n);
      const controlN = Number(row.control_n);
      const victimHits = Math.round(Number(row.victim_rate) * victimN);
      const controlHits = Math.round(Number(row.control_rate) * controlN);
      expect({ victimHits, victimN, controlHits, controlN }, c).toEqual({
        victimHits: entry.victimHits, victimN: entry.victimN,
        controlHits: entry.controlHits, controlN: entry.controlN,
      });
      expect(entry.weight, c).toBeCloseTo(
        precisionAtEvenPrior(victimHits, victimN, controlHits, controlN), 4,
      );
    }
  });

  // The test above takes precisionAtEvenPrior as its oracle, so a different
  // smoothing with the constants regenerated to match would pass it. The
  // formula is pinned here by hand on two rows, one with an empty control
  // arm and one without: one added to each count, two to each arm.
  it("smooths by adding one carrier and one non-carrier to each arm, and nothing else", () => {
    expect(precisionAtEvenPrior(14, 100, 0, 200)).toBeCloseTo((15 / 102) / (15 / 102 + 1 / 202), 12);
    expect(precisionAtEvenPrior(17, 100, 7, 200)).toBeCloseTo((18 / 102) / (18 / 102 + 8 / 202), 12);
  });

  // The audit's diagnosis: a rule that ORs channels inherits the broad
  // channels' base rate. Weighting by precision puts the narrow channels
  // above the broad ones, which weighting by raw difference would not.
  it("ranks the narrow channels above the broad ones, unlike the raw difference", () => {
    const w = CALIBRATION_V0.channelWeights;
    expect(w.volume.weight).toBeGreaterThan(w.protocol.weight);
    expect(w.cluster_proximity.weight).toBeGreaterThan(w.protocol.weight);
    expect(w.address_integrity.weight).toBeGreaterThan(w.content.weight);
    const difference = (c: (typeof MEASURED_CHANNELS)[number]) =>
      w[c].victimHits / w[c].victimN - w[c].controlHits / w[c].controlN;
    expect(difference("protocol")).toBeGreaterThan(difference("volume"));
  });

  it("does not claim a test payment is never innocent", () => {
    expect(CALIBRATION_V0.channelWeights.volume.weight).toBeLessThan(1);
    expect(precisionAtEvenPrior(14, 100, 0, 200)).toBeLessThan(1);
  });

  it("names the behaviour-shift signal nowhere, since it had no control arm", () => {
    for (const c of MEASURED_CHANNELS) {
      expect(CALIBRATION_V0.channelWeights[c].signal).not.toBe("counterparty_behavior_shift");
    }
  });

  // any_signal is in the vendored table and recomputes cleanly, so an entry
  // citing it would pass the derivation test; and two channels citing one
  // signal would too. Five distinct signals, none of them the OR row.
  it("cites five distinct signals, and the pooled any_signal row is not one of them", () => {
    const signals = MEASURED_CHANNELS.map((c) => CALIBRATION_V0.channelWeights[c].signal);
    expect(new Set(signals.filter((s) => s !== "any_signal")).size).toBe(MEASURED_CHANNELS.length);
  });

  it("derives the half-life as the pooled median distance, rounded to a whole day", () => {
    const hist = rows("distance_hist.csv").map((r) => ({
      day: Number(r.days_before_loss), count: Number(r.signal_count),
    }));
    const total = hist.reduce((s, h) => s + h.count, 0);
    const quantile = (q: number): number => {
      let cum = 0;
      for (const h of hist) {
        if (cum + h.count >= q * total) return h.day + (q * total - cum) / h.count;
        cum += h.count;
      }
      throw new Error("quantile past the histogram");
    };
    // The README's own figure, as a check that the vendored file is the
    // study's: the 80th percentile at 23.4 days.
    expect(quantile(0.8)).toBeCloseTo(23.4, 1);
    expect(CALIBRATION_V0.halfLifeMs).toBe(Math.round(quantile(0.5)) * DAY);
    expect(CALIBRATION_V0.halfLifeMs).toBe(14 * DAY);
  });

  it("validates as shipped, and refuses a weight outside the unit interval", () => {
    expect(() => assertCalibration(CALIBRATION_V0)).not.toThrow();
    const broken = {
      ...CALIBRATION_V0,
      channelWeights: {
        ...CALIBRATION_V0.channelWeights,
        volume: { ...CALIBRATION_V0.channelWeights.volume, weight: 1.5 },
      },
    };
    expect(() => assertCalibration(broken)).toThrow(RangeError);
    expect(() => assertCalibration({ ...CALIBRATION_V0, halfLifeMs: 0 })).toThrow(RangeError);
  });

  it("refuses an empty version, signal or source, since a result cites them", () => {
    const withVolume = (over: Partial<(typeof CALIBRATION_V0.channelWeights)["volume"]>) => ({
      ...CALIBRATION_V0,
      channelWeights: { ...CALIBRATION_V0.channelWeights, volume: { ...CALIBRATION_V0.channelWeights.volume, ...over } },
    });
    expect(() => assertCalibration({ ...CALIBRATION_V0, version: "" })).toThrow(RangeError);
    expect(() => assertCalibration({ ...CALIBRATION_V0, halfLifeSource: "" })).toThrow(RangeError);
    expect(() => assertCalibration(withVolume({ signal: "" }))).toThrow(RangeError);
    expect(() => assertCalibration(withVolume({ source: "" }))).toThrow(RangeError);
  });
});

describe("channelWeight", () => {
  // Every measured channel, not one: a dispatch that recognised volume alone
  // would score the other four with the policy's uncalibrated weight while
  // the result still named calibration-v0.
  it("returns the calibrated weight for every measured channel", () => {
    for (const c of MEASURED_CHANNELS) {
      expect(channelWeight(c, CALIBRATION_V0, POLICY_V0), c).toBe(CALIBRATION_V0.channelWeights[c].weight);
    }
  });

  // The complement is closed. A channel added to the schema later fails here
  // until it is either measured or explicitly admitted as unmeasured.
  it("leaves exactly latency and price to the policy", () => {
    const unmeasured = CHANNELS.filter((c) => !(MEASURED_CHANNELS as readonly string[]).includes(c));
    expect([...unmeasured].sort()).toEqual(["latency", "price"]);
  });

  // Latency and price were not in the study. Their weight is a policy
  // number, not a calibration one, because calibration cannot carry what
  // was not measured.
  it("takes the policy's unmeasured weight for latency and price, and it is no stronger than the weakest measured", () => {
    const weakest = Math.min(...MEASURED_CHANNELS.map((c) => CALIBRATION_V0.channelWeights[c].weight));
    for (const c of ["latency", "price"] as const) {
      expect(channelWeight(c, CALIBRATION_V0, POLICY_V0)).toBe(POLICY_V0.unmeasuredChannelWeight);
      expect(channelWeight(c, CALIBRATION_V0, POLICY_V0)).toBeLessThanOrEqual(weakest);
    }
  });

  it("is defined for every channel and lies in (0, 1]", () => {
    for (const c of CHANNELS) {
      const w = channelWeight(c, CALIBRATION_V0, POLICY_V0);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

// The weight's source travels with the weight, from the one predicate that
// chooses it. The decision names the source because the policy's unmeasured
// weight equals the weakest measured one and every decision names the
// calibration version, so the number and the version cannot tell a latency
// decision from a content one. tag.test.ts holds that the decision carries
// what this returns; this holds what it returns.
describe("channelWeightWithSource", () => {
  it("says calibration for exactly the measured channels and policy for the rest", () => {
    for (const c of CHANNELS) {
      const measured = (MEASURED_CHANNELS as readonly string[]).includes(c);
      expect(channelWeightWithSource(c, CALIBRATION_V0, POLICY_V0).source, c).toBe(measured ? "calibration" : "policy");
    }
  });

  it("returns the weight channelWeight returns, for every channel, so the two cannot drift", () => {
    for (const c of CHANNELS) {
      expect(channelWeightWithSource(c, CALIBRATION_V0, POLICY_V0).weight, c).toBe(channelWeight(c, CALIBRATION_V0, POLICY_V0));
    }
  });

  // The policy's weight is deliberately equal to the weakest measured one, so
  // the number cannot carry the distinction; only the source can.
  it("returns the same number with a different source for latency and for content", () => {
    const latency = channelWeightWithSource("latency", CALIBRATION_V0, POLICY_V0);
    const content = channelWeightWithSource("content", CALIBRATION_V0, POLICY_V0);
    expect(latency.weight).toBe(content.weight);
    expect(latency.source).not.toBe(content.source);
  });
});

describe("policy", () => {
  it("validates as shipped", () => {
    expect(() => assertPolicy(POLICY_V0)).not.toThrow();
    expect(POLICY_V0.version).toBe("policy-v0");
  });

  it("refuses a value the arithmetic cannot use", () => {
    const cases: Array<Partial<typeof POLICY_V0>> = [
      { version: "" },
      { minObservations: 0 },
      { winsorMadMultiple: 0 },
      { fastAlpha: 1 },
      { slowAlpha: 0 },
      { fastAlpha: 0.01, slowAlpha: 0.2 },
      { thresholdBase: -1 },
      { noiseCoefficient: Number.NaN },
      { surpriseScale: 0 },
      { categoricalBase: 1.5 },
      { refreshIncrement: -0.1 },
      { g0Ceiling: 0 },
      { unmeasuredChannelWeight: 0 },
      { scaleFloor: { ...POLICY_V0.scaleFloor, byChannel: { ...POLICY_V0.scaleFloor.byChannel, price: 0 } } },
    ];
    for (const over of cases) {
      expect(() => assertPolicy({ ...POLICY_V0, ...over }), JSON.stringify(over)).toThrow(RangeError);
    }
  });

  it("has a floor for every continuous channel, and an aspect override wins over the channel default", () => {
    for (const c of CONTINUOUS_CHANNELS) {
      expect(scaleFloorFor(POLICY_V0, c, "anything")).toBe(POLICY_V0.scaleFloor.byChannel[c]);
    }
    expect(scaleFloorFor(POLICY_V0, "volume", "amount/USDC/in")).toBe(0.05);
    expect(scaleFloorFor(POLICY_V0, "volume", "amount/XLM/in")).toBe(POLICY_V0.scaleFloor.byChannel.volume);
  });

  it("has a fleet prior for every continuous channel and for no other", () => {
    expect(Object.keys(POLICY_V0.fleetPrior).sort()).toEqual([...CONTINUOUS_CHANNELS].sort());
  });
});
