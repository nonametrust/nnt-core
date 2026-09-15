import { describe, it, expect } from "vitest";
import { HorizonClient, HorizonStatusError, RetentionBoundary } from "./client.js";
import { HorizonReader, cursorForLedger, ledgerOfOperation } from "./reader.js";
import { fixedClock } from "../clock.js";
import { Counters } from "../counters.js";
import { effectRecord, fakeHorizon, nextOpId, paymentRecord } from "./fixtures.js";
import { muxedFor, randomAccount } from "../testing/keys.js";

// A floor far below any ledger these tests use, so assertServed's strict,
// unconditional lookup (Task 9 fix round 1, finding 3) never blocks a test
// that has nothing to say about retention. A test that cares about the
// retention wall supplies its own "/ledgers" route, which wins over this one.
const DEFAULT_LEDGERS = [{ paging_token: "1", sequence: 1, closed_at: "2025-01-01T00:00:00Z" }];

function reader(routes: Parameters<typeof fakeHorizon>[0]) {
  const counters = new Counters();
  const client = new HorizonClient({
    baseUrl: "https://h.example", clock: fixedClock(new Date("2026-09-08T00:00:00.000Z")), counters,
    fetch: fakeHorizon({ "/ledgers": DEFAULT_LEDGERS, ...routes }), sleep: async () => {}, minIntervalMs: 0,
  });
  return { r: new HorizonReader(client, counters), counters };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("operation ids", () => {
  it("encode the ledger in the high 32 bits", () => {
    expect(ledgerOfOperation(nextOpId(58_021_921, 3))).toBe(58_021_921);
    expect(cursorForLedger(100)).toBe((100n << 32n).toString());
  });
});

describe("HorizonReader.payments", () => {
  it("normalises a payment, a strict-send path payment and a create_account", async () => {
    const g = randomAccount();
    const rows = [
      paymentRecord({ id: nextOpId(100, 1), to: g, transaction: { hash: "aa".repeat(32), memo_type: "text", memo: "hi" } }),
      paymentRecord({ id: nextOpId(101, 1), type: "path_payment_strict_send", from: g, source_amount: "1.0000000", source_asset_type: "native" }),
      paymentRecord({ id: nextOpId(102, 1), type: "create_account", account: g, funder: randomAccount(), starting_balance: "5.0000000", from: undefined, to: undefined, amount: undefined, asset_type: undefined, asset_code: undefined, asset_issuer: undefined }),
    ];
    const { r } = reader({ [`/accounts/${g}/payments`]: rows });
    const got = await collect(r.payments(g, { from: 100, to: 102 }));
    expect(got.map((p) => p.kind)).toEqual(["payment", "path_payment", "create_account"]);
    expect(got[0]).toMatchObject({ ledger: 100, createdAt: "2026-09-01T08:00:05.000Z", asset: { code: "USDC" }, memo: { type: "text", text: "hi" } });
    expect(got[1]).toMatchObject({ sourceAmount: "1.0000000", sourceAsset: { code: "XLM", issuer: null } });
    expect(got[2]).toMatchObject({ to: g, amount: "5.0000000", asset: { code: "XLM", issuer: null } });
  });

  it("stops at the end of the range and skips records before it", async () => {
    const g = randomAccount();
    const rows = [99, 100, 101, 102].map((l) => paymentRecord({ id: nextOpId(l, 1), to: g }));
    const { r } = reader({ [`/accounts/${g}/payments`]: rows });
    const got = await collect(r.payments(g, { from: 100, to: 101 }));
    expect(got.map((p) => p.ledger)).toEqual([100, 101]);
  });

  it("carries the muxed id and keeps the base address in to", async () => {
    const g = randomAccount();
    const rows = [paymentRecord({ id: nextOpId(100, 1), to: g, to_muxed_id: "77" })];
    const { r } = reader({ [`/accounts/${g}/payments`]: rows });
    const [p] = await collect(r.payments(g, { from: 100, to: 100 }));
    expect(p).toMatchObject({ to: g, toMuxedId: "77" });
  });

  it("resolves a muxed address in to, when a source ever sends one, to base plus id", async () => {
    const g = randomAccount();
    const rows = [paymentRecord({ id: nextOpId(100, 1), to: muxedFor(g, "5") })];
    const { r } = reader({ [`/accounts/${g}/payments`]: rows });
    const [p] = await collect(r.payments(g, { from: 100, to: 100 }));
    expect(p).toMatchObject({ to: g, toMuxedId: "5" });
  });

  it("expands a Soroban invocation into one sac_transfer per transfer entry and counts the rest", async () => {
    const g = randomAccount();
    const issuer = randomAccount();
    const rows = [paymentRecord({
      id: nextOpId(100, 1), type: "invoke_host_function", from: undefined, to: undefined, amount: undefined,
      asset_balance_changes: [
        { type: "transfer", from: randomAccount(), to: g, amount: "1.0000000", asset_type: "credit_alphanum4", asset_code: "KALE", asset_issuer: issuer },
        { type: "mint", to: g, amount: "2.0000000", asset_type: "credit_alphanum4", asset_code: "KALE", asset_issuer: issuer },
        { type: "transfer", from: g, to: randomAccount(), amount: "0.5000000", asset_type: "credit_alphanum4", asset_code: "KALE", asset_issuer: issuer },
      ],
    })];
    const { r, counters } = reader({ [`/accounts/${g}/payments`]: rows });
    const got = await collect(r.payments(g, { from: 100, to: 100 }));
    expect(got.map((p) => [p.kind, p.transferIndex])).toEqual([["sac_transfer", 0], ["sac_transfer", 2]]);
    expect(counters.drops()["sac_non_transfer"]).toBe(1);
  });

  it("counts a record type it does not handle", async () => {
    const g = randomAccount();
    const rows = [paymentRecord({ id: nextOpId(100, 1), type: "account_merge", to: g })];
    const { r, counters } = reader({ [`/accounts/${g}/payments`]: rows });
    expect(await collect(r.payments(g, { from: 100, to: 100 }))).toEqual([]);
    expect(counters.drops()["unsupported_type"]).toBe(1);
  });

  it("skips a failed transaction's records and counts them", async () => {
    const g = randomAccount();
    const rows = [paymentRecord({ id: nextOpId(100, 1), to: g, transaction_successful: false })];
    const { r, counters } = reader({ [`/accounts/${g}/payments`]: rows });
    expect(await collect(r.payments(g, { from: 100, to: 100 }))).toEqual([]);
    expect(counters.get("records_failed_tx")).toBe(1);
  });

  it("raises RetentionBoundary when the range starts before the retention floor", async () => {
    const g = randomAccount();
    const { r } = reader({
      [`/accounts/${g}/payments`]: [],
      "/ledgers": [{ paging_token: "1", sequence: 500, closed_at: "2025-07-16T02:48:49Z" }],
    });
    await expect(collect(r.payments(g, { from: 100, to: 200 }))).rejects.toBeInstanceOf(RetentionBoundary);
  });
});

describe("HorizonReader.globalPayments", () => {
  it("counts a failed transaction the same way the account scan does", async () => {
    const rows = [
      paymentRecord({ id: nextOpId(100, 1), transaction_successful: true }),
      paymentRecord({ id: nextOpId(100, 2), transaction_successful: false }),
    ];
    const { r, counters } = reader({ "/payments": rows });
    const got = await collect(r.globalPayments({ from: 100, to: 100 }));
    expect(got.length).toBe(1);
    expect(counters.get("records_failed_tx")).toBe(1);
    expect(counters.get("records_read.payment")).toBe(2);
  });
});

describe("HorizonReader.effects", () => {
  it("normalises trustline and claimable effects and ignores the rest", async () => {
    const g = randomAccount();
    const issuer = randomAccount();
    const op = nextOpId(100, 1);
    const rows = [
      effectRecord({ id: `${op}-0000000001`, paging_token: `${op}-1`, account: g, asset_issuer: issuer }),
      effectRecord({ id: `${op}-0000000002`, paging_token: `${op}-2`, account: g, type: "claimable_balance_claimant_created", asset: `KALE:${issuer}`, amount: "3.0000000", asset_type: undefined, asset_code: undefined, asset_issuer: undefined }),
      effectRecord({ id: `${op}-0000000003`, paging_token: `${op}-3`, account: g, type: "account_credited", asset_type: "native", asset_code: undefined, asset_issuer: undefined }),
    ];
    const { r, counters } = reader({ [`/accounts/${g}/effects`]: rows });
    const got = await collect(r.effects(g, { from: 100, to: 100 }));
    expect(got.map((e) => e.type)).toEqual(["trustline_created", "claimable_balance_claimant_created"]);
    expect(got[0]).toMatchObject({ opId: op, ledger: 100, asset: { code: "USDC", issuer } });
    expect(got[1]).toMatchObject({ asset: { code: "KALE", issuer }, amount: "3.0000000" });
    expect(counters.drops()["effect_ignored"]).toBe(1);
  });
});

describe("HorizonReader.memo and ledgers", () => {
  it("reads a memo off a transaction", async () => {
    const hash = "cd".repeat(32);
    const { r } = reader({ [`/transactions/${hash}`]: { status: 200, body: { hash, memo_type: "text", memo: "x" } } });
    expect(await r.memo(hash)).toEqual({ txHash: hash, type: "text", text: "x" });
  });

  it("does not mistake a status buried in the url for a 404: a real error rejects rather than resolving null", async () => {
    const hash = "a404" + "b".repeat(60);
    const { r } = reader({ [`/transactions/${hash}`]: { status: 500 } });
    await expect(r.memo(hash)).rejects.toBeInstanceOf(HorizonStatusError);
  });

  it("reads the retention floor and the latest ledger", async () => {
    const { r } = reader({ "/ledgers": [
      { paging_token: "1", sequence: 500, closed_at: "2025-07-16T02:48:49Z" },
      { paging_token: "2", sequence: 900, closed_at: "2026-09-08T09:35:34Z" },
    ] });
    expect(await r.retentionFloor()).toBe(500);
  });

  it("resolves an instant range to ledger sequences by bisection", async () => {
    // Ledgers 500..900 close five seconds apart from 2025-07-16T02:48:49Z.
    const t0 = Date.parse("2025-07-16T02:48:49Z");
    const routes: Record<string, unknown> = {
      "/ledgers": [
        { paging_token: "1", sequence: 500, closed_at: "2025-07-16T02:48:49Z" },
        { paging_token: "2", sequence: 900, closed_at: new Date(t0 + 400 * 5000).toISOString() },
      ],
    };
    for (let s = 500; s <= 900; s++) {
      routes[`/ledgers/${s}`] = { status: 200, body: { sequence: s, closed_at: new Date(t0 + (s - 500) * 5000).toISOString() } };
    }
    const { r } = reader(routes as Parameters<typeof fakeHorizon>[0]);
    const range = await r.resolveRange(new Date(t0 + 100 * 5000).toISOString(), new Date(t0 + 200 * 5000 + 1).toISOString());
    expect(range).toEqual({ from: 600, to: 700 });
  });
});
