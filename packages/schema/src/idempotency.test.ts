import { describe, it, expect } from "vitest";
import { deriveIdempotencyKey } from "./idempotency.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "stellar:pubnet", ref: "op:214748367361",
  fetchedAt: "2026-09-05T10:00:00.000Z",
};

const ns = { kind: "wallet", id: "GSENDER" } as const;

describe("idempotency key", () => {
  it("is stable across repeated derivation", () => {
    expect(deriveIdempotencyKey(src, "volume", ns)).toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("does not change when the producer version changes", () => {
    expect(deriveIdempotencyKey({ ...src, producerVersion: "9.9.9" }, "volume", ns))
      .toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("does not change when the fetch time changes", () => {
    expect(deriveIdempotencyKey({ ...src, fetchedAt: "2027-01-01T00:00:00.000Z" }, "volume", ns))
      .toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("differs per channel, so one event may yield several observations", () => {
    expect(deriveIdempotencyKey(src, "volume", ns)).not.toBe(deriveIdempotencyKey(src, "content", ns));
  });

  it("differs per source reference", () => {
    expect(deriveIdempotencyKey({ ...src, ref: "op:2" }, "volume", ns))
      .not.toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("differs per producer", () => {
    expect(deriveIdempotencyKey({ ...src, producer: "other-indexer" }, "volume", ns))
      .not.toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("differs per network, because operation ids repeat across them", () => {
    expect(deriveIdempotencyKey({ ...src, network: "stellar:testnet" }, "volume", ns))
      .not.toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("is stable for a producer that declares no network", () => {
    const { network: _drop, ...noNetwork } = src;
    expect(deriveIdempotencyKey(noNetwork, "volume", ns))
      .toBe(deriveIdempotencyKey(noNetwork, "volume", ns));
    expect(deriveIdempotencyKey(noNetwork, "volume", ns))
      .not.toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  // A payment has two sides. Both sides' observations carry the same producer,
  // network, ref and channel; only the namespace tells them apart. Without it
  // in the key the second side would be dropped as a duplicate and one
  // counterparty's evidence would silently disappear.
  it("differs per namespace, so both sides of one event are kept", () => {
    expect(deriveIdempotencyKey(src, "volume", { kind: "wallet", id: "GRECEIVER" }))
      .not.toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("is the same for the same namespace given as a fresh object", () => {
    expect(deriveIdempotencyKey(src, "volume", { kind: "wallet", id: "GSENDER" }))
      .toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("differs when only the namespace kind differs", () => {
    expect(deriveIdempotencyKey(src, "volume", { kind: "merchant", id: "GSENDER" }))
      .not.toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("ignores a continuity assertion on the namespace", () => {
    // Continuity is provenance about the namespace, not part of which
    // counterparty the observation concerns.
    const withContinuity = {
      ...ns,
      continuity: {
        assertedBy: "integrator:acme",
        assertedAt: "2026-09-05T10:00:00.000Z",
        reason: "same merchant across rotation",
      },
    };
    expect(deriveIdempotencyKey(src, "volume", withContinuity))
      .toBe(deriveIdempotencyKey(src, "volume", ns));
  });

  it("does not let a field boundary shift without changing the key", () => {
    // With a space separator these two concatenate identically. The test fails
    // if the separator is anything a field can contain.
    const a = { ...src, network: "a", ref: "b c" };
    const b = { ...src, network: "a b", ref: "c" };
    expect(deriveIdempotencyKey(a, "volume", ns)).not.toBe(deriveIdempotencyKey(b, "volume", ns));
  });

  it("does not let a namespace boundary shift without changing the key", () => {
    // The namespace kind and id are the last two parts. Each pair below
    // concatenates identically under a space separator, so the test fails if
    // the separator is anything a field can contain. `channel` and `kind` are
    // enums only at the type level; the derivation does not check them, so an
    // unvalidated caller could pass the shifted values, and they are cast here.
    // First, "x" crosses the boundary between the channel and the kind:
    // "volume" + "x wallet" versus "volume x" + "wallet".
    const a = deriveIdempotencyKey(src, "volume", { kind: "x wallet" as "wallet", id: "X" });
    const b = deriveIdempotencyKey(src, "volume x" as "volume", { kind: "wallet", id: "X" });
    expect(a).not.toBe(b);
    // Then a space crosses the boundary between the kind and the id.
    const c = deriveIdempotencyKey(src, "volume", { kind: "wallet", id: " X" });
    const d = deriveIdempotencyKey(src, "volume", { kind: "wallet " as "wallet", id: "X" });
    expect(c).not.toBe(d);
  });

  it("refuses a field that contains the separator itself", () => {
    // The NUL join is unambiguous only while no field contains a NUL.
    // sourceSchema and namespaceRefSchema reject one; this is the gate for an
    // input that skipped validation. Each pair below would otherwise
    // concatenate identically.
    const a = { ...src, network: "a", ref: "\u0000b" };
    const b = { ...src, network: "a\u0000", ref: "b" };
    expect(() => deriveIdempotencyKey(a, "volume", ns)).toThrow(/NUL/);
    expect(() => deriveIdempotencyKey(b, "volume", ns)).toThrow(/NUL/);
    expect(() => deriveIdempotencyKey(src, "volume", { kind: "wallet", id: "\u0000X" })).toThrow(/NUL/);
  });

  it("is a lowercase hex SHA-256 digest, so it fits a fixed-width unique column", () => {
    expect(deriveIdempotencyKey(src, "volume", ns)).toMatch(/^[0-9a-f]{64}$/);
  });
});
