import { describe, it, expect } from "vitest";
import { isBaseAccount, isContractAddress, isMuxedAccount, resolveAccount } from "./address.js";
import { muxedFor, randomAccount, randomContract } from "../testing/keys.js";

describe("address helpers", () => {
  it("accepts a checksum-valid base account and refuses a corrupted one", () => {
    const g = randomAccount();
    expect(isBaseAccount(g)).toBe(true);
    const corrupted = g.slice(0, -1) + (g.endsWith("A") ? "B" : "A");
    expect(isBaseAccount(corrupted)).toBe(false);
  });

  it("refuses a short synthetic id as a base account", () => {
    expect(isBaseAccount("GOLDADDRESS")).toBe(false);
  });

  it("recognises a muxed account and resolves it to base plus id", () => {
    const g = randomAccount();
    const m = muxedFor(g, "12345");
    expect(isMuxedAccount(m)).toBe(true);
    expect(isBaseAccount(m)).toBe(false);
    expect(resolveAccount(m)).toEqual({ base: g, muxedId: "12345" });
  });

  it("resolves a base account to itself with no muxed id", () => {
    const g = randomAccount();
    expect(resolveAccount(g)).toEqual({ base: g });
  });

  it("returns null for anything else", () => {
    expect(resolveAccount("not-an-address")).toBeNull();
    expect(resolveAccount("")).toBeNull();
  });

  it("recognises a contract address but never resolves it as a namespace id", () => {
    const c = randomContract();
    expect(isContractAddress(c)).toBe(true);
    expect(isBaseAccount(c)).toBe(false);
    expect(resolveAccount(c)).toBeNull();
  });
});
