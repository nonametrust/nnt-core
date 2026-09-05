import { describe, it, expect } from "vitest";
import { sourceSchema } from "./source.js";

describe("source", () => {
  it("separates the producer name from its version", () => {
    const r = sourceSchema.safeParse({
      producer: "stellar-indexer",
      producerVersion: "0.1.0",
      network: "stellar:pubnet",
      ref: "op:214748367361",
      fetchedAt: "2026-09-05T10:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a producer name carrying a version", () => {
    const r = sourceSchema.safeParse({
      producer: "stellar-indexer@0.1.0",
      producerVersion: "0.1.0",
      ref: "op:1",
      fetchedAt: "2026-09-05T10:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});
