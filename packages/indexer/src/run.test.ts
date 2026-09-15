import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { backfill } from "./run.js";
import { openSink } from "./sink.js";
import { readKeys } from "./dedupe.js";
import { Counters } from "./counters.js";
import { fixedClock } from "./clock.js";
import type { IndexerState } from "./state.js";
import type { SourceReader } from "./source/reader.js";
import type { LedgerRange, SourceEffect, SourcePayment } from "./source/types.js";
import { randomAccount } from "./testing/keys.js";

const dir = mkdtempSync(join(tmpdir(), "nnt-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeReader(payments: SourcePayment[], effects: SourceEffect[]): SourceReader {
  return {
    async *payments(account) { for (const p of payments) if (p.from === account || p.to === account) yield p; },
    async *effects(account) { for (const e of effects) if (e.account === account) yield e; },
    async memo() { return null; },
    async retentionFloor() { return 1; },
  };
}

function scenario() {
  const g = randomAccount();
  const other = randomAccount();
  const hash = "ab".repeat(32);
  const payments: SourcePayment[] = [
    { opId: "100", ledger: 10, txHash: hash, createdAt: "2026-09-01T00:00:00.000Z", kind: "payment", from: other, to: g,
      amount: "1.0000000", asset: { code: "XLM", issuer: null }, memo: { txHash: hash, type: "text", text: "airdrop" } },
    { opId: "101", ledger: 10, txHash: hash, createdAt: "2026-09-01T00:00:00.000Z", kind: "payment", from: other, to: g,
      amount: "2.0000000", asset: { code: "XLM", issuer: null }, memo: { txHash: hash, type: "text", text: "airdrop" } },
    { opId: "102", ledger: 11, txHash: "cd".repeat(32), createdAt: "2026-09-02T00:00:00.000Z", kind: "payment", from: g, to: other,
      amount: "0.5000000", asset: { code: "XLM", issuer: null }, memo: { txHash: "cd".repeat(32), type: "id" } },
  ];
  const effects: SourceEffect[] = [
    { effectId: "0103-0000000001", opId: "103", ledger: 12, createdAt: "2026-09-03T00:00:00.000Z", account: g,
      type: "trustline_created", asset: { code: "USDC", issuer: randomAccount() } },
  ];
  return { g, other, payments, effects };
}

async function run(path: string, s: ReturnType<typeof scenario>, state: IndexerState, force = false) {
  const counters = new Counters();
  const sink = openSink(path);
  const result = await backfill({
    reader: fakeReader(s.payments, s.effects), accounts: [s.g], range: { from: 10, to: 12 },
    ctx: { network: "stellar:pubnet", producerVersion: "0.1.0" }, sink, state, saveState: async () => {},
    counters, clock: fixedClock(new Date("2026-09-08T00:00:00.000Z")), force,
  });
  await sink.close();
  return { result, counters };
}

describe("backfill", () => {
  it("writes validated observations for one account: two volume in, one out, one memo, one trustline", async () => {
    const s = scenario();
    const state: IndexerState = { network: "stellar:pubnet", accounts: {} };
    const { result, counters } = await run(join(dir, "a.ndjson"), s, state);
    expect(result.written).toBe(5);
    const lines = readFileSync(join(dir, "a.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.channel).sort()).toEqual(["content", "protocol", "volume", "volume", "volume"]);
    expect(lines.every((l) => typeof l.idempotencyKey === "string")).toBe(true);
    expect(counters.get("observations_written.volume")).toBe(3);
    expect(counters.drops()["memo_non_text"]).toBe(1);
    expect(state.accounts[s.g]?.completed).toEqual([{ from: 10, to: 12 }]);
  });

  it("emits the memo once for a transaction with two payments", async () => {
    const s = scenario();
    const { counters } = await run(join(dir, "b.ndjson"), s, { network: "stellar:pubnet", accounts: {} });
    expect(counters.get("observations_written.content")).toBe(1);
    expect(counters.drops()["duplicate_key_in_run"]).toBeUndefined();
  });

  it("skips an account whose range is complete unless forced, and a forced re-run yields the same keys", async () => {
    const s = scenario();
    const state: IndexerState = { network: "stellar:pubnet", accounts: {} };
    await run(join(dir, "c1.ndjson"), s, state);
    const second = await run(join(dir, "c2.ndjson"), s, state);
    expect(second.result.accountsSkipped).toBe(1);
    const third = await run(join(dir, "c3.ndjson"), s, state, true);
    expect(third.result.written).toBe(5);
    expect([...(await readKeys(join(dir, "c1.ndjson")))].sort()).toEqual([...(await readKeys(join(dir, "c3.ndjson")))].sort());
  });

  it("recognises the lines an interrupted run already wrote instead of appending them again", async () => {
    const s = scenario();
    const path = join(dir, "resume.ndjson");
    const first = await run(path, s, { network: "stellar:pubnet", accounts: {} });
    const linesAfterFirst = readFileSync(path, "utf8").trim().split("\n").length;
    expect(linesAfterFirst).toBe(first.result.written);
    // The interrupted account is re-read from the range start with a fresh
    // state, exactly as a resumed run does it; only the keys already in the
    // file stop the lines from being written twice.
    const counters = new Counters();
    const sink = openSink(path, { append: true });
    const second = await backfill({
      reader: fakeReader(s.payments, s.effects), accounts: [s.g], range: { from: 10, to: 12 },
      ctx: { network: "stellar:pubnet", producerVersion: "0.1.0" }, sink,
      state: { network: "stellar:pubnet", accounts: {} }, saveState: async () => {},
      counters, clock: fixedClock(new Date("2026-09-08T00:00:00.000Z")),
      resumeKeys: await readKeys(path),
    });
    await sink.close();
    expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(linesAfterFirst);
    expect(counters.get("resumed_line_skipped")).toBe(linesAfterFirst);
    expect(second.written).toBe(0);
    expect(counters.drops()["duplicate_key_in_run"]).toBeUndefined();
  });

  it("holds the identity read == written + dropped per stream", async () => {
    const s = scenario();
    const { counters } = await run(join(dir, "d.ndjson"), s, { network: "stellar:pubnet", accounts: {} });
    const c = counters.snapshot();
    // payments: 3 records -> 3 volume; memos: 2 transactions -> 1 written + 1 dropped; effects: 1 -> 1
    expect(c.counts["records_read.payments"]).toBe(3);
    expect(c.counts["observations_written.volume"]).toBe(3);
    expect(c.counts["records_read.memos"]).toBe(2);
    expect((c.counts["observations_written.content"] ?? 0) + (c.drops["memo_non_text"] ?? 0)).toBe(2);
  });

  it("writes a separate volume observation per sac_transfer record of the same operation, and does not count sac_transfers_merged", async () => {
    const g = randomAccount();
    const other = randomAccount();
    const issuer = randomAccount();
    const createdAt = "2026-09-04T00:00:00.000Z";
    const payments: SourcePayment[] = [
      { opId: "200", ledger: 20, txHash: "ef".repeat(32), createdAt, kind: "sac_transfer", from: other, to: g,
        amount: "1.5000000", asset: { code: "USDC", issuer }, transferIndex: 0 },
      { opId: "200", ledger: 20, txHash: "ef".repeat(32), createdAt, kind: "sac_transfer", from: other, to: g,
        amount: "2.5000000", asset: { code: "USDC", issuer }, transferIndex: 1 },
    ];
    const state: IndexerState = { network: "stellar:pubnet", accounts: {} };
    const counters = new Counters();
    const sink = openSink(join(dir, "e.ndjson"));
    const result = await backfill({
      reader: fakeReader(payments, []), accounts: [g], range: { from: 20, to: 20 },
      ctx: { network: "stellar:pubnet", producerVersion: "0.1.0" }, sink, state, saveState: async () => {},
      counters, clock: fixedClock(new Date("2026-09-08T00:00:00.000Z")),
    });
    await sink.close();
    expect(result.written).toBe(2);
    expect(counters.get("observations_written.volume")).toBe(2);
    expect(counters.snapshot().counts["sac_transfers_merged"]).toBeUndefined();
  });

  it("maps a self-payment as one written volume observation, no drops, and counts it as a diagnostic", async () => {
    const g = randomAccount();
    const createdAt = "2026-09-05T00:00:00.000Z";
    const payments: SourcePayment[] = [
      { opId: "300", ledger: 30, txHash: "12".repeat(32), createdAt, kind: "payment", from: g, to: g,
        amount: "3.0000000", asset: { code: "XLM", issuer: null } },
    ];
    const state: IndexerState = { network: "stellar:pubnet", accounts: {} };
    const counters = new Counters();
    const sink = openSink(join(dir, "f.ndjson"));
    const result = await backfill({
      reader: fakeReader(payments, []), accounts: [g], range: { from: 30, to: 30 },
      ctx: { network: "stellar:pubnet", producerVersion: "0.1.0" }, sink, state, saveState: async () => {},
      counters, clock: fixedClock(new Date("2026-09-08T00:00:00.000Z")),
    });
    await sink.close();
    expect(result.written).toBe(1);
    expect(counters.get("observations_written.volume")).toBe(1);
    expect(counters.drops()).toEqual({});
    expect(counters.get("self_payments")).toBe(1);
  });

  it("reads each account from its own frontier when rangeFor is given, not the pooled range", async () => {
    const g1 = randomAccount();
    const g2 = randomAccount();
    const calls: Record<string, LedgerRange[]> = {};
    const reader: SourceReader = {
      async *payments(account, range) {
        (calls[account] ??= []).push(range);
      },
      async *effects(account, range) {
        (calls[account] ??= []).push(range);
      },
      async memo() {
        return null;
      },
      async retentionFloor() {
        return 1;
      },
    };
    const ranges: Record<string, LedgerRange> = { [g1]: { from: 5, to: 10 }, [g2]: { from: 20, to: 30 } };
    const state: IndexerState = { network: "stellar:pubnet", accounts: {} };
    const counters = new Counters();
    const sink = openSink(join(dir, "g.ndjson"));
    await backfill({
      reader, accounts: [g1, g2], range: { from: 1, to: 30 },
      ctx: { network: "stellar:pubnet", producerVersion: "0.1.0" }, sink, state, saveState: async () => {},
      counters, clock: fixedClock(new Date("2026-09-08T00:00:00.000Z")),
      rangeFor: (account) => ranges[account]!,
    });
    await sink.close();
    expect(calls[g1]).toEqual([ranges[g1], ranges[g1]]);
    expect(calls[g2]).toEqual([ranges[g2], ranges[g2]]);
    expect(state.accounts[g1]?.completed).toEqual([ranges[g1]]);
    expect(state.accounts[g2]?.completed).toEqual([ranges[g2]]);
  });
});
