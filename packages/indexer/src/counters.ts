/**
 * Every record the indexer reads ends as an observation or as a drop with a
 * reason from this list. A drop with no reason is a bug: the run fails at
 * exit if the identity records_read == written + dropped does not hold per
 * channel (run.ts). The list is closed so that a new reason is a decision
 * that shows up in the report, not a string someone typed once.
 */
export const DROP_REASONS = [
  "validation_failed",
  "memo_non_text",
  "memo_empty",
  "trustline_updated_skipped",
  "effect_ignored",
  "claimable_creator_unresolved",
  "sac_multi_asset",
  "sac_bidirectional",
  "sac_non_transfer",
  "invalid_account_id",
  "muxed_base_address",
  "self_payment",
  "unsupported_type",
  "not_followed",
  "duplicate_key_in_run",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface CountersSnapshot {
  counts: Record<string, number>;
  drops: Record<string, number>;
  /** Up to ten refs per reason, in order of arrival, for a reader chasing a drop. */
  dropSamples: Record<string, string[]>;
}

const SAMPLE_LIMIT = 10;

export class Counters {
  private readonly counts = new Map<string, number>();
  private readonly dropCounts = new Map<DropReason, number>();
  private readonly samples = new Map<DropReason, string[]>();

  inc(name: string, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  drop(reason: DropReason, ref: string): void {
    this.dropCounts.set(reason, (this.dropCounts.get(reason) ?? 0) + 1);
    const s = this.samples.get(reason) ?? [];
    if (s.length < SAMPLE_LIMIT) s.push(ref);
    this.samples.set(reason, s);
  }

  drops(): Record<string, number> {
    return sorted(this.dropCounts);
  }

  totalDrops(): number {
    let n = 0;
    for (const v of this.dropCounts.values()) n += v;
    return n;
  }

  snapshot(): CountersSnapshot {
    return {
      counts: sorted(this.counts),
      drops: sorted(this.dropCounts),
      dropSamples: sorted(this.samples),
    };
  }
}

function sorted<V>(m: Map<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) as V;
  return out;
}
