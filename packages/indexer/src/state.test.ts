import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { isCompleted, loadState, markCompleted, saveState } from "./state.js";
import { randomAccount } from "./testing/keys.js";

const dir = mkdtempSync(join(tmpdir(), "nnt-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("state", () => {
  it("starts empty for a missing file and round-trips through disk", async () => {
    const path = join(dir, "state.json");
    const s = await loadState(path, "stellar:pubnet");
    expect(s).toEqual({ network: "stellar:pubnet", accounts: {} });
    const g = randomAccount();
    s.accounts[g] = { completed: [{ from: 10, to: 20 }] };
    await saveState(path, s);
    expect(await loadState(path, "stellar:pubnet")).toEqual(s);
  });

  it("refuses a file written for another network", async () => {
    const path = join(dir, "other.json");
    await saveState(path, { network: "stellar:testnet", accounts: {} });
    await expect(loadState(path, "stellar:pubnet")).rejects.toThrow(/stellar:testnet/);
  });

  it("knows a range is complete only when a completed range covers it", () => {
    const a = { completed: [] as { from: number; to: number }[] };
    expect(isCompleted(a, { from: 10, to: 20 })).toBe(false);
    markCompleted(a, { from: 5, to: 25 });
    expect(isCompleted(a, { from: 10, to: 20 })).toBe(true);
    expect(isCompleted(a, { from: 10, to: 30 })).toBe(false);
  });
});
