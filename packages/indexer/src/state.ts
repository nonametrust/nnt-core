import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Network } from "./mapper/context.js";
import type { AccountId, LedgerRange } from "./source/types.js";

/**
 * The indexer ends in shadow mode, so it resumes rather than restarts. The
 * state holds, per followed account, the last cursor consumed on each
 * stream and the ranges completed. It is written after every page (run.ts),
 * so a kill loses at most one page and never leaves a gap. It names accounts
 * and is therefore gitignored.
 */
export interface AccountState {
  paymentsCursor?: string;
  effectsCursor?: string;
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

export function markCompleted(state: AccountState, range: LedgerRange): void {
  if (!isCompleted(state, range)) state.completed.push({ from: range.from, to: range.to });
}
