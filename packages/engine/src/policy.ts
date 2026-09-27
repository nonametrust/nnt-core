import { requirePositive, requireUnitInterval } from "@nonametrust/tagging";

/**
 * The brief's numbers, versioned, and the third such value in the tree.
 *
 * WHY A THIRD VALUE rather than seven more fields on `Policy`. `Policy`
 * belongs to `@nonametrust/tagging` and the brief belongs to the engine, so a
 * brief field there is a number that package never reads. And the M2
 * collision map is the harder reason: `thresholdBase`, `surpriseScale` and
 * `winsorMadMultiple` are all 3 in the shipped tagging policy, so a
 * computation reading the wrong field of a default policy got the right
 * number back and no test could see it. A separate value removes that class
 * of bug instead of testing for it, and `policy.test.ts` holds this value's
 * own numbers to being pairwise distinct so the class cannot reappear here.
 *
 * WHAT IT COSTS, recorded rather than hidden: the audit body's
 * `policy_version` is now a composite of four versions, not two -- retention,
 * tagging policy, calibration and this one -- and the champion-challenger key
 * is a quadruple.
 *
 * NONE OF THESE NUMBERS IS MEASURED. The backtest behind this project
 * measured whether evidence exists before a loss, not how an engine should
 * weigh it, so none of them is derivable from it. Each was chosen so that the
 * parent spec's section 9 scenario behaves as the whitepaper describes, which
 * is the same admission design §8 already makes about its own defaults; this
 * value does not improve on that by pretending otherwise. Every one is
 * re-derivable when the shadow evaluation measures a population, and each
 * carries below what it is, what it is not, and what would replace it.
 *
 * All fields are readonly. A policy is a value, and a value one computation
 * could edit for the next would make the version a lie.
 */
export interface BriefPolicy {
  /**
   * What the champion-challenger arrangement keys on and what every audit body
   * names. May not contain `/`: R26 joins the four versions as
   * `retention/tagging/calibration/brief`, and a component carrying the
   * separator would make the composite unparseable.
   */
  readonly version: string;
  /**
   * The amount at or above which an intent is held when nothing lowers the
   * bar, in `thresholdUnit`.
   *
   * NOT the tag threshold. `tagThreshold` in `@nonametrust/tagging` is θ_tag
   * in robust-z units, applied per reading at ingest; this is an amount in
   * value units, applied per counterparty at brief time. The design's
   * vocabulary has both and the code had only the first, which is F2.
   */
  readonly briefThreshold: number;
  /**
   * The unit `briefThreshold` and `mediumCeiling` are denominated in. An
   * intent carrying a different unit is refused by name rather than coerced:
   * a coercion here would need an exchange rate, which is a price feed and a
   * trust assumption this system does not have.
   */
  readonly thresholdUnit: string;
  /**
   * What one active tag multiplies the threshold by. Multiplicative and not
   * subtractive, because the threshold is an amount in value units and a
   * subtraction would have to name a currency while a factor does not; two
   * active tags compose by multiplying.
   *
   * Must lie strictly inside (0, 1). At 1 an active tag lowers nothing, which
   * makes the whole mechanism a no-op that still passes any test phrased as
   * "lower than it was".
   *
   * WHAT IT CANNOT EXPRESS: "never above X regardless", which a subtraction
   * can. If that is wanted it is a separate cap and not this number.
   */
  readonly activeTagFactor: number;
  /**
   * The decayed strength at or above which a tag counts as ACTIVE.
   *
   * Why a floor and not "live": nothing in this system retires a tag,
   * `listLive` returns every tag ever opened, and `strengthAt` reaches zero
   * only after about 1074 suppressed half-lives. "Active = live" therefore
   * means every tag ever opened lowers the threshold forever, and the
   * threshold means nothing.
   *
   * MEASURED HAZARD: at the calibrated half-life the section 9 scenario's two
   * tags sit 0.0014 apart around 0.415, so a floor chosen there flips which
   * one is active between two scenarios that differ in nothing else. Held by a
   * test, not only by this sentence.
   */
  readonly activeFloor: number;
  /** The relatedness at or above which a tag is a reason for this intent. */
  readonly relatednessFloor: number;
  /**
   * Relatedness of two readings in the same namespace on DIFFERENT channels.
   *
   * Strictly between 0 and 1, and both bounds carry a reason. Zero was the
   * first version of this plan's implicit answer and it made the acceptance
   * scenario's own case score nothing: the day-twelve tag is
   * `address_integrity/transition` and the day-twenty-one intent is `price`,
   * so a zero term makes the address change not a reason while design §9 and
   * Task 9 both require it to be one. One would make a different channel worth
   * exactly as much as the same channel, which is the term deleted rather than
   * declared.
   *
   * It must also clear `relatednessFloor`, or the term is in range and dead.
   */
  readonly crossChannelAffinity: number;
  /**
   * The amount below which a MEDIUM-risk intent proceeds while a store is
   * unavailable, in `thresholdUnit`.
   *
   * On the policy and NOT on the brief's input, which is where an earlier
   * ruling put it: a caller supplying its own ceiling is a caller raising it,
   * and design §6:281 says degrading availability is not a way to bypass the
   * layer.
   */
  readonly mediumCeiling: number;
  /**
   * How many times a retryable refusal is retried before it is recorded and
   * given up on. `BaselineStale`, `TagRefreshStale`, a 23505 on
   * `tag_one_live_per_pair` and `Deadlocked` all retry; an unbounded retry
   * loop is a denial of service on ourselves, which is the argument the
   * producer cap already makes in the store.
   *
   * A positive integer: a bound of 2.5 retries is a bound nothing can honour.
   */
  readonly maxRetries: number;
}

/**
 * The separator R26 joins the four policy versions with. Declared here
 * because this module is what refuses a version containing it.
 */
export const VERSION_SEPARATOR = "/";

/**
 * v0. Chosen so the section 9 scenario behaves, and that is the whole
 * derivation: a 2500 USDC request on day twenty-one passes the base threshold
 * and is held once the day-twelve address tag has lowered it (3000 × 0.8 =
 * 2400 < 2500). Recorded as fitted, because design §8:338-339 admits the same
 * of its own defaults and the failure this project has already paid for is a
 * number chosen to make a test pass and then described as measured.
 *
 * Every number here differs from every other, held by a test. The M2
 * collision map is why.
 */
export const BRIEF_POLICY_V0: BriefPolicy = {
  version: "brief-policy-v0",
  briefThreshold: 3000,
  thresholdUnit: "USDC",
  activeTagFactor: 0.8,
  activeFloor: 0.25,
  relatednessFloor: 0.3,
  crossChannelAffinity: 0.55,
  mediumCeiling: 750,
  maxRetries: 5,
};

/** Refused unless a non-blank string. Returns the value for the caller to use. */
function requireNonBlank(label: string, value: string): string {
  if (value.trim().length === 0) throw new RangeError(`${label} must not be blank`);
  return value;
}

/** Refused unless a positive integer. Returns the value for the caller to use. */
function requirePositiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

const label = (field: keyof BriefPolicy): string => `briefPolicy.${field}`;

/**
 * A policy the brief can use, refused up front and once rather than
 * discovered as a NaN three functions deep.
 *
 * The three range predicates come from `@nonametrust/tagging` rather than
 * being written again here. One predicate cannot drift from itself, and one
 * phrasing per predicate is what lets a test hold two callers to the same
 * message -- the habit that caught four rules on the storage card.
 */
export function assertBriefPolicy(policy: BriefPolicy): void {
  requireNonBlank(label("version"), policy.version);
  if (policy.version.includes(VERSION_SEPARATOR)) {
    throw new RangeError(
      `${label("version")} must not contain the composite separator ${VERSION_SEPARATOR}, got ${policy.version}`,
    );
  }
  requireNonBlank(label("thresholdUnit"), policy.thresholdUnit);
  requirePositive(label("briefThreshold"), policy.briefThreshold);
  // Open at 1: a factor of 1 lowers nothing.
  requireUnitInterval(label("activeTagFactor"), policy.activeTagFactor, false);
  // Closed at 1: a floor of 1 admits only a tag at full strength, which is a
  // strict setting and not an incoherent one.
  requireUnitInterval(label("activeFloor"), policy.activeFloor, true);
  requireUnitInterval(label("relatednessFloor"), policy.relatednessFloor, true);
  // Open at 1 by R12: at 1 the term is not a cross-channel affinity.
  requireUnitInterval(label("crossChannelAffinity"), policy.crossChannelAffinity, false);
  requirePositive(label("mediumCeiling"), policy.mediumCeiling);
  requirePositiveInteger(label("maxRetries"), policy.maxRetries);
  // A cross-field rule, and the only one here. Each of the two is in range
  // and the PAIR can still be inverted, in which case the term R12 exists to
  // make non-zero can never produce a reason and relatedness silently becomes
  // same-channel-only. The cost: "only same-channel evidence counts" is not
  // expressible this way, and is reachable instead by a floor of 1.
  if (!(policy.crossChannelAffinity >= policy.relatednessFloor)) {
    throw new RangeError(
      `${label("crossChannelAffinity")} ${policy.crossChannelAffinity} must be at least ` +
        `${label("relatednessFloor")} ${policy.relatednessFloor}, or a same-namespace reason on a ` +
        `different channel can never clear the floor`,
    );
  }
}
