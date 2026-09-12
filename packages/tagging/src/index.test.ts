import { describe, it, expect } from "vitest";
import * as tagging from "./index.js";
import type {
  AspectContext,
  AspectShape,
  BaselineState,
  Calibration,
  CategoricalChannel,
  CategoricalReading,
  ChannelWeight,
  ClipRule,
  ContinuousChannel,
  ContinuousReading,
  LiveTagInput,
  MeasuredChannel,
  Policy,
  Reading,
  ReadingResult,
  SurpriseVerdict,
  TagDecision,
  TaggingInput,
  TaggingResult,
  TagRefresh,
  Timescale,
  TimescalePairs,
  WeightEntry,
  WeightSource,
} from "./index.js";

// Every other test in this package imports the module it exercises, so the
// entry point was the one file nothing read: a re-export dropped or misnamed
// in index.ts would fail no test here and the first consumer of the
// package's `main`. This file is that consumer. The set of runtime names is
// held exactly, so a name that leaves the surface and a name that joins it
// unannounced both fail here; the types are used once each in a type
// position, so a type dropped from the surface fails `pnpm typecheck` here.

const RUNTIME_SURFACE = [
  // reading.ts
  "CONTINUOUS_CHANNELS", "CATEGORICAL_CHANNELS", "ASPECT_SHAPES", "shapePattern", "readObservation",
  // policy.ts
  "POLICY_V0", "requireMinObservations", "assertPolicy", "scaleFloorFor",
  // calibration.ts
  "MEASURED_CHANNELS", "precisionAtEvenPrior", "CALIBRATION_V0", "assertCalibration",
  "channelWeightWithSource", "channelWeight",
  // baseline.ts
  "emptyBaseline", "assertBaseline", "winsorize", "updateBaseline",
  // scale.ts
  "robustScale", "surpriseOf",
  // timescales.ts
  "assertTimescales", "timescaleStep", "timescaleDivergence",
  // g0.ts
  "uncertaintyOf", "calibrateG0",
  // threshold.ts
  "noiseOf", "shrinkNoise", "tagThreshold", "judgeSurprise",
  // tag.ts
  "refreshTag", "tagObservation",
] as const;

interface TypeSurface {
  reading: [ContinuousChannel, CategoricalChannel, ContinuousReading, CategoricalReading, Reading, AspectShape];
  policy: [Policy];
  calibration: [MeasuredChannel, WeightEntry, Calibration, WeightSource, ChannelWeight];
  baseline: [BaselineState, ClipRule];
  timescales: [Timescale, TimescalePairs];
  threshold: [SurpriseVerdict];
  tag: [LiveTagInput, TagRefresh, TagDecision, ReadingResult, AspectContext, TaggingInput, TaggingResult];
}

describe("the public surface", () => {
  it("exports exactly the runtime names the modules declare, through the entry point", () => {
    expect(Object.keys(tagging).sort()).toEqual([...RUNTIME_SURFACE].sort());
  });

  it("exports each function as a function and each constant as the module's own value", () => {
    for (const name of RUNTIME_SURFACE) {
      const value = tagging[name];
      expect(value, name).toBeDefined();
    }
    expect(typeof tagging.tagObservation).toBe("function");
    expect(typeof tagging.readObservation).toBe("function");
    expect(tagging.POLICY_V0.version).toBe("policy-v0");
    expect(tagging.CALIBRATION_V0.version).toBe("calibration-v0");
    expect(tagging.CONTINUOUS_CHANNELS).toHaveLength(4);
    expect(tagging.CATEGORICAL_CHANNELS).toHaveLength(3);
    expect(tagging.MEASURED_CHANNELS).toHaveLength(5);
  });

  it("exports every type the modules declare", () => {
    // The types are checked by the compiler, above and in TypeSurface; the
    // runtime assertion is that this test ran at all.
    const reachable: TypeSurface | undefined = undefined;
    expect(reachable).toBeUndefined();
  });

  it("composes from the entry point alone, end to end on one observation", () => {
    // A consumer that only has `main`: read an observation, tag it against
    // nothing, and get a categorical decision that names both versions.
    const observation = {
      schemaVersion: "0.1.0",
      namespace: { kind: "endpoint", id: "https://data.example/x402" },
      channel: "address_integrity",
      evidenceKind: "event",
      kind: "payment_address_changed",
      observedAt: "2026-09-12T08:14:00.000Z",
      source: { producer: "x402-gateway", producerVersion: "0.1.0", ref: "req:surface", fetchedAt: "2026-09-12T08:14:00.000Z" },
      payload: { previous: "GOLDADDRESS", current: "GNEWADDRESS" },
    } as const;
    const [reading] = tagging.readObservation(observation);
    expect(reading).toEqual({ kind: "categorical", channel: "address_integrity", aspect: "transition" });
    const result = tagging.tagObservation({
      namespaceId: "11111111-1111-4111-8111-111111111111",
      observation,
      at: new Date("2026-09-12T08:14:15.000Z"),
      contexts: new Map(),
      policy: tagging.POLICY_V0,
      calibration: tagging.CALIBRATION_V0,
    });
    expect(result.readings[0]?.decision).toMatchObject({
      kind: "new", channel: "address_integrity", aspect: "transition",
      policyVersion: "policy-v0", calibrationVersion: "calibration-v0", weightSource: "calibration",
    });
    expect(result.readings[0]?.decision?.taggedAt.toISOString()).toBe("2026-09-12T08:14:00.000Z");
  });
});
