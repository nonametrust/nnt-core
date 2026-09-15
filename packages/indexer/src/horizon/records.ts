// The raw shapes the reader accepts, as horizon.stellar.org emitted them on
// 2026-09-08 (sampled live: payment, path_payment_strict_send, create_account,
// invoke_host_function with asset_balance_changes; effects trustline_created
// and trustline_removed; a transaction joined onto a payment with memo_type
// and memo). Only modules inside horizon/ import this file (gates/no-horizon-
// outside-reader.test.ts enforces it at the root).

export interface HorizonPaymentRecord {
  id: string;
  paging_token: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful: boolean;
  source_account: string;
  from?: string;
  to?: string;
  from_muxed_id?: string;
  to_muxed_id?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  account?: string;
  funder?: string;
  starting_balance?: string;
  asset_balance_changes?: Array<{
    type: string;
    from?: string;
    to?: string;
    amount: string;
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    destination_muxed_id?: string;
  }>;
  transaction?: { hash: string; memo_type: string; memo?: string };
}

export interface HorizonEffectRecord {
  id: string;
  paging_token: string;
  type: string;
  created_at: string;
  account: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  asset?: string;
  amount?: string;
}
