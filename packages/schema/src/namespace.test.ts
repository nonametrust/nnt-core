import { describe, it, expect } from "vitest";
import { namespaceRefSchema } from "./namespace.js";

/** The paths of every issue, so a rejection can be pinned to one field. */
function issuePaths(r: ReturnType<typeof namespaceRefSchema.safeParse>): string[] {
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

const continuity = {
  assertedBy: "integrator:acme",
  assertedAt: "2026-09-05T10:00:00.000Z",
  reason: "same merchant id across address rotation",
};

describe("namespace reference", () => {
  it("accepts a wallet namespace with no continuity claim", () => {
    expect(namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC" }).success).toBe(true);
  });

  it("records a continuity assertion with its asserter and reason", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "endpoint",
      id: "https://data.example/x402",
      continuity,
    });
    expect(r.success).toBe(true);
  });

  // Continuity is asserted, never inferred. All three parts of the assertion
  // are required, and each rejection is pinned to its own field so that a
  // failure elsewhere could not keep these tests green by accident.
  it("rejects a continuity assertion with no asserter", () => {
    const { assertedBy: _omitted, ...rest } = continuity;
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC", continuity: rest });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity.assertedBy"]);
  });

  it("rejects a continuity assertion with no assertion time", () => {
    const { assertedAt: _omitted, ...rest } = continuity;
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC", continuity: rest });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity.assertedAt"]);
  });

  it("rejects a continuity assertion with no reason", () => {
    const { reason: _omitted, ...rest } = continuity;
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC", continuity: rest });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity.reason"]);
  });

  it("rejects a whitespace-only asserter", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "wallet",
      id: "GABC",
      continuity: { ...continuity, assertedBy: "   " },
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity.assertedBy"]);
  });

  it("rejects a whitespace-only reason", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "wallet",
      id: "GABC",
      continuity: { ...continuity, reason: "   " },
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity.reason"]);
  });

  it("rejects an assertion time with a UTC offset; timestamps are Z-only", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "wallet",
      id: "GABC",
      continuity: { ...continuity, assertedAt: "2026-09-05T12:00:00.000+02:00" },
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity.assertedAt"]);
  });

  // The idempotency key joins its parts on a NUL and the namespace id is one
  // of them, so the id may not contain one. Gated here; the derivation itself
  // is gated in idempotency.test.ts.
  it("rejects a namespace id containing a NUL, the idempotency key separator", () => {
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC\u0000D" });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["id"]);
  });

  // A muxed address resolves to its base address, which is the id; the muxed
  // identifier rides along as an attribute so it is not dropped on the wire.
  it("accepts a muxed identifier as an attribute of the namespace", () => {
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GBASE", muxedId: "12345" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.muxedId).toBe("12345");
  });

  it("rejects an empty muxed identifier; omit the field instead", () => {
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GBASE", muxedId: "" });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["muxedId"]);
  });

  it("rejects an unknown namespace kind", () => {
    expect(namespaceRefSchema.safeParse({ kind: "email", id: "a@b" }).success).toBe(false);
  });

  // Unknown keys are rejected rather than stripped. Stripping tells the
  // integrator a field is flowing when it is not.
  it("rejects an unknown key on the namespace reference", () => {
    const r = namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC", label: "acme" });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual([""]);
  });

  it("rejects an unknown key inside the continuity assertion", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "wallet",
      id: "GABC",
      continuity: { ...continuity, confidence: 0.9 },
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(["continuity"]);
  });
});
