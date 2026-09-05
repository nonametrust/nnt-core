import { describe, it, expect } from "vitest";
import { deriveIdempotencyKey } from "./idempotency.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "stellar:pubnet", ref: "op:214748367361",
  fetchedAt: "2026-09-05T10:00:00.000Z",
};

describe("idempotency key", () => {
  it("is stable across repeated derivation", () => {
    expect(deriveIdempotencyKey(src, "volume")).toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("does not change when the producer version changes", () => {
    expect(deriveIdempotencyKey({ ...src, producerVersion: "9.9.9" }, "volume"))
      .toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("does not change when the fetch time changes", () => {
    expect(deriveIdempotencyKey({ ...src, fetchedAt: "2027-01-01T00:00:00.000Z" }, "volume"))
      .toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("differs per channel, so one event may yield several observations", () => {
    expect(deriveIdempotencyKey(src, "volume")).not.toBe(deriveIdempotencyKey(src, "content"));
  });

  it("differs per source reference", () => {
    expect(deriveIdempotencyKey({ ...src, ref: "op:2" }, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("differs per producer", () => {
    expect(deriveIdempotencyKey({ ...src, producer: "other-indexer" }, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("differs per network, because operation ids repeat across them", () => {
    expect(deriveIdempotencyKey({ ...src, network: "stellar:testnet" }, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("is stable for a producer that declares no network", () => {
    const { network: _drop, ...noNetwork } = src;
    expect(deriveIdempotencyKey(noNetwork, "volume"))
      .toBe(deriveIdempotencyKey(noNetwork, "volume"));
    expect(deriveIdempotencyKey(noNetwork, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("does not let a field boundary shift without changing the key", () => {
    // With a space separator these two concatenate identically. The test fails
    // if the separator is anything a field can contain.
    const a = { ...src, network: "a", ref: "b c" };
    const b = { ...src, network: "a b", ref: "c" };
    expect(deriveIdempotencyKey(a, "volume")).not.toBe(deriveIdempotencyKey(b, "volume"));
  });

  it("refuses a field that contains the separator itself", () => {
    // The NUL join is unambiguous only while no field contains a NUL.
    // sourceSchema rejects one; this is the gate for a source that skipped
    // validation. The two pairs below would otherwise concatenate identically.
    const a = { ...src, network: "a", ref: "\u0000b" };
    const b = { ...src, network: "a\u0000", ref: "b" };
    expect(() => deriveIdempotencyKey(a, "volume")).toThrow(/NUL/);
    expect(() => deriveIdempotencyKey(b, "volume")).toThrow(/NUL/);
  });

  it("is a lowercase hex SHA-256 digest, so it fits a fixed-width unique column", () => {
    expect(deriveIdempotencyKey(src, "volume")).toMatch(/^[0-9a-f]{64}$/);
  });
});
