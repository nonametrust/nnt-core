import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Network } from "./mapper/context.js";
import type { AccountId, LedgerRange } from "./source/types.js";

/**
 * The indexer ends in shadow mode, so it resumes rather than restarts. The
 * state holds, per followed account, the ranges completed; it is written
 * after each completed account (run.ts), never mid-account. A kill therefore
 * loses no completed account and leaves no gap, at the price of re-reading
 * the interrupted account from the range start on resume: its already
 * written lines are recognised by key, not by cursor (`resumeKeys` in
 * run.ts), which is why no per-stream cursor is stored. The file names
 * accounts and is therefore gitignored.
 */
export interface AccountState {
  completed: LedgerRange[];
}

export interface IndexerState {
  network: Network;
  retentionFloor?: number;
  accounts: Record<AccountId, AccountState>;
}

export async function loadState(path: string, network: Network): Promise<IndexerState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { network, accounts: {} };
    throw e;
  }
  const parsed = JSON.parse(raw) as IndexerState;
  if (parsed.network !== network) {
    throw new Error(`${path} was written for ${parsed.network}, not ${network}`);
  }
  return parsed;
}

export async function saveState(path: string, state: IndexerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function isCompleted(state: AccountState, range: LedgerRange): boolean {
  return state.completed.some((c) => c.from <= range.from && c.to >= range.to);
}

/**
 * An empty range (`to < from`, which is how `follow` says "this account is
 * already at the frontier") is not a fact about history and is never
 * recorded: stored, it would put a descending pair in `completed`, where
 * every later reader has to special-case it.
 */
export function markCompleted(state: AccountState, range: LedgerRange): void {
  if (range.to < range.from) return;
  if (!isCompleted(state, range)) state.completed.push({ from: range.from, to: range.to });
}
