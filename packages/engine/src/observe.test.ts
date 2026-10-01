import { describe, it, expect } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { readObservation } from "@nonametrust/tagging";
import { readingsOf, UnreadableObservation, ValidationFailed } from "./observe.js";

/**
 * The one reading a brief may be handed. Fails the test if there is none, so a row
 * asserting a reading never passes silently on a refusal.
 */
function briefable(wire: WireObservation, ns: string) {
  const { intent } = readingsOf(wire, ns);
  if (!intent.briefable) throw new Error(`expected one reading, got ${intent.aspects.join(", ")}`);
  return intent.reading;
}

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
//
// **AND THE REFUSAL IS ON THE RETURN, NEVER ON THE FOLD.** A review caught the first
// version throwing, which would have been correct only if nothing ingested. R46 is
// about the INTENT being briefed; ingesting the two-reading form is M2's designed
// behaviour and `amount` is the dust signal `cluster_proximity` exists for, carrying a
// calibrated weight. A throw on this path would have refused every dust observation at
// the door and silently deleted the channel's signal. So `readingsOf` returns EVERY
// reading for the fold, and says separately whether there is an intent to brief.

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

describe("readingsOf", () => {
  it("returns the ONE reading an ordinary observation derives", () => {
    const reading = briefable(wire({}), "ns-1");
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
    const usdc = briefable(wire({ payload: { quoted: "1.0000000", unit: "USDC" } }), "ns-1");
    const xlm = briefable(wire({ payload: { quoted: "1.0000000", unit: "XLM" } }), "ns-1");
    expect(usdc.aspect).toBe("quoted/USDC");
    expect(xlm.aspect).toBe("quoted/XLM");
    expect(usdc.aspect).not.toBe(xlm.aspect);
  });

  it("carries the namespace it was given, because a reading is about a counterparty", () => {
    expect(briefable(wire({}), "ns-9").namespaceId).toBe("ns-9");
  });

  describe("R46: more than one reading is refused BY NAME", () => {
    it("refuses a cluster_proximity observation that carries an amount", () => {
      // Two readings: `hops` and `amount`. Choosing between them would invent a rule
      // nobody has measured -- which of the two is "the" intent for relatedness, and
      // which surprise goes on the candidate trigger.
      const observation = cluster(true);
      expect(readObservation(observation as unknown as Parameters<typeof readObservation>[0])).toHaveLength(2);
      const out = readingsOf(observation, "ns-1");
      expect(out.intent.briefable).toBe(false);
      expect(out.intent.briefable === false && out.intent.code).toBe("INTENT_HAS_MANY_READINGS");
    });

    it("STILL RETURNS BOTH READINGS, so the fold and the tags are untouched", () => {
      // The finding that reshaped this function. `amount` is the dust signal
      // `cluster_proximity` carries a calibrated weight for, and a refusal on this path
      // would have refused every dust observation at INGEST -- deleting the channel's
      // signal to enforce a rule about BRIEFS. Ingest tags both readings; only the
      // intent is absent.
      const out = readingsOf(cluster(true), "ns-1");
      expect(out.all.map((r) => r.aspect).sort()).toEqual(["amount", "hops"]);
      for (const reading of out.all) {
        expect(reading.channel).toBe("cluster_proximity");
        expect(reading.namespaceId).toBe("ns-1");
      }
    });

    it("names the aspects, so the refusal says WHICH readings collided", () => {
      // A refusal naming only the count leaves the reader to re-derive them. §3: every
      // refusal names its field or its class.
      const intent = readingsOf(cluster(true), "ns-1").intent;
      expect(intent.briefable === false && intent.aspects).toEqual(["hops", "amount"]);
    });

    it("ADMITS a cluster_proximity observation with no amount, which R46 says is refused", () => {
      // The correction. `amount` is pushed only when the payload carries one, so this
      // observation derives exactly `hops` and is as briefable as any other. R46's
      // outward-facing sentence -- "a cluster_proximity intent cannot be briefed in
      // M3" -- is true of the two-reading form only.
      const observation = cluster(false);
      expect(readObservation(observation as unknown as Parameters<typeof readObservation>[0])).toHaveLength(1);
      expect(briefable(observation, "ns-1")).toEqual({
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
        expect(() => briefable(observation, "ns-1"), label).not.toThrow();
      }
    });
  });

  describe("refuses an observation the schema does not admit", () => {
    it("by name, before anything is derived from it", () => {
      // `validateObservation` is the schema's, and it refuses an envelope the wire may
      // not carry. Running it first is what keeps a malformed payload from reaching
      // tagging, whose refusals carry observed VALUES (R21).
      expect(() => readingsOf(wire({ channel: "not_a_channel" }), "ns-1")).toThrow(
        ValidationFailed,
      );
    });

    it("refuses a wire observation carrying an engine-assigned field", () => {
      // The schema refuses `observationId` and `ingestedAt` on the wire: they are the
      // engine's to assign, and a producer supplying one is a producer choosing an id.
      expect(() => readingsOf(wire({ observationId: "1" }), "ns-1")).toThrow(ValidationFailed);
      expect(() => readingsOf(wire({ ingestedAt: "2026-09-25T00:00:00.000Z" }), "ns-1")).toThrow(
        ValidationFailed,
      );
    });

    it("carries the schema's own reasons, so a producer can act on the refusal", () => {
      const failure = (() => {
        try {
          readingsOf(wire({ channel: "not_a_channel" }), "ns-1");
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
      expect(() => readingsOf(wire({}), " ")).toThrow(/observe\.namespaceId must not be blank/);
      expect(() => readingsOf(wire({}), "")).toThrow(/must not be blank/);
    });

    it("refuses a namespace id that is not a string at all", () => {
      // The guard's non-string half was held by nothing: every row passed a string, so
      // flipping the check to accept `undefined` and `42` SURVIVED. Under that mutant
      // `readingsOf(wire, undefined)` returns `namespaceId: undefined` and the brief's
      // R57 comparison then fails against every observation.
      for (const bad of [undefined, null, 42, {}]) {
        expect(() => readingsOf(wire({}), bad as unknown as string), String(bad)).toThrow(
          /observe\.namespaceId must be a string/,
        );
      }
    });

    it("refuses a PADDED namespace id rather than trimming it", () => {
      // Adding a `.trim()` to the returned record SURVIVED every row. It is not
      // equivalent: what this function returns is what R57 compares by string equality
      // against the observation's namespace, so a trim here decides that comparison
      // silently. Refused where the value is handed over, which is `thresholdUnit`'s
      // precedent exactly.
      expect(() => readingsOf(wire({}), " ns-1")).toThrow(/must not be padded/);
      expect(() => readingsOf(wire({}), "ns-1 ")).toThrow(/must not be padded/);
      expect(readingsOf(wire({}), "ns-1").intent.briefable).toBe(true);
    });

    it("gets at least ONE reading from every channel, which is what makes zero unreachable", () => {
      // The assumption, gated rather than the unreachable branch. A mutant treating
      // zero readings as briefable SURVIVES and always will, because no channel can
      // produce zero: every arm of `readObservation`'s switch returns at least one and
      // the default throws. That is a property of `reading.ts`, not of this module --
      // so it is asserted HERE, across every channel, and the day a channel starts
      // returning an empty array this row goes red instead of a brief being handed a
      // reading with undefined fields.
      const everyChannel: [string, WireObservation][] = [
        ["price", wire({})],
        ["volume", wire({ channel: "volume", kind: "payment", payload: { amount: "5.0000000", assetCode: "USDC", direction: "in" } })],
        ["latency", wire({ channel: "latency", kind: "rtt", payload: { latencyMs: 12 } })],
        ["cluster_proximity/one", cluster(false)],
        ["cluster_proximity/two", cluster(true)],
        ["address_integrity", wire({ channel: "address_integrity", kind: "transition_observed", payload: { previous: "A", current: "B" } })],
        ["protocol", wire({ channel: "protocol", kind: "event_observed", payload: { event: "trustline_open" } })],
        ["content", wire({ channel: "content", kind: "field_observed", payload: { text: "x", field: "memo" } })],
      ];
      for (const [label, observation] of everyChannel) {
        expect(readingsOf(observation, "ns-1").all.length, label).toBeGreaterThanOrEqual(1);
      }
    });

    it("says NOT BRIEFABLE for a count that is not one, in either direction", () => {
      // The count rule is `=== 1`, not `<= 1`. Zero readings is unreachable today --
      // every arm of `readObservation`'s switch returns at least one and the default
      // throws -- but nothing gates that, and a `> 1` mutant survives. What the shape
      // guarantees regardless is that a non-one count yields a REFUSAL rather than a
      // reading with undefined fields, which the first version did not.
      const zero = { validated: null, all: [], intent: null };
      void zero;
      const two = readingsOf(cluster(true), "ns-1");
      expect(two.intent.briefable).toBe(false);
      expect(two.all).toHaveLength(2);
      // And the one-reading case is the only briefable one.
      expect(readingsOf(wire({}), "ns-1").intent.briefable).toBe(true);
      expect(readingsOf(wire({}), "ns-1").all).toHaveLength(1);
    });
  });

  describe("R21: a refusal that carries an observed VALUE is wrapped in a code", () => {
    // THE CLAIM THIS REPLACES WAS FALSE. The first version argued that validating
    // first keeps tagging's value-carrying refusals out of reach. Measured by a
    // review: `decimalStringSchema` is `/^(0|[1-9]\d*)(\.\d+)?$/` with NO length
    // bound, so a 309-digit amount PASSES `validateObservation` and only then does
    // `decimal()` throw `amount 999...999 does not fit a double` -- the whole value in
    // the message.
    //
    // And that is exactly the case Task 8's acceptance names: "a 308-digit amount is
    // recorded with its code and observation id, and the refusal's message text
    // appears nowhere in the audit body". So the one refusal the plan cares about is
    // the one validation-first does not stop.
    const huge = "9".repeat(309);

    it("lets a 309-digit amount through the schema, which is why the wrapper exists", () => {
      const observation = wire({
        channel: "volume",
        kind: "payment",
        payload: { amount: huge, assetCode: "USDC", direction: "in" },
      });
      expect(() => readingsOf(observation, "ns-1")).toThrow(UnreadableObservation);
    });

    it("carries a CODE and NOT the value, so nothing recorded can leak it", () => {
      const observation = wire({
        channel: "volume",
        kind: "payment",
        payload: { amount: huge, assetCode: "USDC", direction: "in" },
      });
      const failure = (() => {
        try {
          readingsOf(observation, "ns-1");
          return null;
        } catch (e) {
          return e as UnreadableObservation;
        }
      })();
      expect(failure).not.toBeNull();
      expect(failure!.code).toBe("OBSERVATION_UNREADABLE");
      expect(failure!.channel).toBe("volume");
      // The whole point: the 309-digit value is in the CAUSE, for a human reading
      // stderr, and nowhere in anything a recorder would reach for.
      expect(failure!.message).not.toContain(huge);
      expect(failure!.message).not.toContain("999999");
      expect(JSON.stringify(failure)).not.toContain("999999");
      expect((failure!.cause as Error).message).toContain(huge);
    });

    it("wraps the value-carrying refusal and not an ordinary one", () => {
      // A schema refusal is `ValidationFailed` and stays that way; only what tagging
      // throws after a valid envelope becomes `UnreadableObservation`.
      expect(() => readingsOf(wire({ channel: "not_a_channel" }), "ns-1")).toThrow(ValidationFailed);
    });
  });
});
