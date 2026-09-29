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
export type UnavailableCondition = "connection" | "cancelled" | "engine_timeout";

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
 * The SQLSTATEs R28 retries: both deadlock spellings, and the unique-violation the
 * live-tag pair raises under a race.
 *
 * `23505` is here and is NOT retryable on its own — see `isRetryable`, which requires
 * the constraint name. The set exists so a RAW 23505 from a non-mapping path is not
 * mistaken for an outage; whether it is retried is a narrower question.
 */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001", "23505"]);

/** The one unique key R28 names for a retry. */
const RETRYABLE_CONSTRAINT = "tag_one_live_per_pair";

/** A SQLSTATE is five characters; a libuv error code is not. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The SQLSTATE an error carries, from whichever shape it arrived in.
 *
 * The store's `ConstraintViolation` exposes `sqlstate`; a raw driver error carries
 * `code`. `code` is also where libuv puts `ECONNREFUSED`, so the shape is checked
 * rather than the field's presence.
 */
function sqlstateOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const withSqlstate = e as { sqlstate?: unknown; code?: unknown };
  if (typeof withSqlstate.sqlstate === "string" && SQLSTATE.test(withSqlstate.sqlstate)) {
    return withSqlstate.sqlstate;
  }
  if (typeof withSqlstate.code === "string" && SQLSTATE.test(withSqlstate.code)) {
    return withSqlstate.code;
  }
  return null;
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
  if (e instanceof EngineTimeout) return "engine_timeout";
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
    return CANCELLED_SQLSTATES.has(sqlstate) ? "cancelled" : null;
  }
  // No SQLSTATE at all, and not a class the store named. Reached only for an error
  // that came out of a store call, so the server never answered: a refused
  // connection, a connect timeout, a socket that died mid-query. A `RangeError` from
  // our own validation is not one of those and never reaches here on the real path,
  // because input is refused by name before any store call is made.
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
  return sqlstate === "40P01" || sqlstate === "40001";
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

/**
 * R7's third condition: a bound the ENGINE sets on a store call.
 *
 * A server that has stopped answering produces no error to classify, so without this
 * a brief waits for as long as the driver will. The bound is the engine's because it
 * is the only party that knows how long the answer is still worth having.
 *
 * The call's OWN failure passes through unchanged — a timeout reported for a store
 * that refused in 3ms would send the tiered policy after a database that is up.
 */
export async function withStoreTimeout<T>(
  call: () => Promise<T>,
  budgetMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError(`timeout budget must be a positive finite number, got ${budgetMs}`);
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
