import { describe, it, expect } from "vitest";
import { renderReport } from "./report.js";
import { Counters } from "./counters.js";
import { randomAccount, randomContract } from "./testing/keys.js";

const meta = {
  network: "stellar:pubnet" as const, fromIso: "2026-08-01T00:00:00.000Z", toIso: "2026-08-31T00:00:00.000Z",
  range: { from: 100, to: 200 }, retentionFloor: 50, runDate: "2026-09-08T00:00:00.000Z", accounts: 100, wallClockMs: 1234,
  mode: "backfill" as const,
};

describe("renderReport", () => {
  it("renders the delivery table with the measured numbers", () => {
    const c = new Counters();
    c.inc("records_read.payments", 10);
    c.inc("observations_written.volume", 8);
    c.inc("muxed_records", 2);
    c.inc("muxed_followed", 1);
    c.inc("muxed_resolved", 1);
    c.inc("written.payments", 8);
    c.inc("dropped.payments", 2);
    c.inc("requests", 40);
    c.drop("memo_non_text", "tx:1");
    const { markdown, json } = renderReport(c.snapshot(), meta);
    expect(markdown).toContain("| Coverage | 100 accounts");
    expect(markdown).toContain("| Coverage ratio | 0.80");
    expect(markdown).toContain("| Muxed share | 2 of 10 records carried a muxed side (0.20), 1 on the followed side, 1 resolved");
    expect(markdown).toContain("| Identity | payments 10 = 8 + 2; memos 0 = 0 + 0; effects 0 = 0 + 0 |");
    expect(markdown).toContain("memo_non_text | 1");
    expect(JSON.parse(json)).toMatchObject({ meta, counts: { requests: 40 } });
  });

  it("never renders an account or contract id, even when a drop sample carried one", () => {
    const c = new Counters();
    c.drop("invalid_account_id", `op:1 ${randomAccount()}`);
    // The other side of a Soroban transfer is routinely a contract, so a
    // `not_followed` sample carries a C-shaped id and it must be scrubbed
    // exactly like an account id (root gate, same shapes).
    c.drop("not_followed", `op:2#0 ${randomContract()}`);
    const { markdown, json } = renderReport(c.snapshot(), meta);
    const shape = /G[A-Z2-7]{55}|M[A-Z2-7]{68}|C[A-Z2-7]{55}/;
    expect(markdown).not.toMatch(shape);
    expect(json).not.toMatch(shape);
  });

  it("does not claim a period for a follow run: ledgers, not days", () => {
    const c = new Counters();
    const followMeta = { ...meta, mode: "follow" as const, fromIso: meta.runDate, toIso: meta.runDate };
    const { markdown } = renderReport(c.snapshot(), followMeta);
    expect(markdown).toContain("(follow)");
    expect(markdown).not.toMatch(/ days/);
  });
});
