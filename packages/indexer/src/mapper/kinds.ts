/**
 * One spelling per source event type, chosen once (contract section 12). The
 * schema checks only that `kind` is non-empty, so a second spelling anywhere
 * would validate and silently split evidence. Every mapper imports from here
 * and never writes a kind literal.
 */
export const KINDS = {
  payment: "payment",
  pathPayment: "path_payment",
  createAccount: "create_account",
  sacTransfer: "sac_transfer",
  memo: "memo",
  trustlineOpen: "trustline_open",
  trustlineClosed: "trustline_closed",
  claimableBalanceOffered: "claimable_balance_offered",
  accountFlagsChanged: "account_flags_changed",
} as const;
export type Kind = (typeof KINDS)[keyof typeof KINDS];
