import { describe, it, expect } from "vitest";
import { sourceSchema } from "./source.js";

const PRODUCER_MESSAGE = "producer is a bare name; put the version in producerVersion";

/** Every issue as [path, message], so a rejection can be pinned to one field. */
function issues(r: ReturnType<typeof sourceSchema.safeParse>): string[][] {
  return r.success ? [] : r.error.issues.map((i) => [i.path.join("."), i.message]);
}

const valid = {
  producer: "stellar-indexer",
  producerVersion: "0.1.0",
  network: "stellar:pubnet",
  ref: "op:214748367361",
  fetchedAt: "2026-09-05T10:00:00.000Z",
};

describe("source", () => {
  it("separates the producer name from its version", () => {
    expect(sourceSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a producer name carrying a version", () => {
    const r = sourceSchema.safeParse({
      producer: "stellar-indexer@0.1.0",
      producerVersion: "0.1.0",
      ref: "op:1",
      fetchedAt: "2026-09-05T10:00:00.000Z",
    });
    expect(r.success).toBe(false);
    // The rejection must come from the producer field itself, not from some
    // other field happening to be invalid, or this test would pass for the
    // wrong reason.
    expect(issues(r)).toEqual([["producer", PRODUCER_MESSAGE]]);
  });

  it("rejects a producer name with a trailing hyphen", () => {
    const r = sourceSchema.safeParse({ ...valid, producer: "stellar-indexer-" });
    expect(r.success).toBe(false);
    expect(issues(r)).toEqual([["producer", PRODUCER_MESSAGE]]);
  });

  it("rejects a producer name with a double hyphen", () => {
    const r = sourceSchema.safeParse({ ...valid, producer: "stellar--indexer" });
    expect(r.success).toBe(false);
    expect(issues(r)).toEqual([["producer", PRODUCER_MESSAGE]]);
  });

  it("rejects a fetch time with a UTC offset; timestamps are Z-only", () => {
    const r = sourceSchema.safeParse({ ...valid, fetchedAt: "2026-09-05T12:00:00.000+02:00" });
    expect(r.success).toBe(false);
    expect(issues(r).map(([path]) => path)).toEqual(["fetchedAt"]);
  });
});
