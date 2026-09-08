import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { KeySet, compareKeys, readKeys } from "./dedupe.js";

const dir = mkdtempSync(join(tmpdir(), "nnt-dedupe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("KeySet", () => {
  it("reports the second arrival of a key", () => {
    const s = new KeySet();
    expect(s.add("k1")).toBe(true);
    expect(s.add("k1")).toBe(false);
    expect(s.size()).toBe(1);
  });
});

describe("readKeys and compareKeys", () => {
  it("reads the idempotency key off every line and compares two runs as sets", async () => {
    const p = join(dir, "a.ndjson");
    writeFileSync(p, [JSON.stringify({ idempotencyKey: "a" }), JSON.stringify({ idempotencyKey: "b" }), ""].join("\n"));
    const prev = await readKeys(p);
    expect([...prev].sort()).toEqual(["a", "b"]);
    const cmp = compareKeys(prev, new Set(["b", "c"]));
    expect(cmp).toEqual({ onlyInPrevious: ["a"], onlyInCurrent: ["c"] });
  });

  it("refuses a line without a key, because that is not a validated observation", async () => {
    const p = join(dir, "b.ndjson");
    writeFileSync(p, JSON.stringify({ schemaVersion: "0.1.0" }) + "\n");
    await expect(readKeys(p)).rejects.toThrow(/line 1/);
  });
});
