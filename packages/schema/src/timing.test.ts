import { describe, it, expect } from "vitest";
import { datedAt } from "./timing.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

// The gate for the claim that datedAt is the only reader of a date off an
// observation is gates/single-date-reader.test.ts at the repository root. It
// used to live here, and so scanned this package alone.
describe("datedAt", () => {
  it("returns the instant for an event", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a state, so a state can never be dated", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "trustline_open",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
      source: src, payload: {},
    })).toBeNull();
  });

  it("dates an event by observedAt, not by when it was fetched or ingested", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
      ingestedAt: "2026-09-05T11:00:00.000Z",
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a closed state as well as an open one", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "trustline_open",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2026-09-03T00:00:00.000Z",
      source: src, payload: {},
    })).toBeNull();
  });
});
