import { describe, it, expect } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { readObservation } from "@nonametrust/tagging";
import { MultipleReadings, readingOf, ValidationFailed } from "./observe.js";

// Task 8's first half, and the ruling every earlier task recorded as owed to it.
//
// R46: an intent with more than ONE reading is refused in M3, by name. R40 says the
// brief is handed "the intent's derived reading", singular, and `readObservation`
// returns `Reading[]` -- so the refusal has to live where readings are derived, which
// is here. It is implemented nowhere else; `tagObservation` maps over every reading
// without complaint.
//
// **R46'S PREMISE IS NARROWER THAN R46 STATES**, measured against the code rather than
// taken from the ruling. R46 says "`cluster_proximity` yields TWO -- `hops` and
// `amount` -- so a `cluster_proximity` intent cannot be briefed in M3". Reading
// `reading.ts:159-173`: `hops` is always produced and `amount` is pushed only
// `if (p.amount !== undefined)`. So a `cluster_proximity` observation WITHOUT an amount
// yields one reading and is perfectly briefable, and no other channel can exceed one.
//
// The refusal is therefore on the COUNT and not on the channel name, and the
// outward-facing sentence R46 sends to the README is too strong as written.

const source = {
  producer: "engine-observe-test",
  producerVersion: "0.1.0",
  network: "testnet",
  fetchedAt: "2026-09-30T00:00:00.000Z",
  ref: "op:1",
};

const wire = (over: Record<string, unknown>): WireObservation =>
  ({
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "OBSERVETEST" },
    channel: "price",
    evidenceKind: "event",
    kind: "quote",
    observedAt: "2026-09-25T00:00:00.000Z",
    source,
    payload: { quoted: "1.0000000", unit: "USDC" },
    ...over,
  }) as WireObservation;

/** A cluster_proximity observation, with or without the optional amount. */
const cluster = (withAmount: boolean): WireObservation =>
  wire({
    channel: "cluster_proximity",
    kind: "proximity",
    payload: withAmount
      ? { clusterId: "c-1", hops: 2, amount: "500.0000000" }
      : { clusterId: "c-1", hops: 2 },
  });

describe("readingOf", () => {
  it("returns the ONE reading an ordinary observation derives", () => {
    const reading = readingOf(wire({}), "ns-1");
    expect(reading).toEqual({
      namespaceId: "ns-1",
      channel: "price",
      aspect: "quoted/USDC",
    });
  });

  it("derives the aspect from the PAYLOAD, not from the channel", () => {
    // The aspect is what relatedness compares, and it is the half `readClear` cannot
    // return -- which is the whole reason R40 carries the reading forward instead of
    // letting the brief decrypt.
    const usdc = readingOf(wire({ payload: { quoted: "1.0000000", unit: "USDC" } }), "ns-1");
    const xlm = readingOf(wire({ payload: { quoted: "1.0000000", unit: "XLM" } }), "ns-1");
    expect(usdc.aspect).toBe("quoted/USDC");
    expect(xlm.aspect).toBe("quoted/XLM");
    expect(usdc.aspect).not.toBe(xlm.aspect);
  });

  it("carries the namespace it was given, because a reading is about a counterparty", () => {
    expect(readingOf(wire({}), "ns-9").namespaceId).toBe("ns-9");
  });

  describe("R46: more than one reading is refused BY NAME", () => {
    it("refuses a cluster_proximity observation that carries an amount", () => {
      // Two readings: `hops` and `amount`. Choosing between them would invent a rule
      // nobody has measured -- which of the two is "the" intent for relatedness, and
      // which surprise goes on the candidate trigger.
      const observation = cluster(true);
      expect(readObservation(observation as never)).toHaveLength(2);
      expect(() => readingOf(observation, "ns-1")).toThrow(MultipleReadings);
      expect(() => readingOf(observation, "ns-1")).toThrow(
        /observe: cluster_proximity derived 2 readings \(hops, amount\)/,
      );
    });

    it("names the aspects, so the refusal says WHICH readings collided", () => {
      // A refusal naming only the count leaves the reader to re-derive them. §3: every
      // refusal names its field or its class.
      expect(() => readingOf(cluster(true), "ns-1")).toThrow(/hops, amount/);
    });

    it("ADMITS a cluster_proximity observation with no amount, which R46 says is refused", () => {
      // The correction. `amount` is pushed only when the payload carries one, so this
      // observation derives exactly `hops` and is as briefable as any other. R46's
      // outward-facing sentence -- "a cluster_proximity intent cannot be briefed in
      // M3" -- is true of the two-reading form only.
      const observation = cluster(false);
      expect(readObservation(observation as never)).toHaveLength(1);
      expect(readingOf(observation, "ns-1")).toEqual({
        namespaceId: "ns-1",
        channel: "cluster_proximity",
        aspect: "hops",
      });
    });

    it("admits every channel that cannot exceed one reading", () => {
      // Measured from `reading.ts`'s switch: six of the seven channels produce exactly
      // one reading and cannot produce two. If a later channel changes that, this row
      // stays green and the refusal above catches it -- which is the right way round.
      const cases: [string, WireObservation][] = [
        ["price", wire({})],
        ["volume", wire({ channel: "volume", kind: "payment", payload: { amount: "5.0000000", assetCode: "USDC", direction: "in" } })],
        ["latency", wire({ channel: "latency", kind: "rtt", payload: { latencyMs: 12 } })],
        ["address_integrity", wire({ channel: "address_integrity", kind: "transition_observed", payload: { previous: "A", current: "B" } })],
        ["protocol", wire({ channel: "protocol", kind: "event_observed", payload: { event: "trustline_open" } })],
        ["content", wire({ channel: "content", kind: "field_observed", payload: { text: "x", field: "memo" } })],
      ];
      for (const [label, observation] of cases) {
        expect(() => readingOf(observation, "ns-1"), label).not.toThrow();
      }
    });
  });

  describe("refuses an observation the schema does not admit", () => {
    it("by name, before anything is derived from it", () => {
      // `validateObservation` is the schema's, and it refuses an envelope the wire may
      // not carry. Running it first is what keeps a malformed payload from reaching
      // tagging, whose refusals carry observed VALUES (R21).
      expect(() => readingOf(wire({ channel: "not_a_channel" }), "ns-1")).toThrow(
        ValidationFailed,
      );
    });

    it("refuses a wire observation carrying an engine-assigned field", () => {
      // The schema refuses `observationId` and `ingestedAt` on the wire: they are the
      // engine's to assign, and a producer supplying one is a producer choosing an id.
      expect(() => readingOf(wire({ observationId: "1" }), "ns-1")).toThrow(ValidationFailed);
      expect(() => readingOf(wire({ ingestedAt: "2026-09-25T00:00:00.000Z" }), "ns-1")).toThrow(
        ValidationFailed,
      );
    });

    it("carries the schema's own reasons, so a producer can act on the refusal", () => {
      const failure = (() => {
        try {
          readingOf(wire({ channel: "not_a_channel" }), "ns-1");
          return null;
        } catch (e) {
          return e as ValidationFailed;
        }
      })();
      expect(failure).not.toBeNull();
      expect(failure!.errors.length).toBeGreaterThan(0);
      expect(failure!.message).toMatch(/observe: the observation is not valid/);
    });

    it("refuses a blank namespace id, which no reading can be about", () => {
      expect(() => readingOf(wire({}), " ")).toThrow(/observe\.namespaceId must not be blank/);
    });
  });
});
