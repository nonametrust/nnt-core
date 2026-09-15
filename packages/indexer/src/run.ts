import { validateObservation } from "@nonametrust/schema";
import type { Clock } from "./clock.js";
import type { Counters } from "./counters.js";
import { KeySet } from "./dedupe.js";
import type { MapContext, MapResult } from "./mapper/context.js";
import { mapContent } from "./mapper/content.js";
import { mapProtocol } from "./mapper/protocol.js";
import { mapVolume } from "./mapper/volume.js";
import type { Sink } from "./sink.js";
import type { SourceReader } from "./source/reader.js";
import type { AccountId, LedgerRange, SourcePayment } from "./source/types.js";
import { isCompleted, markCompleted, type IndexerState } from "./state.js";

export interface BackfillOptions {
  reader: SourceReader;
  accounts: AccountId[];
  range: LedgerRange;
  ctx: Omit<MapContext, "fetchedAt">;
  sink: Sink;
  state: IndexerState;
  saveState: () => Promise<void>;
  counters: Counters;
  clock: Clock;
  force?: boolean;
  /**
   * `follow` pools accounts with different completed frontiers; the same
   * range for every account would silently drop or re-read ledgers for
   * whichever accounts are not at the pooled frontier. When given, this
   * overrides `range` per account for the reader calls, `isCompleted` and
   * `markCompleted`; `range` itself stays the nominal range used only for
   * naming and reporting.
   */
  rangeFor?: (account: AccountId) => LedgerRange;
}

export interface BackfillResult {
  written: number;
  accountsDone: number;
  accountsSkipped: number;
  duplicateKeys: number;
}

/**
 * read -> map -> validate -> dedupe -> sink, per followed account. Every
 * record ends as a written observation or a counted drop with a reason;
 * nothing is skipped silently. The state is saved after each account, so a
 * kill loses at most one account's partial work and never leaves a gap.
 *
 * `mapVolume` groups payment-family records by operation id: for a Soroban
 * invocation, each transfer maps to its own observation, one per record
 * (mapper/volume.ts). The per-stream identity is
 * records_read.payments == observations_written.volume + drops(volume reasons).
 * `self_payments` is counted separately from the records themselves (a
 * self-payment maps to exactly one "in" observation and no drop, so it
 * already satisfies the identity on its own); it is a diagnostic count, not
 * a term of the identity.
 */
export async function backfill(o: BackfillOptions): Promise<BackfillResult> {
  const keys = new KeySet();
  const result: BackfillResult = { written: 0, accountsDone: 0, accountsSkipped: 0, duplicateKeys: 0 };
  o.counters.inc("accounts_followed", o.accounts.length);

  for (const account of o.accounts) {
    const range = o.rangeFor ? o.rangeFor(account) : o.range;
    const accountState = (o.state.accounts[account] ??= { completed: [] });
    if (!o.force && isCompleted(accountState, range)) {
      result.accountsSkipped++;
      continue;
    }
    const ctx: MapContext = { ...o.ctx, fetchedAt: o.clock.now().toISOString() };
    const emit = (r: MapResult): void => {
      if (!r.ok) {
        o.counters.drop(r.reason, r.ref);
        return;
      }
      const v = validateObservation(r.observation);
      if (!v.ok) {
        o.counters.drop("validation_failed", `${r.observation.source.ref} ${v.errors[0] ?? ""}`);
        return;
      }
      if (!keys.add(v.value.idempotencyKey)) {
        o.counters.drop("duplicate_key_in_run", r.observation.source.ref);
        result.duplicateKeys++;
        return;
      }
      o.sink.write(v.value);
      o.counters.inc(`observations_written.${v.value.channel}`);
      if (v.value.namespace.muxedId !== undefined) o.counters.inc("muxed_resolved");
      result.written++;
    };

    // Payments, grouped by operation; each Soroban transfer entry maps to its own observation; memos once per transaction.
    let group: SourcePayment[] = [];
    const memoSeen = new Set<string>();
    const flush = (): void => {
      if (group.length === 0) return;
      const g = group;
      group = [];
      const results = mapVolume(g, account, ctx);
      for (const r of results) emit(r);
      if (g.length === 1 && g[0]!.from === g[0]!.to) {
        o.counters.inc("self_payments");
      }
    };
    for await (const p of o.reader.payments(account, range)) {
      o.counters.inc("records_read.payments");
      if (p.toMuxedId !== undefined || p.fromMuxedId !== undefined) o.counters.inc("muxed_records");
      if (group.length > 0 && group[0]!.opId !== p.opId) flush();
      group.push(p);
      if (p.memo && !memoSeen.has(p.txHash)) {
        memoSeen.add(p.txHash);
        o.counters.inc("records_read.memos");
        emit(mapContent(p.memo, account, p.createdAt, ctx));
      }
    }
    flush();

    for await (const e of o.reader.effects(account, range)) {
      o.counters.inc("records_read.effects");
      emit(mapProtocol(e, ctx));
    }

    markCompleted(accountState, range);
    await o.saveState();
    result.accountsDone++;
  }
  return result;
}
