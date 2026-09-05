import { describe, it, expect } from "vitest";
import { namespaceRefSchema } from "./namespace.js";

describe("namespace reference", () => {
  it("accepts a wallet namespace with no continuity claim", () => {
    expect(namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC" }).success).toBe(true);
  });

  it("records a continuity assertion with its asserter and reason", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "endpoint",
      id: "https://data.example/x402",
      continuity: {
        assertedBy: "integrator:acme",
        assertedAt: "2026-09-05T10:00:00.000Z",
        reason: "same merchant id across address rotation",
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a continuity assertion with no asserter", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "wallet",
      id: "GABC",
      continuity: { assertedAt: "2026-09-05T10:00:00.000Z", reason: "x" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown namespace kind", () => {
    expect(namespaceRefSchema.safeParse({ kind: "email", id: "a@b" }).success).toBe(false);
  });
});
