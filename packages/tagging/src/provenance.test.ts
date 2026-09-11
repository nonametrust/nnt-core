import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CHANNELS } from "@nonametrust/schema";
import {
  CALIBRATION_V0,
  MEASURED_CHANNELS,
  assertCalibration,
  channelWeight,
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
    expect(precisionAtEvenPrior(14, 100, 0, 200)).toBe((15 / 102) / (15 / 102 + 1 / 202));
    expect(precisionAtEvenPrior(17, 100, 7, 200)).toBe((18 / 102) / (18 / 102 + 8 / 202));
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
});

describe("channelWeight", () => {
  it("returns the calibrated weight for a measured channel", () => {
    expect(channelWeight("volume", CALIBRATION_V0, POLICY_V0)).toBe(CALIBRATION_V0.channelWeights.volume.weight);
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

describe("policy", () => {
  it("validates as shipped", () => {
    expect(() => assertPolicy(POLICY_V0)).not.toThrow();
    expect(POLICY_V0.version).toBe("policy-v0");
  });

  it("refuses a value the arithmetic cannot use", () => {
    const cases: Array<Partial<typeof POLICY_V0>> = [
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
