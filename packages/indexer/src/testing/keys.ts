import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";

// A real-shaped account id can never sit in a tracked file (root gate), so
// every test builds its ids here at run time. Nothing in this module is
// imported by production code.
export function randomAccount(): string {
  return Keypair.random().publicKey();
}

export function muxedFor(base: string, id: string): string {
  return new MuxedAccount(new Account(base, "0"), id).accountId();
}
