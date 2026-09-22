import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import type { AccountId } from "../source/types.js";

/**
 * The contract leaves two identity rules to the indexer and says so (section
 * 11, item 1): a wallet namespace id is a checksum-valid base account, and a
 * muxed address is resolved to its base with the sub-account id carried in
 * `muxedId`. The schema refuses the muxed shape from 0.2.0 on but never
 * checksums; these helpers are the indexer's gate for both.
 *
 * A contract address (C..., `StrKey.isValidContract`) is a valid counterparty
 * of a Soroban transfer — a pool or a DEX contract routinely stands on the
 * other side of a transfer entry — but it is never a namespace id: only a
 * base account is followed.
 */
export function isBaseAccount(id: string): boolean {
  return StrKey.isValidEd25519PublicKey(id);
}

export function isMuxedAccount(id: string): boolean {
  return StrKey.isValidMed25519PublicKey(id);
}

export function isContractAddress(id: string): boolean {
  return StrKey.isValidContract(id);
}

export function resolveAccount(id: string): { base: AccountId; muxedId?: string } | null {
  if (isBaseAccount(id)) return { base: id };
  if (isMuxedAccount(id)) {
    const m = MuxedAccount.fromAddress(id, "0");
    return { base: m.baseAccount().accountId(), muxedId: m.id() };
  }
  return null;
}
