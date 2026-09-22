import { describe, it, expect } from "vitest";
import { exitCodeFor, followRange, main } from "./cli.js";
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

describe("followRange", () => {
  it("starts an account it has never seen at the retention floor", () => {
    expect(followRange(undefined, 500, 1000)).toEqual({ from: 500, to: 1000 });
    expect(followRange({ completed: [] }, 500, 1000)).toEqual({ from: 500, to: 1000 });
  });

  it("resumes one ledger past the account's own frontier, not the pool's", () => {
    expect(followRange({ completed: [{ from: 500, to: 700 }] }, 500, 1000)).toEqual({ from: 701, to: 1000 });
    expect(followRange({ completed: [{ from: 500, to: 700 }, { from: 701, to: 900 }] }, 500, 1000)).toEqual({ from: 901, to: 1000 });
  });

  it("never reads below a retention wall that has moved past the frontier", () => {
    expect(followRange({ completed: [{ from: 100, to: 200 }] }, 500, 1000)).toEqual({ from: 500, to: 1000 });
  });

  it("returns an empty range for an account already at the head", () => {
    const r = followRange({ completed: [{ from: 500, to: 1000 }] }, 500, 1000);
    expect(r.to).toBeLessThan(r.from);
  });

  it("asks for the new ledgers as soon as the head advances", () => {
    // The regression this covers: with `/ledgers?order=desc&limit=1` served
    // from the cache, `latest` was pinned to the first run's head, every
    // account stayed on the empty range for ever, and the run still exited 0
    // and still wrote a report.
    expect(followRange({ completed: [{ from: 500, to: 1000 }] }, 500, 1200)).toEqual({ from: 1001, to: 1200 });
  });
});
