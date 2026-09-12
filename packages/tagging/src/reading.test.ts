import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CHANNELS, validateObservation, type Channel, type Observation } from "@nonametrust/schema";
import {
  ASPECT_SHAPES,
  CATEGORICAL_CHANNELS,
  CONTINUOUS_CHANNELS,
  readObservation,
  shapePattern,
} from "./reading.js";

// The golden fixtures are the schema's, one per channel, and this package
// reads them from the schema package's directory rather than keeping a copy:
// a copy would drift from the contract the indexer is built against, and the
// point of reading them here is that a payload change lands in the fixture
// first and fails this suite second. fileURLToPath, not URL.pathname, for the
// reason the schema's own fixture test gives: pathname is percent-encoded.
const fixtures = fileURLToPath(new URL("../../schema/fixtures/", import.meta.url));

function fixture(channel: Channel): Observation {
  const raw = JSON.parse(readFileSync(join(fixtures, `${channel}.json`), "utf8")) as unknown;
  const result = validateObservation(raw);
  if (!result.ok) throw new Error(`${channel} fixture failed: ${result.errors.join("; ")}`);
  return result.value;
}

function withPayload(o: Observation, payload: Record<string, unknown>): Observation {
  return { ...o, payload: { ...o.payload, ...payload } };
}

describe("the channel partition", () => {
  it("covers every channel exactly once", () => {
    const union = [...CONTINUOUS_CHANNELS, ...CATEGORICAL_CHANNELS].sort();
    expect(union).toEqual([...CHANNELS].sort());
  });

  it("declares at least one aspect shape per channel", () => {
    for (const c of CHANNELS) {
      expect(ASPECT_SHAPES[c].length, `${c} has no shape`).toBeGreaterThan(0);
    }
  });

  // unitFields and quantity are declared data that nothing computes from, so
  // a shape whose braces and unitFields disagreed would be wrong and unseen.
  // Held here: the braced names in a template are its unitFields, in order,
  // and a quantity is named exactly on the continuous side of the partition.
  it("declares each shape's unitFields as the fields its template braces, and a quantity only on a continuous channel", () => {
    for (const c of CHANNELS) {
      for (const s of ASPECT_SHAPES[c]) {
        const braced = [...s.template.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
        expect(braced, `${c}: ${s.template}`).toEqual([...s.unitFields]);
        const continuous = (CONTINUOUS_CHANNELS as readonly string[]).includes(c);
        expect(s.quantity !== null, `${c}: ${s.template} quantity`).toBe(continuous);
      }
    }
  });
});

describe("readObservation", () => {
  // The derivation is total: every channel's fixture yields at least one
  // reading, and every reading's aspect matches one of the shapes declared
  // for its channel. A new payload field with no decision fails here rather
  // than silently pooling two scales.
  it("yields a reading for every channel's fixture, each matching a declared shape", () => {
    for (const c of CHANNELS) {
      const readings = readObservation(fixture(c));
      expect(readings.length, `${c} yielded no reading`).toBeGreaterThan(0);
      for (const r of readings) {
        expect(r.channel).toBe(c);
        const matched = ASPECT_SHAPES[c].some((s) => shapePattern(s).test(r.aspect));
        expect(matched, `${c}: aspect ${r.aspect} matches no declared shape`).toBe(true);
      }
    }
  });

  it("yields a continuous reading on the four continuous channels and a categorical one on the three others", () => {
    for (const c of CONTINUOUS_CHANNELS) {
      for (const r of readObservation(fixture(c))) expect(r.kind).toBe("continuous");
    }
    for (const c of CATEGORICAL_CHANNELS) {
      for (const r of readObservation(fixture(c))) expect(r.kind).toBe("categorical");
    }
  });

  // The rule stated once in the spec: the aspect never carries the value.
  it("gives two observations differing only in the quantity the same aspect", () => {
    const cases: Array<[Channel, Record<string, unknown>]> = [
      ["volume", { amount: "999.5000000" }],
      ["price", { quoted: "41" }],
      ["latency", { latencyMs: 7 }],
      ["cluster_proximity", { hops: 9, amount: "3.0000000" }],
    ];
    for (const [c, change] of cases) {
      const before = readObservation(fixture(c)).map((r) => r.aspect);
      const after = readObservation(withPayload(fixture(c), change)).map((r) => r.aspect);
      expect(after, c).toEqual(before);
    }
  });

  it("reads the value behind the aspect as a number", () => {
    const [volume] = readObservation(fixture("volume"));
    expect(volume).toMatchObject({ kind: "continuous", aspect: "amount/USDC/in", value: 0.25 });
    const [price] = readObservation(fixture("price"));
    expect(price).toMatchObject({ kind: "continuous", aspect: "quoted/USDC", value: 0.25 });
    const [latency] = readObservation(fixture("latency"));
    expect(latency).toMatchObject({ kind: "continuous", aspect: "latencyMs", value: 1840 });
  });

  // 200 XLM in, 200 XLM out and 200 USDC in are three scales, not one.
  it("separates volume by asset and by direction", () => {
    const base = fixture("volume");
    const aspects = new Set(
      [
        { assetCode: "XLM", direction: "in" },
        { assetCode: "XLM", direction: "out" },
        { assetCode: "USDC", direction: "in" },
      ].map((p) => readObservation(withPayload(base, p))[0]!.aspect),
    );
    expect(aspects.size).toBe(3);
  });

  it("separates price by unit", () => {
    const base = fixture("price");
    const usdc = readObservation(withPayload(base, { unit: "USDC" }))[0]!.aspect;
    const xlm = readObservation(withPayload(base, { unit: "XLM" }))[0]!.aspect;
    expect(usdc).not.toBe(xlm);
  });

  it("gives latency one scale per counterparty", () => {
    const a = readObservation(withPayload(fixture("latency"), { latencyMs: 1 }))[0]!.aspect;
    const b = readObservation(withPayload(fixture("latency"), { latencyMs: 90000 }))[0]!.aspect;
    expect(a).toBe(b);
    expect(ASPECT_SHAPES.latency).toHaveLength(1);
  });

  // The two quantities in one payload are different quantities and get one
  // aspect each; the second exists only when the payload carries it.
  it("reads hops and amount from cluster_proximity as two readings, and hops alone without an amount", () => {
    const both = readObservation(fixture("cluster_proximity"));
    expect(both.map((r) => r.aspect).sort()).toEqual(["amount", "hops"]);
    expect(both.find((r) => r.aspect === "hops")).toMatchObject({ value: 2 });
    expect(both.find((r) => r.aspect === "amount")).toMatchObject({ value: 0.00001 });
    const base = fixture("cluster_proximity");
    const { amount: _dropped, ...withoutAmount } = base.payload;
    const one = readObservation({ ...base, payload: withoutAmount });
    expect(one.map((r) => r.aspect)).toEqual(["hops"]);
  });

  it("keys protocol by event and content by field, carrying no value", () => {
    const [protocol] = readObservation(fixture("protocol"));
    expect(protocol).toEqual({ kind: "categorical", channel: "protocol", aspect: "event/trustline_created" });
    const [content] = readObservation(fixture("content"));
    expect(content).toEqual({ kind: "categorical", channel: "content", aspect: "field/memo" });
    const [address] = readObservation(fixture("address_integrity"));
    expect(address).toEqual({ kind: "categorical", channel: "address_integrity", aspect: "transition" });
  });

  it("refuses a payload the channel's validator does not accept, before any arithmetic", () => {
    const broken = { ...fixture("volume"), payload: { amount: "not a decimal", assetCode: "USDC", direction: "in" } };
    expect(() => readObservation(broken)).toThrow(RangeError);
    // A well-formed decimal under a direction the contract does not admit.
    // Arithmetic alone would read 0.25 and mint an aspect for a direction
    // that does not exist; only the validator step refuses it, so this is
    // the case that shows the step is there.
    const sideways = withPayload(fixture("volume"), { direction: "sideways" });
    expect(() => readObservation(sideways)).toThrow(RangeError);
  });

  // No reading is ever infinite or NaN, on any of the four continuous
  // channels. Two ways in are closed here. The decimal pattern admits any
  // number of digits and a double does not, so a four-hundred-digit amount
  // is Infinity after Number(). And a JSON number field arrives as a double
  // already; the installed validator's z.number() refuses NaN but admits
  // Infinity, so latencyMs is held finite by this package and by nothing
  // upstream of it. hops is z.number().int(), which refuses Infinity on its
  // own, and is listed anyway so the property is held on every field rather
  // than on the fields where it happens to be this package's job today.
  it.each<[string, Channel, Record<string, unknown>]>([
    ["volume amount of four hundred digits", "volume", { amount: "9".repeat(400) }],
    ["price quoted of four hundred digits", "price", { quoted: "9".repeat(400) }],
    ["latency latencyMs Infinity", "latency", { latencyMs: Infinity }],
    ["latency latencyMs NaN", "latency", { latencyMs: NaN }],
    ["cluster_proximity hops Infinity", "cluster_proximity", { hops: Infinity }],
    ["cluster_proximity hops NaN", "cluster_proximity", { hops: NaN }],
    ["cluster_proximity amount of four hundred digits", "cluster_proximity", { amount: "9".repeat(400) }],
  ])("refuses a quantity that is not a finite double: %s", (_case, channel, change) => {
    const o = withPayload(fixture(channel), change);
    expect(() => readObservation(o)).toThrow(RangeError);
  });

  it("is a pure function of the observation", () => {
    const o = fixture("cluster_proximity");
    expect(readObservation(o)).toEqual(readObservation(o));
  });
});
