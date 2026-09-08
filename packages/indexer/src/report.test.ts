import { describe, it, expect } from "vitest";
import { renderReport } from "./report.js";
import { Counters } from "./counters.js";
import { randomAccount } from "./testing/keys.js";

const meta = {
  network: "stellar:pubnet" as const, fromIso: "2026-08-01T00:00:00.000Z", toIso: "2026-08-31T00:00:00.000Z",
  range: { from: 100, to: 200 }, retentionFloor: 50, runDate: "2026-09-08T00:00:00.000Z", accounts: 100, wallClockMs: 1234,
};

describe("renderReport", () => {
  it("renders the delivery table with the measured numbers", () => {
    const c = new Counters();
    c.inc("records_read.payments", 10);
    c.inc("observations_written.volume", 8);
    c.inc("muxed_records", 2);
    c.inc("muxed_resolved", 2);
    c.inc("requests", 40);
    c.drop("memo_non_text", "tx:1");
    const { markdown, json } = renderReport(c.snapshot(), meta);
    expect(markdown).toContain("| Coverage | 100 accounts");
    expect(markdown).toContain("| Coverage ratio | 0.80");
    expect(markdown).toContain("| Muxed share | 2 of 10 (0.20), 2 resolved");
    expect(markdown).toContain("memo_non_text | 1");
    expect(JSON.parse(json)).toMatchObject({ meta, counts: { requests: 40 } });
  });

  it("never renders an account id, even when a drop sample carried one", () => {
    const c = new Counters();
    c.drop("invalid_account_id", `op:1 ${randomAccount()}`);
    const { markdown, json } = renderReport(c.snapshot(), meta);
    const shape = /G[A-Z2-7]{55}|M[A-Z2-7]{68}/;
    expect(markdown).not.toMatch(shape);
    expect(json).not.toMatch(shape);
  });
});
