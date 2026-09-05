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

  it("rejects an unknown namespace kind", () => {
    expect(namespaceRefSchema.safeParse({ kind: "email", id: "a@b" }).success).toBe(false);
  });
});
