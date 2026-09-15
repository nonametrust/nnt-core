import { describe, it, expect } from "vitest";
import { exitCodeFor, main } from "./cli.js";
import { IdentityError } from "./run.js";

describe("cli", () => {
  it("prints usage and exits 2 on an unknown command", async () => {
    const out: string[] = [];
    const code = await main(["nope"], {}, { log: (s) => out.push(s), error: (s) => out.push(s) });
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/select-accounts|backfill/);
  });

  it("refuses a network it does not know", async () => {
    const out: string[] = [];
    const code = await main(["backfill", "--network", "stellar:moon", "--accounts", "x", "--from", "2026-08-01", "--to", "2026-08-02"], {}, { log: (s) => out.push(s), error: (s) => out.push(s) });
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/stellar:pubnet/);
  });

  it("exits 3 on a broken identity and 1 on any other failure", () => {
    expect(exitCodeFor(new IdentityError("payments", 4, 3, 0))).toBe(3);
    expect(exitCodeFor(new Error("Horizon unreachable"))).toBe(1);
  });

  it("refuses a non-numeric --max-retries", async () => {
    const out: string[] = [];
    const code = await main(
      ["backfill", "--network", "stellar:testnet", "--accounts", "x", "--from", "2026-08-01", "--to", "2026-08-02", "--max-retries", "abc"],
      {},
      { log: (s) => out.push(s), error: (s) => out.push(s) },
    );
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/--max-retries must be a number/);
  });
});
