import { describe, it, expect } from "vitest";
import { KNOWN_ISSUERS, isKnownIssuer, issuerDigest } from "./issuers.js";
import { randomAccount } from "../testing/keys.js";

describe("known issuers", () => {
  it("holds digests, never addresses, so the list can be tracked", () => {
    for (const k of KNOWN_ISSUERS) {
      expect(k.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(k.assetCode.length).toBeGreaterThan(0);
    }
  });

  it("recognises an issuer by digest", () => {
    // The list cannot name a real issuer, so the gate is proved on a key made
    // here: its digest is pushed into a copy of the list and looked up.
    const g = randomAccount();
    expect(isKnownIssuer(g)).toBe(false);
    expect(isKnownIssuer(g, [{ digest: issuerDigest(g), assetCode: "TEST", homeDomain: "test.example", note: "test" }])).toBe(true);
  });

  it("names USDC by its issuer digest", () => {
    expect(KNOWN_ISSUERS.some((k) => k.assetCode === "USDC" && k.homeDomain === "centre.io")).toBe(true);
  });
});
