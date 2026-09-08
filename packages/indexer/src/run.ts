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
 * invocation, several transfers of the same asset to the followed account
 * collapse into one written observation (context.ts, mapper/volume.ts).
 * `sac_transfers_merged` counts the records that vanished into that sum, so
 * that the per-stream identity records_read.payments == observations_written.volume
 * + drops(volume reasons) + sac_transfers_merged still holds.
 */
export async function backfill(o: BackfillOptions): Promise<BackfillResult> {
  const keys = new KeySet();
  const result: BackfillResult = { written: 0, accountsDone: 0, accountsSkipped: 0, duplicateKeys: 0 };
  o.counters.inc("accounts_followed", o.accounts.length);

  for (const account of o.accounts) {
    const accountState = (o.state.accounts[account] ??= { completed: [] });
    if (!o.force && isCompleted(accountState, o.range)) {
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

    // Payments, grouped by operation so Soroban transfers are summed; memos once per transaction.
    let group: SourcePayment[] = [];
    const memoSeen = new Set<string>();
    const flush = (): void => {
      if (group.length === 0) return;
      const g = group;
      group = [];
      const results = mapVolume(g, account, ctx);
      for (const r of results) emit(r);
      if (g[0]!.kind === "sac_transfer") {
        o.counters.inc("sac_transfers_merged", g.length - results.length);
      }
    };
    for await (const p of o.reader.payments(account, o.range)) {
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

    for await (const e of o.reader.effects(account, o.range)) {
      o.counters.inc("records_read.effects");
      emit(mapProtocol(e, ctx));
    }

    markCompleted(accountState, o.range);
    await o.saveState();
    result.accountsDone++;
  }
  return result;
}
