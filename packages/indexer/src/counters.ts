/**
 * Every record the indexer reads ends as an observation or as a drop with a
 * reason from this list. A drop with no reason is a bug: the run fails at
 * exit (`assertIdentity`, run.ts) if the identity
 * records_read.<stream> == written.<stream> + dropped.<stream> does not hold
 * for any of the three streams. The list is closed so that a new reason is a
 * decision that shows up in the report, not a string someone typed once.
 *
 * Some reasons are counted by the reader before the record is ever read into
 * a stream (`failed_transaction`, `sac_non_transfer`, `effect_ignored`,
 * `unsupported_type`, and its own `invalid_account_id`): they explain what
 * Horizon returned and the indexer refused, and sit outside that identity by
 * construction.
 */
export const DROP_REASONS = [
  "validation_failed",
  "memo_non_text",
  "memo_empty",
  "trustline_updated_skipped",
  "effect_ignored",
  "claimable_creator_unresolved",
  "sac_non_transfer",
  "invalid_account_id",
  "muxed_base_address",
  "unsupported_type",
  "not_followed",
  "duplicate_key_in_run",
  "failed_transaction",
  "sac_no_entries",
  "amount_missing",
] as const;

/**
 * Declared but emitted by no code path in v0, so a report must say "reserved"
 * and never "measured zero": `claimable_creator_unresolved` waits for a
 * channel that needs the creator rather than the claimant (plan, Task 13
 * note), and `muxed_base_address` was superseded by resolving the muxed
 * address to its base and carrying the id in `namespace.muxedId`. A reason
 * that leaves this list has a code path and a test; one that joins it has
 * neither.
 */
export const RESERVED_DROP_REASONS = ["claimable_creator_unresolved", "muxed_base_address"] as const;
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
