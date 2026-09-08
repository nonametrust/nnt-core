import { describe, it, expect } from "vitest";
import { Counters } from "./counters.js";

describe("Counters", () => {
  it("counts by name, starting at zero", () => {
    const c = new Counters();
    expect(c.get("records_read.payment")).toBe(0);
    c.inc("records_read.payment");
    c.inc("records_read.payment", 2);
    expect(c.get("records_read.payment")).toBe(3);
  });

  it("records a drop with its reason and keeps a bounded sample of refs", () => {
    const c = new Counters();
    for (let i = 0; i < 12; i++) c.drop("memo_non_text", `tx:${i}`);
    const s = c.snapshot();
    expect(s.drops["memo_non_text"]).toBe(12);
    expect(s.dropSamples["memo_non_text"]).toHaveLength(10);
    expect(s.dropSamples["memo_non_text"]?.[0]).toBe("tx:0");
  });

  it("snapshots are plain data with sorted keys, so two runs diff cleanly", () => {
    const c = new Counters();
    c.inc("b");
    c.inc("a");
    expect(Object.keys(c.snapshot().counts)).toEqual(["a", "b"]);
  });
});
