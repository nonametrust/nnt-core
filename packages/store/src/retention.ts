/**
 * Retention, as the storage card rules it: not deletion but unreadability on
 * a clock.
 *
 * No observation is dropped at write time. A payload is to be sealed under a
 * key per `(namespace, calendar month)`, and that month key is wrapped under
 * the namespace's own key. A fixed grace after the month closes, the month
 * key is shredded: the payload becomes unreadable while the row skeleton,
 * every foreign key and every audit row stay where they are. A promotion
 * re-seals the rescued payload under the namespace key, which is how a
 * captured trace outlives its month.
 *
 * NOT YET TRUE AT THIS COMMIT, and the tense matters because a reader would
 * otherwise take it for shipped: `append` still seals under the NAMESPACE
 * key, nothing outside this module's own tests calls `periodKey`, and
 * `permanent_record` has no payload columns. So expiring a month currently
 * makes nothing unreadable. The month key, its table and its guard exist; the
 * wiring is Task 6, the sweep is Task 7 and the permanent copy is Task 9.
 * Review measured this by expiring a month and reading the payload back.
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
   * Sized against the one delivery that exists rather than against a sense of
   * what a rate limit usually is: the A1 indexer run delivered 646,890
   * observations for 100 accounts over 31 days. "Ten thousand an hour" would
   * have refused that backfill sixty times over and turned our own indexer
   * into a denial of service.
   *
   * The rule is a full order of magnitude over that measurement: any cap at or
   * above 6,468,900 satisfies it. Rounding up to the next power of ten is a
   * CONVENTION applied after the rule, not part of the reasoning, and saying
   * so is the point -- it was added in the same change that moved the
   * constant, so calling it "the rule" would be the same reverse-engineering
   * this paragraph exists to record. The test computes both halves rather
   * than comparing the constant to a band, because a band is a threshold
   * chosen after the constant. Note the convention is discontinuous: a
   * measurement of 1,000,001 would demand a hundred million.
   *
   * This reverses an earlier decision and the reversal is the point. The
   * number was first 1,000,000 beside a comment claiming an order of
   * magnitude, which 1.55x is not. The previous review kept the number and
   * rewrote the sentence to admit 1.55x -- a defensible choice, but it left
   * the plan's stated rule saying one thing and the code another, and it
   * moved the test to `margin > 1.5 && margin < 2`, a band 1,200,000 also
   * satisfies. Between a rule that was reasoned about and a number that
   * drifted, the number gives way.
   *
   * The direction matters too. R3 says this cap is not a defence against an
   * attacker -- the producer name is free text and an attacker rotates names
   * until signatures are enforced -- so its real job is catching our own
   * indexer in a loop. Too low refuses a legitimate delivery, which is the
   * denial of service on ourselves this whole paragraph exists to avoid, and
   * 1.55x would have refused a fleet only 60% larger than the one measured.
   * Too high only delays noticing a runaway, and ten million a day per
   * producer is still a bound. Re-derived, not retuned, when the shadow
   * evaluation measures a larger fleet.
   *
   * The busiest single account in that run held 187,313 of the 646,890. That
   * figure does not bind here, because the cap is per producer and the
   * producer is the indexer; it is the figure that would bind if the cap's
   * scope were vetoed to per-(producer, namespace), which the plan leaves
   * open, and it is recorded for that reason and no other.
   */
  readonly producerMaxObservations: number;
}

export const RETENTION_V0: RetentionPolicy = Object.freeze({
  version: "retention-v0",
  graceDays: 90,
  period: "calendar-month-utc",
  producerWindowMs: 86_400_000,
  producerMaxObservations: 10_000_000,
});

const DAY_MS = 86_400_000;
// Anchored, four digits and two digits exactly, and the day is literally 01.
// Unanchored it would read a year out of "12026-09-01"; loose on width it
// would accept "2026-9-01". The month range is checked below rather than in
// the pattern, so the refusal can name what is wrong with it.
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
 *
 * It does not assert the policy: a fractional `graceDays` produces a
 * fractional instant here rather than a named refusal. What makes that safe
 * is that every repository taking a policy asserts it in its constructor, so
 * an unvalidated policy cannot reach this function from inside the store.
 * That was a claim about a "composition point" that did not exist until
 * review pointed out nothing in src called the assertion at all.
 */
export function expiresAt(period: string, policy: RetentionPolicy): Date {
  return new Date(periodCloses(period).getTime() + policy.graceDays * DAY_MS);
}
