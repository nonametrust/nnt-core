import {
  BaselineStale,
  Cancelled,
  ConstraintViolation,
  Deadlocked,
  StoreError,
  TagRefreshStale,
} from "@nonametrust/store";
import { RISK_TIERS, type RiskTier } from "./audit-body.js";
import type { BriefPolicy } from "./policy.js";

/**
 * Which of R7's three conditions made the store unavailable.
 *
 * NAMED rather than boolean, because the three are diagnosed differently and the
 * condition is what goes to structured stderr — the audit chain lives in the same
 * Postgres that is unavailable, so the chain cannot be the record of its own outage.
 */
export type UnavailableCondition =
  | "connection"
  | "cancelled"
  | "engine_timeout"
  /**
   * R7's fourth: "only an exhausted retry becomes unavailable". G15's row is titled
   * "the four unavailable conditions" and there were three -- so a `RetriesExhausted`
   * fell through to `connection`, and an exhausted DEADLOCK retry, against a server
   * that answered every single time, was written down as a connection outage.
   */
  | "retries_exhausted";

/**
 * A timeout the ENGINE set, R7's third condition.
 *
 * Its own class because it is the one condition the store cannot report: a server
 * that never answers produces nothing to classify, so the only evidence it happened
 * is that the engine stopped waiting.
 */
export class EngineTimeout extends Error {}

/** A bounded retry that ran out, R28. Carries a CODE and a subject, never a message. */
export class RetriesExhausted extends Error {
  readonly code = "RETRIES_EXHAUSTED" as const;
  constructor(
    readonly label: string,
    readonly attempts: number,
    readonly subject: string | null,
    options?: ErrorOptions,
  ) {
    // THE FAILURE'S OWN MESSAGE IS NOT REPEATED, R21. `surpriseOf`'s `RangeError`
    // carries the observed VALUE, and anything recorded here can reach an audit body,
    // which outlives both the month key and the namespace key. The code and the
    // subject go in; the message stays on `cause` for a human reading stderr.
    super(
      `${label} gave up after ${attempts} attempts${subject === null ? "" : ` on ${subject}`}`,
      options,
    );
  }
}

/**
 * The SQLSTATEs that mean the server cancelled the work: a lock timeout and a
 * statement timeout.
 *
 * The store maps both to `Cancelled` — on the paths that map at all. **The brief's
 * two reads do not.** Measured: `TagRepository.listLive` and
 * `ObservationRepository.readClear` contain no `mapPgError`, so a lock timeout on the
 * read path arrives as a raw driver error carrying `code: "55P03"` and never as
 * `Cancelled`. The writes (`record`, `AuditChain.append`) do map. So both forms are
 * matched, or this rule would hold on the write path only.
 */
export const CANCELLED_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "57014"]);

/**
 * The SQLSTATEs R28 retries on sight: both deadlock spellings.
 *
 * READ BY `isRetryable`, which is a correction. An earlier version of this set also
 * carried `23505` and was read by nothing at all -- a review measured that emptying it
 * turned exactly one test red, the one that asserted its own contents. `23505` is not
 * here because it is retryable only on ONE constraint, which a SQLSTATE cannot say.
 */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"]);

/**
 * The SQLSTATEs whose whole meaning is that the server is unavailable.
 *
 * **MEASURED, and this set is a defect being closed rather than a precaution.** A
 * review terminated a blocked backend with `pg_terminate_backend` and got `57P01`,
 * which classified as a REFUSAL -- because the rule was "an unmapped SQLSTATE means
 * the server answered, which is the opposite of an outage". That is false for exactly
 * these classes: **the server answered to say it is unavailable.**
 *
 * - **08** connection exception: the connection failed or was violated.
 * - **53** insufficient resources: out of connections, disk or memory.
 * - **57P0x** operator intervention: admin shutdown, crash shutdown, `cannot_connect_now`
 *   (the canonical "database system is starting up"), idle-session timeout.
 * - **XX** internal error.
 *
 * NOT the whole of class 57: `57014 query_canceled` is in it and is a CANCELLED
 * statement, which keeps its own condition. A class-wide rule would have lost that.
 */
const OUTAGE_SQLSTATE_CLASSES: readonly string[] = ["08", "53", "XX"];
const OUTAGE_SQLSTATES: ReadonlySet<string> = new Set([
  "57P01",
  "57P02",
  "57P03",
  "57P04",
  "57P05",
]);

/** The one unique key R28 names for a retry. */
const RETRYABLE_CONSTRAINT = "tag_one_live_per_pair";

/**
 * A SQLSTATE is five characters **containing at least one digit**.
 *
 * The digit is the whole point and it is a correction. An earlier version was
 * `/^[0-9A-Z]{5}$/`, with a comment claiming "a libuv error code is not five
 * characters" -- and `EPIPE`, `EBADF`, `EBUSY`, `EPERM`, `EINTR`, `ENXIO`, `EROFS`,
 * `EXDEV` and `EFBIG` all are. So `EPIPE`, which is what a write to a socket the
 * server already closed produces, was read as a SQLSTATE and classified as a refusal.
 *
 * Every real Postgres SQLSTATE carries a digit: the class may be letters (`XX`, `HV`)
 * but the three-character subclass always has one, `XX000` and `HV00L` included. No
 * libuv code does.
 */
const SQLSTATE = /^(?=.*[0-9])[0-9A-Z]{5}$/;

/**
 * The SQLSTATE a RAW driver error carries.
 *
 * **`code` ONLY, and the `sqlstate` branch that used to be here was dead.** A review
 * measured it: the only object in this system exposing `sqlstate` is the store's
 * `ConstraintViolation`, which is a `StoreError` and is therefore taken by
 * `instanceof StoreError` in `classifyStoreFailure` and by `instanceof
 * ConstraintViolation` in `isRetryable` **before this function is ever reached**.
 * Deleting the branch changed no answer; deleting the `code` branch killed seven rows.
 * A branch that cannot execute, justified by a docstring, is the shape this milestone
 * keeps finding, so it is gone rather than kept for symmetry.
 *
 * `code` is also where libuv puts `ECONNREFUSED`, so the SHAPE is checked rather than
 * the field's presence — see `SQLSTATE`, whose digit rule is what separates the two.
 */
function sqlstateOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const withCode = e as { code?: unknown };
  return typeof withCode.code === "string" && SQLSTATE.test(withCode.code)
    ? withCode.code
    : null;
}

/**
 * Which of R7's conditions this failure is, or `null` if the store is not
 * unavailable.
 *
 * **MATCHED ON WHAT ARRIVED FROM A STORE CALL, not on the absence of a field**, which
 * is R7 in as many words: a tagging `RangeError` has no SQLSTATE either, and measured
 * on this cluster a refused connection carries `ECONNREFUSED` while a connect timeout
 * carries `ETIMEDOUT` — so no field is the discriminator. That is made structural
 * rather than argued: the only thing that calls this wraps a store call, so a value
 * error from elsewhere never reaches it. The `RangeError` row in the tests is a
 * belt-and-braces check on the classification itself.
 *
 * **A DEADLOCK IS NOT UNAVAILABLE**, R7, and the first version of the plan had it
 * wrong. 40P01 is mapped to `Deadlocked` precisely so a caller can tell it from a
 * constraint and RETRY; running the tiered failure policy on it — low proceeds, high
 * holds — throws away the one response that is correct. Only an exhausted retry
 * becomes unavailable, and that arrives as `RetriesExhausted`.
 *
 * **A SERVER THAT ANSWERED IS NOT AN OUTAGE.** An unmapped SQLSTATE means the
 * database replied, so it is a refusal rather than a degradation; calling it
 * unavailable would run the tiered policy against a database that is up.
 */
export function classifyStoreFailure(e: unknown): UnavailableCondition | null {
  // NON-ERRORS ANSWER FIRST, so nothing below has to guard against a thrown string or
  // a null. A thrown primitive is a programming fault rather than a degraded database,
  // and reporting it as one sends the tiered policy after a healthy server because a
  // caller threw the wrong thing.
  if (!(e instanceof Error)) return null;
  if (e instanceof EngineTimeout) return "engine_timeout";
  if (e instanceof RetriesExhausted) return "retries_exhausted";
  if (e instanceof Cancelled) return "cancelled";
  // EVERY OTHER CLASS THE STORE NAMED IS A REFUSAL, `Deadlocked` included. The store
  // built it, so the server answered and said what was wrong; that is the opposite of
  // an outage. `Cancelled` is the one exception and is taken above.
  //
  // `StoreError` is the discriminator because it is the common base and it is
  // exported. An earlier version asked whether `e.name !== "Error"` instead, which is
  // false for every one of these classes -- a subclass with no explicit `name`
  // inherits `"Error"` -- so a shredded namespace classified as a CONNECTION OUTAGE.
  // Three rows caught it.
  if (e instanceof StoreError) return null;

  const sqlstate = sqlstateOf(e);
  if (sqlstate !== null) {
    if (CANCELLED_SQLSTATES.has(sqlstate)) return "cancelled";
    // A SQLSTATE whose meaning IS unavailability. Checked before the refusal default,
    // because "the server answered" is not the same as "the server is working".
    if (OUTAGE_SQLSTATES.has(sqlstate)) return "connection";
    if (OUTAGE_SQLSTATE_CLASSES.includes(sqlstate.slice(0, 2))) return "connection";
    return null;
  }
  // No SQLSTATE at all, and not a class the store named. Reached only for an error
  // that came out of a store call, so the server never answered: a refused
  // connection, a connect timeout, a socket that died mid-query. A `RangeError` from
  // our own validation is not one of those and never reaches here on the real path,
  // because input is refused by name before any store call is made.
  // A value error our own validation raised, or a programming fault thrown INSIDE a
  // repository -- both come out of a store call and neither is an outage. Narrowing
  // this to `RangeError` alone survived a review's mutation run, which is why the
  // `TypeError` half has a row of its own.
  if (e instanceof RangeError || e instanceof TypeError) return null;
  return "connection";
}

/**
 * Whether R28 retries this failure.
 *
 * The set the ruling names: `BaselineStale`, `TagRefreshStale`, the 23505 on
 * `tag_one_live_per_pair`, and `Deadlocked` — the last in both the mapped and the raw
 * form, because the brief's reads do not map and a deadlock there would otherwise be
 * classified by the branch above rather than retried.
 *
 * **Not every 23505.** A 23505 on the trigger's primary key is the wrapper's "already
 * landed" signal, and retrying it would rewrite nothing forever.
 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof Deadlocked || e instanceof BaselineStale || e instanceof TagRefreshStale) {
    return true;
  }
  if (e instanceof ConstraintViolation) {
    return e.sqlstate === "23505" && e.constraint === RETRYABLE_CONSTRAINT;
  }
  const sqlstate = sqlstateOf(e);
  return sqlstate !== null && RETRYABLE_SQLSTATES.has(sqlstate);
}

/** What the tiered policy decided, with the code it is recorded under. */
export interface UnavailabilityDecision {
  readonly decision: "proceed" | "refuse";
  readonly code: "STORE_UNAVAILABLE_PROCEEDED" | "STORE_UNAVAILABLE_REFUSED";
}

/**
 * R6's three behaviours when the store is unavailable, with R27's ceiling.
 *
 * Low proceeds and is logged; medium proceeds strictly UNDER `mediumCeiling` and is
 * refused at or above it; high is refused at any amount.
 *
 * **THE CEILING COMES FROM THE POLICY AND NEVER FROM THE CALLER**, which is design
 * §6:281: degrading availability is not a way to bypass the layer, and a caller
 * supplying its own ceiling is a caller raising it. The only way to move this bound is
 * to ship a policy, which the audit body's composite version then names.
 *
 * **THE RESULT IS A CODE AND NOT A GRADE.** Design §6 says error states are codes and
 * not prose, and a `hold` returned here would be indistinguishable from a hold the
 * threshold produced — which is the difference between "we decided" and "we could not
 * decide".
 */
export function tierUnderUnavailability(
  riskTier: RiskTier,
  amount: number,
  policy: BriefPolicy,
): UnavailabilityDecision {
  if (!RISK_TIERS.includes(riskTier)) {
    throw new RangeError(
      `unavailability riskTier must be one of ${RISK_TIERS.join(", ")}, got ${JSON.stringify(riskTier)}`,
    );
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(
      `unavailability amount must be a non-negative finite number, got ${amount}`,
    );
  }
  const proceed: UnavailabilityDecision = {
    decision: "proceed",
    code: "STORE_UNAVAILABLE_PROCEEDED",
  };
  const refuse: UnavailabilityDecision = {
    decision: "refuse",
    code: "STORE_UNAVAILABLE_REFUSED",
  };
  if (riskTier === "low") return proceed;
  if (riskTier === "high") return refuse;
  // Strictly under. At the ceiling the amount is not under it, and an off-by-one here
  // is the layer bypassed by one unit.
  return amount < policy.mediumCeiling ? proceed : refuse;
}

/** What a report of an outage carries. Ids, codes and instants, as R25 admits. */
export interface UnavailabilityReport {
  readonly event: "engine.store.unavailable";
  readonly at: string;
  readonly condition: UnavailableCondition;
  readonly decision: "proceed" | "refuse";
  readonly code: UnavailabilityDecision["code"];
  readonly riskTier: RiskTier;
  readonly subject: string | null;
}

/**
 * Writes the outage to structured stderr, R7.
 *
 * **STDERR AND NOT THE AUDIT CHAIN**, which is the whole reason this function exists
 * rather than an audit append: the chain lives in the same Postgres that is
 * unavailable, so it cannot be the record of its own outage. R7 also asks for a
 * reconciliation audit row when the store returns; that needs a caller with a live
 * store and is recorded as owed.
 *
 * **CODES AND IDS ONLY**, R21. The failure's own message is not written: it can carry
 * an observed VALUE -- `surpriseOf`'s `RangeError` does -- and a line on stderr is as
 * durable as whatever collects it.
 *
 * The plan's Task 7 acceptance says "low proceeds **and logs**" and G16's third plant
 * is "low's log line dropped". Neither was runnable until this existed.
 */
export function reportUnavailable(
  condition: UnavailableCondition,
  riskTier: RiskTier,
  decision: UnavailabilityDecision,
  at: Date,
  subject: string | null = null,
  write: (line: string) => void = (line) => process.stderr.write(line),
): UnavailabilityReport {
  const report: UnavailabilityReport = {
    event: "engine.store.unavailable",
    at: at.toISOString(),
    condition,
    decision: decision.decision,
    code: decision.code,
    riskTier,
    subject,
  };
  write(`${JSON.stringify(report)}\n`);
  return report;
}

/**
 * R7's third condition: a bound the ENGINE sets on a store call.
 *
 * A server that has stopped answering produces no error to classify, so without this
 * a brief waits for as long as the driver will. The bound is the engine's because it
 * is the only party that knows how long the answer is still worth having.
 *
 * The call's OWN failure passes through unchanged — a timeout reported for a store
 * that refused in 3ms would send the tiered policy after a database that is up.
 *
 * **WHAT THIS DOES NOT DO, and it is a real hazard rather than a caveat.** Racing
 * abandons the call; it does not cancel the query or release the connection. A review
 * measured the consequence on the real cluster: ten timed-out `listLive` calls against
 * a locked table left **ten backends still waiting on the lock**, and the eleventh
 * call — `select 1`, which the server answers instantly — timed out too, because the
 * pool's ten clients were all held by abandoned queries. So this condition, once it
 * fires enough times, MANUFACTURES the outage it is meant to report, and the tiered
 * policy then runs against a database that is up.
 *
 * It is gated by a test that measures the drain rather than left as prose. The fix is
 * not more racing: a bound the engine sets must be paired with one the SERVER sets, so
 * that abandoning a call also ends it. That is `statement_timeout` / `lock_timeout` on
 * the composition's connection, and it is recorded as owed rather than built here
 * because the engine does not own the connection string — `compose` is handed a
 * `Db` that is already open.
 */
export async function withStoreTimeout<T>(
  call: () => Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError(`timeout budget must be a positive finite number, got ${budgetMs}`);
  }
  // NODE'S TIMER TAKES A 32-BIT DELAY. Above 2^31-1 it warns and fires after ONE
  // MILLISECOND, so the largest budgets behave like the smallest -- measured: a budget
  // of 2_147_483_648 raised its timeout after 2ms. `Number.isFinite` admits it, so the
  // bound has to be named here.
  if (budgetMs > MAX_TIMER_MS) {
    throw new RangeError(
      `timeout budget must be at most ${MAX_TIMER_MS}ms, got ${budgetMs}: above that a ` +
        `timer fires after one millisecond instead of waiting`,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new EngineTimeout(`${label} did not answer within ${budgetMs}ms`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    // Cleared on every path, so a fast call does not hold the process open for the
    // length of its own budget.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The largest delay `setTimeout` honours. Above it the timer fires immediately.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** What a bounded retry needs to know. */
export interface RetryBound {
  /** `BriefPolicy.maxRetries`. */
  readonly maxRetries: number;
  /** What is being retried, for the exhausted record. */
  readonly label: string;
  /** The observation id or other subject R28 records, if there is one. */
  readonly subject?: string;
}

/**
 * R28: every retry is bounded, and an exhausted retry is RECORDED rather than thrown
 * away.
 *
 * `maxRetries` is a count of RETRIES, so the call is made at most `1 + maxRetries`
 * times. An unbounded loop is a denial of service on ourselves, which is the argument
 * the producer cap already makes in the store.
 *
 * Only R28's set is retried. An outage falls straight through to the tiered policy,
 * and an ordinary refusal is raised unchanged — retrying a shredded namespace would
 * be asking the same question four more times.
 */
export async function retrying<T>(call: () => Promise<T>, bound: RetryBound): Promise<T> {
  if (!Number.isSafeInteger(bound.maxRetries) || bound.maxRetries < 1) {
    throw new RangeError(
      `maxRetries must be a positive integer, got ${bound.maxRetries}`,
    );
  }
  let last: unknown;
  for (let attempt = 0; attempt <= bound.maxRetries; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!isRetryable(e)) throw e;
      last = e;
    }
  }
  throw new RetriesExhausted(bound.label, bound.maxRetries + 1, bound.subject ?? null, {
    cause: last,
  });
}
