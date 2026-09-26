import type { AccountId, LedgerRange, SourceEffect, SourceMemo, SourcePayment } from "./types.js";

/**
 * The one seam between the chain and the mapper. Horizon is the first
 * implementation and is on its way out (issue #3); the second backend
 * implements this interface and nothing above it changes.
 */
export interface SourceReader {
  /** Payment-family records touching `account` inside the range, oldest first. */
  payments(account: AccountId, range: LedgerRange): AsyncIterable<SourcePayment>;
  /** Effects on `account` inside the range: trustline, claimable balance, account flags. */
  effects(account: AccountId, range: LedgerRange): AsyncIterable<SourceEffect>;
  /** The memo of one transaction, when the payment record did not carry it. */
  memo(txHash: string): Promise<SourceMemo | null>;
  /** The oldest ledger the source serves; distinguishes "before retention" from "empty". */
  retentionFloor(): Promise<number>;
}
