/**
 * The indexer's own view of a chain event, already normalised: amounts as
 * decimal strings, instants as ISO UTC with Z, the muxed identifier as its own
 * field, the asset as code plus issuer. Horizon's field names stop at the
 * reader's boundary (spec section 2); the mapper never sees a Horizon record.
 */

/** A base G account id. */
export type AccountId = string;

/** A ledger sequence span, inclusive on both ends. */
export interface LedgerRange {
  from: number;
  to: number;
}

/** An asset by code and issuer; native XLM carries a null issuer. */
export interface SourceAsset {
  code: string;
  issuer: string | null;
}

/** The memo kinds Horizon reports on a transaction. */
export type MemoType = "none" | "text" | "id" | "hash" | "return";

/** A transaction's memo, keyed by the transaction hash that carried it. */
export interface SourceMemo {
  txHash: string;
  type: MemoType;
  text?: string;
}

/** The payment-family operation kinds the indexer follows. */
export type PaymentKind = "payment" | "path_payment" | "create_account" | "sac_transfer";

/** A normalised payment-family record: what `to` received, and optionally what `from` sent. */
export interface SourcePayment {
  opId: string;
  ledger: number;
  txHash: string;
  createdAt: string; // ISO UTC, ends in Z
  kind: PaymentKind;
  from: AccountId;
  to: AccountId;
  fromMuxedId?: string;
  toMuxedId?: string;
  amount: string; // what `to` received
  asset: SourceAsset;
  sourceAmount?: string; // path payments: what `from` sent
  sourceAsset?: SourceAsset;
  memo?: SourceMemo; // present when the source joined the transaction
  /** sac_transfer only: position inside the invocation's asset_balance_changes */
  transferIndex?: number;
}

/** The effect kinds the indexer follows. */
export type EffectType =
  | "trustline_created"
  | "trustline_removed"
  | "trustline_updated"
  | "claimable_balance_claimant_created"
  | "account_flags_updated";

/** A normalised effect record on one account. */
export interface SourceEffect {
  effectId: string;
  opId: string;
  ledger: number;
  createdAt: string;
  account: AccountId;
  type: EffectType;
  asset?: SourceAsset;
  amount?: string;
}
