/**
 * Retention, as the storage card rules it: not deletion but unreadability on
 * a clock.
 *
 * No observation is dropped at write time. A payload is sealed under a key
 * per `(namespace, calendar month)`, and that month key is wrapped under the
 * namespace's own key. A fixed grace after the month closes, the month key is
 * shredded: the payload becomes unreadable while the row skeleton, every
 * foreign key and every audit row stay where they are. A promotion re-seals
 * the rescued payload under the namespace key, which is how a captured trace
 * outlives its month.
 *
 * This module is the arithmetic and the declared numbers only. It touches no
 * database and reads no clock.
 *
 * Why the store gets its own policy value rather than sharing the tagging
 * package's: the store may not import tagging, and these four inputs are the
 * store's own. The engine composes the two and every audit row names both
 * versions.
 */
export interface RetentionPolicy {
  /** What a champion-challenger arrangement keys on; every result names it. */
  readonly version: string;
  /**
   * Days after a calendar month closes before its key is shredded. Ninety,
   * which is the whitepaper's own sentence rather than a number chosen here.
   * A design number, declared and uncalibrated, not a measurement.
   */
  readonly graceDays: number;
  /**
   * The bucket a payload's key is minted for. The whitepaper says "(counterparty
   * space, calendar month)"; the UTC half is ours, and it is a literal type so
   * that changing it is a policy version rather than an edit — a month boundary
   * in another zone is a different bucket, and moving it re-keys every row
   * written after the change.
   */
  readonly period: "calendar-month-utc";
  /**
   * The sliding window the producer cap counts over, on ingest time, because
   * a rate is over ingest and not over the events' own instants.
   */
  readonly producerWindowMs: number;
  /**
   * Observations one producer may deliver inside that window.
   *
   * Sized by a written rule rather than by a sense of what a rate limit
   * usually is: the largest delivery measured to date must pass in one window
   * with an order of magnitude to spare. The A1 indexer run delivered 646,890
   * observations for 100 accounts over 31 days, its busiest account 187,313.
   * "Ten thousand an hour" would have refused that backfill sixty times over
   * and turned our own indexer into a denial of service. Re-derived, not
   * retuned, when the shadow evaluation measures a larger fleet.
   */
  readonly producerMaxObservations: number;
}

export const RETENTION_V0: RetentionPolicy = Object.freeze({
  version: "retention-v0",
  graceDays: 90,
  period: "calendar-month-utc",
  producerWindowMs: 86_400_000,
  producerMaxObservations: 1_000_000,
});

const DAY_MS = 86_400_000;
const PERIOD = /^(\d{4})-(\d{2})-01$/;

function requirePositiveInteger(name: string, value: number, floor: number): void {
  if (!Number.isSafeInteger(value) || value < floor) {
    throw new RangeError(`${name} must be a safe integer no less than ${floor}, got ${value}`);
  }
}

/**
 * Refused field by field and by name: a policy rejected by a message that
 * does not say which field is a policy nobody can fix.
 */
export function assertRetentionPolicy(policy: RetentionPolicy): void {
  if (policy.version.trim().length === 0) {
    throw new RangeError("retention policy version must not be blank");
  }
  if (policy.period !== "calendar-month-utc") {
    throw new RangeError(`retention policy period must be calendar-month-utc, got ${policy.period}`);
  }
  // Zero grace is a policy, not a defect: it expires a month at its close.
  requirePositiveInteger("graceDays", policy.graceDays, 0);
  requirePositiveInteger("producerWindowMs", policy.producerWindowMs, 1);
  requirePositiveInteger("producerMaxObservations", policy.producerMaxObservations, 1);
}

/**
 * The period an instant belongs to, as the first day of its UTC calendar
 * month. Rendered as text rather than as a Date because the column is a
 * `date` and the driver parses one at LOCAL midnight: east of UTC a
 * round-tripped `2026-09-01` comes back as 2026-08-31T21:00Z and looks up the
 * wrong month's key, silently.
 */
export function periodOf(ingestedAt: Date): string {
  if (!(ingestedAt instanceof Date) || Number.isNaN(ingestedAt.getTime())) {
    throw new RangeError(`ingestedAt must be a valid Date, got ${String(ingestedAt)}`);
  }
  const y = ingestedAt.getUTCFullYear();
  const m = `${ingestedAt.getUTCMonth() + 1}`.padStart(2, "0");
  return `${y}-${m}-01`;
}

/** The first instant of the month after the period. December rolls the year. */
export function periodCloses(period: string): Date {
  const m = PERIOD.exec(period);
  if (m === null) throw new RangeError(`period must be YYYY-MM-01, got ${period}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new RangeError(`period month must be 01-12, got ${period}`);
  // Date.UTC normalises month 12 into January of the next year, so December
  // needs no special case; the test pins it anyway, because an off-by-one at
  // the year boundary files January under December's key.
  return new Date(Date.UTC(year, month, 1));
}

/**
 * When a period's key becomes shreddable. Takes no clock on purpose: a
 * backfill of last year expires a grace after last year's month closed, not a
 * grace after the day it was loaded.
 */
export function expiresAt(period: string, policy: RetentionPolicy): Date {
  return new Date(periodCloses(period).getTime() + policy.graceDays * DAY_MS);
}
