import { describe, it, expect } from "vitest";
import { orderKey, selectAccounts, type SelectionSource } from "./accounts.js";
import type { SourcePayment } from "./source/types.js";
import { randomAccount } from "./testing/keys.js";

function pay(from: string, to: string, i: number): SourcePayment {
  return { opId: String(1000 + i), ledger: 10, txHash: "ab".repeat(32), createdAt: "2026-09-01T00:00:00.000Z",
    kind: "payment", from, to, amount: "1.0000000", asset: { code: "XLM", issuer: null } };
}

function source(payments: SourcePayment[], missing: Set<string> = new Set()): SelectionSource {
  return {
    async *globalPayments() { yield* payments; },
    async accountExists(id) { return !missing.has(id); },
  };
}

describe("selectAccounts", () => {
  it("is deterministic: the same payments select the same accounts in the same order", async () => {
    const accounts = Array.from({ length: 8 }, randomAccount);
    const payments = accounts.map((a, i) => pay(a, accounts[(i + 1) % 8]!, i));
    const a = await selectAccounts(source(payments), { range: { from: 10, to: 10 }, n: 5, maxAppearances: 10 });
    const b = await selectAccounts(source([...payments].reverse()), { range: { from: 10, to: 10 }, n: 5, maxAppearances: 10 });
    expect(a.accounts).toEqual(b.accounts);
    expect(a.accounts).toHaveLength(5);
    expect(a.accounts).toEqual(
      [...a.accounts].sort((x, y) => {
        const kx = orderKey(x);
        const ky = orderKey(y);
        return kx < ky ? -1 : kx > ky ? 1 : 0;
      }),
    );
  });

  it("excludes an account that appears more than maxAppearances times", async () => {
    const busy = randomAccount();
    const quiet = Array.from({ length: 3 }, randomAccount);
    const payments = [...quiet.map((q, i) => pay(q, busy, i)), ...quiet.map((q, i) => pay(busy, q, 10 + i))];
    const r = await selectAccounts(source(payments), { range: { from: 10, to: 10 }, n: 10, maxAppearances: 3 });
    expect(r.accounts).not.toContain(busy);
    expect(r.excludedBusy).toBe(1);
    expect(r.accounts.sort()).toEqual(quiet.sort());
  });

  it("excludes an account Horizon does not know", async () => {
    const gone = randomAccount();
    const here = randomAccount();
    const r = await selectAccounts(source([pay(gone, here, 1)], new Set([gone])), { range: { from: 10, to: 10 }, n: 10, maxAppearances: 10 });
    expect(r.accounts).toEqual([here]);
    expect(r.excludedMissing).toBe(1);
  });

  it("counts a self-payment record once, not twice", async () => {
    const self = randomAccount();
    const r = await selectAccounts(source([pay(self, self, 1)]), { range: { from: 10, to: 10 }, n: 10, maxAppearances: 1 });
    expect(r.candidates).toBe(1);
    expect(r.accounts).toEqual([self]);
    expect(r.excludedBusy).toBe(0);
  });

  it("ignores a sac_transfer record for counting", async () => {
    const from = randomAccount();
    const to = randomAccount();
    const transfer: SourcePayment = { ...pay(from, to, 1), kind: "sac_transfer", transferIndex: 0 };
    const r = await selectAccounts(source([transfer]), { range: { from: 10, to: 10 }, n: 10, maxAppearances: 10 });
    expect(r.candidates).toBe(0);
    expect(r.accounts).toEqual([]);
  });
});
