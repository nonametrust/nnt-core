import { createHash } from "node:crypto";

/**
 * `issuerKnown` on a protocol observation says whether the asset's issuer is
 * one the producer recognises (contract section 6). The list is short on
 * purpose and it holds sha256 digests of issuer addresses rather than the
 * addresses, because an issuer address is a Stellar account id and the root
 * gate refuses that shape in any tracked file. A reader identifies an entry
 * by asset code and home domain; the mapper hashes the issuer it sees and
 * looks the digest up.
 *
 * To add an entry: `printf '%s' "$ISSUER" | shasum -a 256`, and record where
 * the address was read from.
 */
export interface KnownIssuer {
  digest: string;
  assetCode: string;
  homeDomain: string;
  note: string;
}

export const KNOWN_ISSUERS: readonly KnownIssuer[] = [
  {
    // Circle's USDC on pubnet. Address read from horizon.stellar.org/assets?asset_code=USDC
    // on 2026-09-08 (the issuer with 2.39M authorized trustlines) and confirmed
    // against Circle's published Stellar issuer.
    digest: "21a69b39409ada7a918f60199db819ed7a2c4f11f049c48dca37e3db2688adad",
    assetCode: "USDC",
    homeDomain: "centre.io",
    note: "Circle USDC, pubnet",
  },
];

export function issuerDigest(issuer: string): string {
  return createHash("sha256").update(issuer).digest("hex");
}

export function isKnownIssuer(issuer: string, list: readonly KnownIssuer[] = KNOWN_ISSUERS): boolean {
  const d = issuerDigest(issuer);
  return list.some((k) => k.digest === d);
}
