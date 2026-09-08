import { describe, it, expect } from "vitest";
import { main } from "./cli.js";

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
});
