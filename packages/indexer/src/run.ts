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
  /**
   * The keys already present in the output file, when the sink appends to an
   * interrupted run's file. State is saved per completed account, so the
   * account a kill interrupted is re-read from the range start; every
   * observation of it that the previous run already wrote would otherwise be
   * written a second time. An observation whose key is in this set is not
   * written and is counted `resumed_line_skipped`: it is not a drop, the
   * line exists in the file. `duplicate_key_in_run` keeps its own meaning,
   * a key this process produced twice.
   */
  resumeKeys?: ReadonlySet<string>;
}

/**
 * The three streams a run reads. Every record of a stream ends as a written
 * observation or as a counted drop, so `records_read.<stream>` must equal
 * `written.<stream> + dropped.<stream>` when the run ends.
 */
export const STREAMS = ["payments", "memos", "effects"] as const;
export type Stream = (typeof STREAMS)[number];

/**
 * A stream whose records do not add up. This is not a warning: a record that
 * produced neither an observation nor a drop is a record the pipeline lost
 * without saying so, and every number the report prints about coverage is
 * then unfounded. The run aborts and the CLI exits 3.
 */
export class IdentityError extends Error {
  constructor(
    readonly stream: Stream,
    readonly read: number,
    readonly written: number,
    readonly dropped: number,
  ) {
    super(`identity broken on ${stream}: records_read ${read} != written ${written} + dropped ${dropped}`);
    this.name = "IdentityError";
  }
}

export interface BackfillResult {
  written: number;
  accountsDone: number;
  accountsSkipped: number;
  duplicateKeys: number;
  /** Observations this run produced that the file already held (`resumeKeys`). */
  resumedSkipped: number;
}

/**
 * read -> map -> validate -> dedupe -> sink, per followed account. Every
 * record ends as a written observation or a counted drop with a reason;
 * nothing is skipped silently. The state is saved after each account, so a
 * kill loses at most one account's partial work and never leaves a gap.
 *
 * `mapVolume` groups payment-family records by operation id: for a Soroban
 * invocation, each transfer maps to its own observation, one per record
 * (mapper/volume.ts). The per-stream identity,
 * records_read.<stream> == written.<stream> + dropped.<stream>, is asserted
 * at exit (`assertIdentity`); a stream that does not balance aborts the run
 * with an `IdentityError` instead of reporting coverage nobody can trust.
 * The reader drops records of its own (`sac_non_transfer`, `effect_ignored`,
 * `failed_transaction`, an unsupported type) before they are ever read here,
 * so those sit outside this identity by construction.
 * `self_payments` is counted per record, separately from the outcome (a
 * self-payment maps to exactly one "in" observation and no drop, so it
 * already satisfies the identity on its own); it is a diagnostic count, not
 * a term of the identity.
 */
export async function backfill(o: BackfillOptions): Promise<BackfillResult> {
  const keys = new KeySet();
  const result: BackfillResult = { written: 0, accountsDone: 0, accountsSkipped: 0, duplicateKeys: 0, resumedSkipped: 0 };
  o.counters.inc("accounts_followed", o.accounts.length);
  // Seeded at zero so that the three identities are in the counters file of
  // every run, including a run where a stream saw nothing: an absent number
  // and a zero read the same to a person and differently to a reader.
  for (const stream of STREAMS) {
    o.counters.inc(`records_read.${stream}`, 0);
    o.counters.inc(`written.${stream}`, 0);
    o.counters.inc(`dropped.${stream}`, 0);
  }

  for (const account of o.accounts) {
    const range = o.rangeFor ? o.rangeFor(account) : o.range;
    const accountState = (o.state.accounts[account] ??= { completed: [] });
    // `follow` hands back an empty range for an account already at the
    // frontier. There is nothing to read and nothing to record: reading it
    // would page a descending range, and recording it would write that pair
    // into the state. `--force` does not change the arithmetic.
    if (range.to < range.from) {
      result.accountsSkipped++;
      continue;
    }
    if (!o.force && isCompleted(accountState, range)) {
      result.accountsSkipped++;
      continue;
    }
    const ctx: MapContext = { ...o.ctx, fetchedAt: o.clock.now().toISOString() };
    // Each outcome tallies its own stream at the site where it is decided,
    // so the identity cannot be satisfied by a number computed afterwards
    // from the same facts it is supposed to check.
    const emit = (r: MapResult, stream: Stream): void => {
      if (!r.ok) {
        o.counters.drop(r.reason, r.ref);
        o.counters.inc(`dropped.${stream}`);
        return;
      }
      const v = validateObservation(r.observation);
      if (!v.ok) {
        o.counters.drop("validation_failed", `${r.observation.source.ref} ${v.errors[0] ?? ""}`);
        o.counters.inc(`dropped.${stream}`);
        return;
      }
      if (!keys.add(v.value.idempotencyKey)) {
        o.counters.drop("duplicate_key_in_run", r.observation.source.ref);
        o.counters.inc(`dropped.${stream}`);
        result.duplicateKeys++;
        return;
      }
      if (o.resumeKeys?.has(v.value.idempotencyKey)) {
        // Written, for the identity: the observation exists, in the file a
        // previous run wrote. Only the second copy is what does not happen.
        o.counters.inc("resumed_line_skipped");
        o.counters.inc(`written.${stream}`);
        result.resumedSkipped++;
        return;
      }
      o.sink.write(v.value);
      o.counters.inc(`observations_written.${v.value.channel}`);
      o.counters.inc(`written.${stream}`);
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
      for (const r of results) emit(r, "payments");
    };
    for await (const p of o.reader.payments(account, range)) {
      o.counters.inc("records_read.payments");
      // Per record, not per group: a SAC self-transfer sits inside an
      // invocation that also moved value between other parties, and a group
      // rule would miss it.
      if (p.from === account && p.to === account) o.counters.inc("self_payments");
      if (p.toMuxedId !== undefined || p.fromMuxedId !== undefined) o.counters.inc("muxed_records");
      // `muxed_records` is the share of records that carried a muxed side at
      // all; only a muxed side *on the followed account* can become a
      // `muxedId` on an observation, so that is the number
      // `muxed_resolved` is measured against (spec 13.5).
      if ((p.toMuxedId !== undefined && p.to === account) || (p.fromMuxedId !== undefined && p.from === account)) {
        o.counters.inc("muxed_followed");
      }
      if (group.length > 0 && group[0]!.opId !== p.opId) flush();
      group.push(p);
      if (p.memo && !memoSeen.has(p.txHash)) {
        memoSeen.add(p.txHash);
        o.counters.inc("records_read.memos");
        emit(mapContent(p.memo, account, p.createdAt, ctx), "memos");
      }
    }
    flush();

    for await (const e of o.reader.effects(account, range)) {
      o.counters.inc("records_read.effects");
      emit(mapProtocol(e, ctx), "effects");
    }

    markCompleted(accountState, range);
    await o.saveState();
    result.accountsDone++;
  }
  assertIdentity(o.counters);
  return result;
}

/**
 * The claim of section 13.3, as an assertion rather than as prose: for each
 * stream, every record read became exactly one outcome. It runs at the end
 * of the run, on the counters the report is rendered from, so a report can
 * never be produced from numbers that do not add up.
 */
export function assertIdentity(counters: Counters): void {
  for (const stream of STREAMS) {
    const read = counters.get(`records_read.${stream}`);
    const written = counters.get(`written.${stream}`);
    const dropped = counters.get(`dropped.${stream}`);
    if (read !== written + dropped) throw new IdentityError(stream, read, written, dropped);
  }
}
