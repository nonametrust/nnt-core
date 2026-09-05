import { describe, it, expect } from "vitest";
import { CHANNELS } from "./channel.js";
import { payloadSchemaFor, validateObservation } from "./payloads.js";

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

  it("requires amounts to be decimal strings", () => {
    for (const amount of ["12,5", "abc", "", "1e-7", "-3"]) {
      const r = validateObservation({ ...volume, payload: { ...volume.payload, amount } });
      expect(r.ok, `amount ${JSON.stringify(amount)} was accepted`).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/^payload\.amount: /);
    }
    for (const amount of ["0", "12.5", "0.0000001", "500"]) {
      const r = validateObservation({ ...volume, payload: { ...volume.payload, amount } });
      expect(r.ok, `amount ${JSON.stringify(amount)} was rejected`).toBe(true);
    }
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

  it("rejects an input that is not an object", () => {
    for (const input of [null, undefined, "volume", 42, []]) {
      const r = validateObservation(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toContain("schemaVersion");
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
  it("rejects a wire idempotency key that disagrees with the derived one", () => {
    const derived = validateObservation(volume);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const wrong = validateObservation({ ...volume, idempotencyKey: "f".repeat(64) });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.errors[0]).toMatch(/^idempotencyKey: /);
    const same = validateObservation({ ...volume, idempotencyKey: derived.value.idempotencyKey });
    expect(same.ok).toBe(true);
  });

  it("accepts a state observation and assigns it a key too", () => {
    const r = validateObservation({
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "protocol",
      evidenceKind: "state",
      kind: "trustline_open",
      validFrom: "2026-08-20T00:00:00.000Z",
      validUntil: null,
      source: src,
      payload: { event: "trustline_established", assetCode: "USDC", issuerKnown: true },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
