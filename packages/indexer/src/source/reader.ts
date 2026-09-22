import type { AccountId, LedgerRange, SourceEffect, SourcePayment } from "./types.js";

/**
 * The one seam between the chain and the mapper. Horizon is the first
 * implementation and is on its way out (issue #3); the second backend
 * implements this interface and nothing above it changes.
 *
 * There is no `memo()` here. One was declared for the case where a payment
 * record arrives without its transaction, and no caller ever appeared: the
 * scan asks Horizon for `join=transactions` and the memo rides on the record.
 * A method on this interface is work every future backend owes, so an unused
 * one is a bill nobody is paying for. It comes back the day a reader cannot
 * join, together with the caller that needs it.
 */
export interface SourceReader {
  /** Payment-family records touching `account` inside the range, oldest first. */
  payments(account: AccountId, range: LedgerRange): AsyncIterable<SourcePayment>;
  /** Effects on `account` inside the range: trustline, claimable balance, account flags. */
  effects(account: AccountId, range: LedgerRange): AsyncIterable<SourceEffect>;
  /** The oldest ledger the source serves; distinguishes "before retention" from "empty". */
  retentionFloor(): Promise<number>;
}
