import { createHash } from "node:crypto";
import type { AccountId, LedgerRange, SourcePayment } from "./source/types.js";

/**
 * The followed accounts for the 100-account backfill are ordinary active
 * wallets chosen by a rule, because the list itself cannot be tracked (it is
 * made of account ids) and the population must be reproducible by anyone
 * from the rule and the ledger range (spec section 9). Accounts that appear
 * too often in the sample window have the exchange and service profile the
 * backtest excluded; they are dropped. The rest are ordered by the digest of
 * their id, which is a fixed order that favours nobody.
 */
export interface SelectionSource {
  globalPayments(range: LedgerRange): AsyncIterable<SourcePayment>;
  accountExists(id: AccountId): Promise<boolean>;
}

export interface SelectionOptions {
  range: LedgerRange;
  n: number;
  maxAppearances: number;
}

export interface SelectionResult {
  accounts: AccountId[];
  candidates: number;
  excludedBusy: number;
  excludedMissing: number;
}

export function orderKey(account: AccountId): string {
  return createHash("sha256").update(account).digest("hex");
}

export async function selectAccounts(source: SelectionSource, opts: SelectionOptions): Promise<SelectionResult> {
  const appearances = new Map<AccountId, number>();
  for await (const p of source.globalPayments(opts.range)) {
    if (p.kind === "sac_transfer") continue;
    for (const a of [p.from, p.to]) appearances.set(a, (appearances.get(a) ?? 0) + 1);
  }
  const result: SelectionResult = { accounts: [], candidates: appearances.size, excludedBusy: 0, excludedMissing: 0 };
  const ordered = [...appearances.entries()]
    .filter(([, n]) => {
      const keep = n <= opts.maxAppearances;
      if (!keep) result.excludedBusy++;
      return keep;
    })
    .map(([a]) => a)
    .sort((x, y) => orderKey(x).localeCompare(orderKey(y)));
  for (const a of ordered) {
    if (result.accounts.length >= opts.n) break;
    if (await source.accountExists(a)) result.accounts.push(a);
    else result.excludedMissing++;
  }
  return result;
}
