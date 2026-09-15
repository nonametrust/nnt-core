import type { CountersSnapshot } from "./counters.js";
import type { Network } from "./mapper/context.js";
import type { LedgerRange } from "./source/types.js";

export interface ReportMeta {
  network: Network;
  fromIso: string;
  toIso: string;
  range: LedgerRange;
  retentionFloor: number;
  runDate: string;
  accounts: number;
  wallClockMs: number;
  /**
   * `backfill` covers a calendar period, so the report states it in days;
   * `follow` covers whatever ledgers appeared since each account's own
   * frontier, at a point in time, so the report states the ledger span
   * instead of a period that would otherwise read as zero days.
   */
  mode: "backfill" | "follow";
  compare?: { previous: string; onlyInPrevious: number; onlyInCurrent: number };
}

const STRKEY = /G[A-Z2-7]{55}|M[A-Z2-7]{68}|g[a-z2-7]{55}|m[a-z2-7]{68}/g;

/**
 * The delivery table of the developer brief (section 7), filled from the
 * counters. Aggregates only: every string that reaches the output is scrubbed
 * of the account-id shape, so a drop sample that carried an id cannot leak
 * it into a file that someone then commits or pastes.
 */
export function renderReport(snapshot: CountersSnapshot, meta: ReportMeta): { json: string; markdown: string } {
  const scrubbed: CountersSnapshot = {
    counts: snapshot.counts,
    drops: snapshot.drops,
    dropSamples: Object.fromEntries(
      Object.entries(snapshot.dropSamples).map(([k, v]) => [k, v.map((s) => s.replace(STRKEY, "<account>"))]),
    ),
  };
  const c = scrubbed.counts;
  const read = c["records_read.payments"] ?? 0;
  const written = c["observations_written.volume"] ?? 0;
  const ratio = read === 0 ? 0 : written / read;
  const muxed = c["muxed_records"] ?? 0;
  const muxedFollowed = c["muxed_followed"] ?? 0;
  const totalObs = Object.entries(c).filter(([k]) => k.startsWith("observations_written.")).reduce((a, [, v]) => a + v, 0);
  const requests = c["requests"] ?? 0;
  const dropRows = Object.entries(scrubbed.drops).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  const compare = meta.compare
    ? `| Deduplication | ${meta.compare.onlyInPrevious} keys only in previous, ${meta.compare.onlyInCurrent} only in current (against ${meta.compare.previous}) |`
    : "| Deduplication | not compared in this run (pass --compare) |";
  const header =
    meta.mode === "follow"
      ? `Network ${meta.network}, follow run at ${meta.runDate}, ledgers ${meta.range.from}-${meta.range.to}.`
      : `Network ${meta.network}, ${meta.fromIso} to ${meta.toIso} (ledgers ${meta.range.from}-${meta.range.to}), run on ${meta.runDate}.`;
  const coverageRow =
    meta.mode === "follow"
      ? `| Coverage | ${meta.accounts} accounts, ledgers ${meta.range.from}-${meta.range.to} (follow) |`
      : `| Coverage | ${meta.accounts} accounts, ${Math.round((Date.parse(meta.toIso) - Date.parse(meta.fromIso)) / 86_400_000)} days |`;
  const markdown = `# Indexer run report

${header}
Horizon served ledgers from ${meta.retentionFloor} on that day.

| Metric | Measured |
|---|---|
${coverageRow}
${compare}
| Dropped records with reason | ${Object.values(scrubbed.drops).reduce((a, b) => a + b, 0)} (table below) |
| Coverage ratio | ${ratio.toFixed(2)} (${written} volume observations from ${read} payment-family records) |
| Muxed share | ${muxed} of ${read} records carried a muxed side (${(read === 0 ? 0 : muxed / read).toFixed(2)}), ${muxedFollowed} on the followed side, ${c["muxed_resolved"] ?? 0} resolved |
| Cost | ${requests} requests, ${totalObs === 0 ? "n/a" : (requests / totalObs).toFixed(2)} per observation, ${(meta.wallClockMs / 1000).toFixed(0)} s wall clock |

## Drops

| Reason | Count |
|---|---|
${dropRows || "| none | 0 |"}

## Limits

- Reads the SDF public Horizon, which serves about a year of history and is on its way to end-of-life (issue #3).
- Followed accounts chosen by the tracked selection rule, not by a pilot's real counterparties.
- Each Soroban transfer entry is its own observation (\`op:<id>#<index>\`); memos are recorded for text memos only.
`;
  const json = JSON.stringify({ meta, ...scrubbed }, null, 2);
  return { json, markdown };
}
