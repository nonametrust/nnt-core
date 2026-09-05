import { describe, it, expect } from "vitest";
import { CHANNELS } from "./channel.js";
import {
  payloadSchemaFor,
  validateObservation,
  type PayloadByChannel,
  type VolumePayload,
} from "./payloads.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

const volume = {
  schemaVersion: "0.1.0",
  namespace: { kind: "wallet", id: "GABC" },
  channel: "volume",
  evidenceKind: "event",
  kind: "payment",
  observedAt: "2026-09-05T09:00:00.000Z",
  source: src,
  payload: { amount: "12.5", assetCode: "XLM", direction: "in" },
};

const state = {
  schemaVersion: "0.1.0",
  namespace: { kind: "wallet", id: "GABC" },
  channel: "protocol",
  evidenceKind: "state",
  kind: "trustline_open",
  validFrom: "2026-08-20T00:00:00.000Z",
  validUntil: null,
  source: src,
  payload: { event: "trustline_established", assetCode: "USDC", issuerKnown: true },
};

// Type-level gate, checked by `pnpm typecheck`: the documented VolumePayload
// and the payload the volume validator infers are the same type in both
// directions, so the field documentation cannot drift from the validator.
const _documentedVolume: VolumePayload = {} as PayloadByChannel["volume"];
const _inferredVolume: PayloadByChannel["volume"] = {} as VolumePayload;
void _documentedVolume;
void _inferredVolume;

describe("payload validators", () => {
  it("has a validator for every channel", () => {
    for (const c of CHANNELS) expect(payloadSchemaFor(c)).toBeDefined();
  });

  it("rejects an address change with no previous address", () => {
    const r = validateObservation({
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "address_integrity",
      evidenceKind: "event",
      kind: "payment_address_changed",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { current: "GNEW" },
    });
    expect(r.ok).toBe(false);
  });

  // A transition is one observation and a revert is another, each with its
  // own source reference. A flag folding both into one observation could not
  // be read one way and hid the anomaly, which is two transitions in a day.
  it("rejects a reverted flag on an address change", () => {
    const r = validateObservation({
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "address_integrity",
      evidenceKind: "event",
      kind: "payment_address_changed",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { previous: "GOLD", current: "GNEW", reverted: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("reverted");
  });

  it("rejects an observation declaring an unsupported schema version", () => {
    const r = validateObservation({
      schemaVersion: "0.0.1",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "volume",
      evidenceKind: "event",
      kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { amount: "1", assetCode: "XLM", direction: "in" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("schemaVersion");
  });

  it("assigns an idempotency key when the observation is valid", () => {
    const r = validateObservation({
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "volume",
      evidenceKind: "event",
      kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { amount: "12.5", assetCode: "XLM", direction: "in" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  // Every payload validator is strict, like every other object in this
  // package: an unknown key is rejected rather than stripped, because a
  // stripped key tells the indexer a field is flowing when it is not.
  it("rejects an unknown key in a payload rather than stripping it", () => {
    const r = validateObservation({
      ...volume,
      payload: { ...volume.payload, memo: "invoice 4471" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^payload: /);
      expect(r.errors[0]).toContain("memo");
    }
  });

  it("rejects an unknown key in every channel's payload", () => {
    for (const c of CHANNELS) {
      const r = payloadSchemaFor(c).safeParse({ unexpected: true });
      const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
      // A strict object reports the unknown key at the object's own path, so an
      // empty path must be among the issues; a missing-field issue alone would
      // mean the key was silently stripped.
      expect(paths, `${c} stripped an unknown key`).toContain("");
    }
  });

  it("names the field in a payload error", () => {
    const r = validateObservation({
      ...volume,
      payload: { ...volume.payload, direction: "sideways" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^payload\.direction: /);
  });

  it("requires amounts to be decimal strings without leading zeros", () => {
    for (const amount of ["12,5", "abc", "", "1e-7", "-3", "007", "00.5", "1."]) {
      const r = validateObservation({ ...volume, payload: { ...volume.payload, amount } });
      expect(r.ok, `amount ${JSON.stringify(amount)} was accepted`).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/^payload\.amount: /);
    }
    for (const amount of ["0", "12.5", "0.0000001", "500", "10.50"]) {
      const r = validateObservation({ ...volume, payload: { ...volume.payload, amount } });
      expect(r.ok, `amount ${JSON.stringify(amount)} was rejected`).toBe(true);
    }
  });

  // The hint exists to be read without opening the payload, so it must obey
  // the same rule as the amount it summarises.
  it("holds the salience amount hint to the same decimal rule", () => {
    const bad = validateObservation({ ...volume, salienceHints: { amount: "12,5" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatch(/^salienceHints\.amount: /);
    const good = validateObservation({ ...volume, salienceHints: { amount: "12.5" } });
    expect(good.ok).toBe(true);
  });

  it("names the envelope field in an envelope error", () => {
    const r = validateObservation({ ...volume, channel: "vibes" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^channel: /);
  });

  it("reports an unknown envelope key at the envelope, not at an empty path", () => {
    const r = validateObservation({ ...volume, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/^observation: /);
      expect(r.errors[0]).toContain("extra");
    }
  });

  // A JSON string handed in unparsed is the first mistake a caller makes, and
  // an error about schemaVersion would send them to the wrong place.
  it("says plainly when the input is not an object", () => {
    const cases: [unknown, string][] = [
      [null, "null"],
      [undefined, "undefined"],
      [JSON.stringify(volume), "string"],
      [42, "number"],
      [[], "array"],
    ];
    for (const [input, what] of cases) {
      const r = validateObservation(input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^observation: expected a parsed JSON object/);
        expect(r.errors[0]).toContain(what);
      }
    }
  });

  it("checks the schema version before the envelope", () => {
    // A wrong version on an otherwise broken input yields the version error
    // alone, so a producer on the wrong schema sees the cause and not a list
    // of shape mismatches that follow from it.
    const r = validateObservation({ schemaVersion: "9.0.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^schemaVersion: /);
    }
  });

  // The key is assigned by the engine. A producer that sends one anyway and
  // gets it wrong must hear so, because a silently replaced key means the
  // producer's own deduplication and ours disagree about what is a duplicate.
  // The message carries the derived key, so a producer that precomputes with
  // the exported function can see what it should have sent.
  it("rejects a wire idempotency key that disagrees with the derived one, showing the derived key", () => {
    const derived = validateObservation(volume);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const wrong = validateObservation({ ...volume, idempotencyKey: "f".repeat(64) });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.errors[0]).toMatch(/^idempotencyKey: /);
      expect(wrong.errors[0]).toContain(derived.value.idempotencyKey);
    }
    const same = validateObservation({ ...volume, idempotencyKey: derived.value.idempotencyKey });
    expect(same.ok).toBe(true);
  });

  // The other two engine-assigned fields have no derivation to compare
  // against, so their presence on the wire is the error.
  it("rejects a wire observationId, which the engine assigns", () => {
    const r = validateObservation({ ...volume, observationId: "019200f0-0000-7000-8000-000000000000" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^observationId: /);
      expect(r.errors[0]).toMatch(/assigned by the engine/);
    }
  });

  it("rejects a wire ingestedAt, which the engine assigns", () => {
    const r = validateObservation({ ...volume, ingestedAt: "2026-09-05T11:00:00.000Z" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^ingestedAt: /);
      expect(r.errors[0]).toMatch(/assigned by the engine/);
    }
  });

  // Every timestamp in the contract is UTC ending in Z. A gateway developer
  // in another zone sends an offset first, and "Invalid datetime" does not
  // tell them what the field wants.
  it("says a timestamp must be UTC ending in Z, on every timestamp field", () => {
    const offset = "2026-09-05T12:00:00.000+03:00";
    const cases: [string, unknown][] = [
      ["observedAt", { ...volume, observedAt: offset }],
      ["validFrom", { ...state, validFrom: offset }],
      ["validUntil", { ...state, validUntil: offset }],
      ["source.fetchedAt", { ...volume, source: { ...src, fetchedAt: offset } }],
      ["namespace.continuity.assertedAt", {
        ...volume,
        namespace: {
          ...volume.namespace,
          continuity: { assertedBy: "integrator:acme", assertedAt: offset, reason: "same merchant" },
        },
      }],
    ];
    for (const [field, input] of cases) {
      const r = validateObservation(input);
      expect(r.ok, `${field} accepted an offset timestamp`).toBe(false);
      if (!r.ok) {
        expect(r.errors[0]).toMatch(new RegExp(`^${field.replace(/\./g, "\\.")}: `));
        expect(r.errors[0]).toContain("UTC");
        expect(r.errors[0]).toContain("Z");
      }
    }
  });

  it("accepts a state observation and assigns it a key too", () => {
    const r = validateObservation(state);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
