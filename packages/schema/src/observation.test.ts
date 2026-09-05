import { describe, it, expect } from "vitest";
import { observationSchema } from "./observation.js";
import { EVIDENCE_KINDS } from "./channel.js";

const base = {
  schemaVersion: "0.1.0",
  namespace: { kind: "wallet", id: "GABC" },
  channel: "address_integrity",
  kind: "payment_address_changed",
  source: {
    producer: "stellar-indexer",
    producerVersion: "0.1.0",
    network: "stellar:pubnet",
    ref: "op:1",
    fetchedAt: "2026-09-05T10:00:00.000Z",
  },
  payload: { previous: "GOLD", current: "GNEW" },
};

describe("observation", () => {
  it("accepts an event carrying observedAt", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event", observedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an event with no observedAt", () => {
    expect(observationSchema.safeParse({ ...base, evidenceKind: "event" }).success).toBe(false);
  });

  it("rejects an event carrying a validity interval", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event",
      observedAt: "2026-09-05T09:00:00.000Z",
      validFrom: "2026-09-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a state carrying validFrom and an open validUntil", () => {
    const r = observationSchema.safeParse({
      ...base, channel: "protocol", evidenceKind: "state",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a state carrying observedAt", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-01T00:00:00.000Z",
      observedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a state whose interval ends before it starts", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-05T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("treats the signature as optional in v0", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event",
      observedAt: "2026-09-05T09:00:00.000Z", signature: null,
    });
    expect(r.success).toBe(true);
  });

  // The tests below gate behaviours the seven above rely on without checking.

  it("rejects a state with no validFrom", () => {
    expect(observationSchema.safeParse({ ...base, evidenceKind: "state" }).success).toBe(false);
  });

  it("reads an omitted validUntil as open, not as absent", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state", validFrom: "2026-09-01T00:00:00.000Z",
    });
    // Assert on the whole result so that a wrong evidenceKind or a failed
    // parse cannot slip past as an unrun assertion.
    expect(r.success && r.data.evidenceKind === "state" ? r.data.validUntil : "unreached").toBeNull();
  });

  it("accepts a state whose interval closes at the instant it opened", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("names validUntil as the field at fault when the interval is inverted", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-05T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z",
    });
    expect(r.success ? [] : r.error.issues.map((i) => i.path)).toContainEqual(["validUntil"]);
  });

  it("rejects an evidence kind that is neither event nor state", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "fact", observedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown top-level key on either member", () => {
    const event = observationSchema.safeParse({
      ...base, evidenceKind: "event",
      observedAt: "2026-09-05T09:00:00.000Z", score: 1,
    });
    const state = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-01T00:00:00.000Z", score: 1,
    });
    expect(event.success).toBe(false);
    expect(state.success).toBe(false);
  });

  // The payload is required and is an object. Zod infers an optional key for
  // z.unknown(), so the type would otherwise promise a case the runtime never
  // produces once ingest is in place.
  it("rejects an observation with no payload", () => {
    const { payload: _omitted, ...rest } = base;
    const r = observationSchema.safeParse({
      ...rest, evidenceKind: "event", observedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.path)).toContainEqual(["payload"]);
  });

  it("rejects a payload that is not an object", () => {
    for (const payload of [null, "GNEW", 42, ["GOLD", "GNEW"]]) {
      const r = observationSchema.safeParse({
        ...base, payload, evidenceKind: "event", observedAt: "2026-09-05T09:00:00.000Z",
      });
      expect(r.success, `payload ${JSON.stringify(payload)} should be rejected`).toBe(false);
    }
  });

  // channel.ts owns the list of evidence kinds; the union's discriminant
  // literals must be that list and nothing else, so a third kind added in one
  // place fails here instead of going silently unhandled.
  it("uses exactly EVIDENCE_KINDS as its discriminant values", () => {
    const discriminants = [...observationSchema.innerType().optionsMap.keys()].sort();
    expect(discriminants).toEqual([...EVIDENCE_KINDS].sort());
  });

  // Strictness must not stop at the top level. A nested unknown key that is
  // silently stripped tells the indexer its data is flowing when it is not.
  it("rejects an unknown key inside salienceHints", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event", observedAt: "2026-09-05T09:00:00.000Z",
      salienceHints: { amount: "10", weight: 3 },
    });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.path)).toContainEqual(["salienceHints"]);
  });
});
