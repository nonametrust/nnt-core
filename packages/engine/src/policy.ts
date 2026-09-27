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
   *
   * Refused if it is not already trimmed. Task 6 compares this against the
   * intent's unit, and against a padded policy that comparison refuses a
   * CORRECT intent -- the coercion problem arriving as a false refusal instead
   * of a wrong answer. Trimming on read would be the coercion; refusing where
   * the value is declared is not.
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
   *
   * It composes PER ACTIVE TAG, so the lowered threshold is
   * `briefThreshold × activeTagFactor^k` for k active tags — not a single
   * multiplication. The shipped default's derivation is written out at
   * `BRIEF_POLICY_V0`, where an earlier version of that sentence described one
   * tag and the merged acceptance corpus has two.
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
  /**
   * The relatedness at or above which a tag is a reason for this intent. "At or
   * above", so the comparison is `>=` and a term equal to the floor is a reason.
   *
   * WHAT IT IS NOT: a measured number. Nothing in the study speaks to how
   * related two pieces of evidence must be before one bears on the other.
   *
   * Strictly below 1, and that bound is a CORRECTION. It was declared `(0, 1]`
   * on the argument that a floor of 1 expresses "only same-channel evidence
   * counts". It does not, twice over: the cross-field rule in
   * `assertBriefPolicy` requires `crossChannelAffinity >= relatednessFloor`
   * while the affinity is itself capped below 1, so a floor of 1 is refused
   * under EVERY affinity — measured at 0.55, at 0.999 and at 1 — and even were
   * it reachable, a floor of 1 with an affinity of 1 would still make
   * cross-channel evidence a reason. The effective range was always `(0, 1)`;
   * it is declared that way now so the refusal names this field rather than
   * arriving from the pair.
   *
   * WHAT WOULD REPLACE IT: a measured rate of how often same-namespace
   * cross-channel evidence precedes a loss, from the shadow evaluation.
   *
   * IT DECIDES NOTHING IN M3, and that is worth knowing before anyone tunes it.
   * Under R11 and R12 relatedness takes exactly three values -- 0 for a
   * different namespace, `crossChannelAffinity` for a different channel, 1 for
   * the same `(channel, aspect)` -- and the cross-field rule forces this floor
   * at or below the affinity. So every admissible policy partitions those three
   * values identically, and two policies differing only in this field return
   * byte-identical briefs. Measured at floors 0.01, 0.3 and 0.55. It becomes
   * load-bearing when M4 makes relatedness continuous, or sooner if the fourth
   * case below is given a value beneath the affinity.
   *
   * THE FOURTH CASE R12 DOES NOT RULE: same namespace, same channel, DIFFERENT
   * ASPECT -- `price/quoted/USDC` against `price/quoted/XLM`, both of which the
   * corpus produces. R12 names three terms and the data model has four, and
   * design §1 puts aspect matching inside `rel()`. Owed a ruling before Task 4.
   */
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
   * Its own `> 0` bound is REDUNDANT given that rule -- a floor is always
   * positive, so an affinity of 0 fails the pair before it fails the bound --
   * and is kept because a refusal that names this field is what a reader of the
   * message needs. Said here because the test row for 0 is killed by the pair
   * and not by this bound, and a comment claiming otherwise would be false.
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
   *
   * Strictly below `briefThreshold`, and that rule is the same argument
   * reaching the ceiling's VALUE rather than only its location. Measured: with
   * the threshold at 3000, ceilings of 5000, 3000 and 2900 were all accepted,
   * and at 5000 a medium-risk intent of 4000 PROCEEDS while a store is
   * unreachable and is HELD when it is reachable. That is the layer bypassed by
   * making it unavailable, wearing a valid-looking policy.
   *
   * NECESSARY AND NOT SUFFICIENT, and the gap is declared rather than implied:
   * an active tag multiplies the threshold down, so 3000 × 0.8^7 = 629.15 sits
   * UNDER the shipped ceiling of 750, and a counterparty with seven active tags
   * is again more permissively treated when a store is down. Nothing in M3
   * bounds the number of active tags, so no rule over these two numbers can
   * close it; closing it needs a floor under the lowered threshold, which is a
   * number nobody has measured.
   *
   * WHAT WOULD REPLACE IT: a measured loss rate by amount band, which would
   * also give the floor above.
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
   * Zero is refused, so "never retry" is not expressible — declared rather than
   * left to be discovered, and defensible because under R7 a `Deadlocked` that
   * is never retried becomes an unavailability, which is the one response 40P01
   * was mapped to `Deadlocked` to avoid.
   *
   * NAMED FOR THE BRIEF AND USED BY INGEST. `BaselineStale`, `TagRefreshStale`
   * and the 23505 on `tag_one_live_per_pair` are all ingest-path refusals, and
   * this bound governs them too. The name is the plan's; a reader expecting a
   * brief-only value will trip on it, so it is said here.
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
 * of 3000 and is held once an active tag has lowered it. Recorded as fitted,
 * because design §8:338-339 admits the same of its own defaults and the failure
 * this project has already paid for is a number chosen to make a test pass and
 * then described as measured.
 *
 * THE FIRST VERSION OF THIS SENTENCE SAID "3000 × 0.8 = 2400 < 2500" AND THAT
 * IS ONE TAG. The factor composes per active tag, and review replayed M2's
 * corpus -- which R15 merges into the acceptance scenario -- through the real
 * `tagObservation` and the store's real `strengthAt` at the day-twenty-one
 * instant: a `protocol/event/trustline_open` state at strength 0.5197, the
 * `address_integrity/transition` tag at 0.4165, and the `price/quoted/USDC` tag
 * the day-twenty-one quote opens at 0.4151. R22 excludes the last as the
 * intent's own, leaving TWO active tags and a threshold of 3000 × 0.8² = 1920.
 * 2500 is held either way, so §9's outcome survives -- but the arithmetic in the
 * sentence did not, and the measurement is what corrected it.
 *
 * WHAT THAT COSTS TASK 9, recorded here because it is where the numbers live:
 * the trustline state is refreshed every morning, so it is active from day ONE
 * and the provider's threshold is lowered before the day-twelve address change
 * exists. Task 9's acceptance -- "the provider's threshold lower than the same
 * query returns for a counterparty with no active tag" -- is therefore
 * satisfiable with the day-twelve tag doing no work at all, which is R22's
 * failure one tag over. The comparison Task 9 needs is the provider before and
 * after day twelve, or with the address tag filtered out.
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
  // Refused rather than trimmed: Task 6 compares this against the intent's unit
  // and a padded policy refuses a correct intent.
  if (policy.thresholdUnit !== policy.thresholdUnit.trim()) {
    throw new RangeError(
      `${label("thresholdUnit")} must not be padded, got ${JSON.stringify(policy.thresholdUnit)}`,
    );
  }
  requirePositive(label("briefThreshold"), policy.briefThreshold);
  // Open at 1: a factor of 1 lowers nothing.
  requireUnitInterval(label("activeTagFactor"), policy.activeTagFactor, false);
  // CLOSED at 1, deliberately: it is the nearest thing to an OFF setting this
  // value has, the control configuration for a champion-challenger run in which
  // almost no tag lowers any threshold. Which is also why refusing
  // `activeTagFactor` of 1 is not over-strict: the two express different things.
  //
  // WHAT "ALMOST" IS DOING THERE, because an earlier version of this comment
  // said "a saturated tag at the instant of its own refresh and nothing else"
  // and that was wrong twice, both measured. `strengthAt` returns `g0` for
  // EVERY non-positive elapsed (`strength.ts:38`), not only for zero, so a floor
  // of 1 admits any tag with `g0 === 1` whose `taggedAt` is at or AFTER the
  // instant being asked about -- which the synchronous path never produces, but
  // a REPLAY does, since the brief's `at` is an input. And `g0 === 1` is
  // reachable on an OPEN tag under an admissible policy, not only by saturation:
  // `categoricalBase` and the calibration weights are each closed at 1, so their
  // product can be 1. Under the shipped numbers no open tag gets there -- the
  // largest categorical g0 is 0.774 -- but the bound admits a policy where one
  // does.
  requireUnitInterval(label("activeFloor"), policy.activeFloor, true);
  // OPEN at 1, and this is a correction. It was closed, on the argument that a
  // floor of 1 expresses "only same-channel evidence counts". Measured: the
  // cross-field rule below refuses a floor of 1 under EVERY admissible affinity,
  // so the closed end was unreachable and the declared interval said otherwise.
  requireUnitInterval(label("relatednessFloor"), policy.relatednessFloor, false);
  // Open at 1 by R12: at 1 the term is not a cross-channel affinity.
  requireUnitInterval(label("crossChannelAffinity"), policy.crossChannelAffinity, false);
  requirePositive(label("mediumCeiling"), policy.mediumCeiling);
  requirePositiveInteger(label("maxRetries"), policy.maxRetries);
  // Two cross-field rules. Each field above can be in range while a PAIR is
  // incoherent, and both pairs were measured to be reachable under a policy
  // that looked valid.
  //
  // First: an affinity below the floor is in range and DEAD -- the term R12
  // exists to make non-zero can never produce a reason, so relatedness silently
  // becomes same-channel-only, which is R12's own failure wearing a valid
  // policy. WHAT THIS COSTS, corrected: same-channel-only relatedness is NOT
  // expressible under this policy at all. An earlier version of this comment
  // said it was reachable by a floor of 1; it is not, because the affinity must
  // clear the floor and is itself below 1. A challenger policy that wants it
  // needs a field this value does not have.
  if (!(policy.crossChannelAffinity >= policy.relatednessFloor)) {
    throw new RangeError(
      `${label("crossChannelAffinity")} ${policy.crossChannelAffinity} must be at least ` +
        `${label("relatednessFloor")} ${policy.relatednessFloor}, or a same-namespace reason on a ` +
        `different channel can never clear the floor`,
    );
  }
  // Second: a ceiling at or above the threshold it sits under makes the
  // unavailable path MORE permissive than the available one, which is design
  // §6:281's prohibition -- degrading availability is not a way to bypass the
  // layer. Necessary and not sufficient: the lowered threshold can still fall
  // under the ceiling, and `mediumCeiling`'s own comment carries the measured
  // seven-tag case.
  if (!(policy.mediumCeiling < policy.briefThreshold)) {
    throw new RangeError(
      `${label("mediumCeiling")} ${policy.mediumCeiling} must be below ` +
        `${label("briefThreshold")} ${policy.briefThreshold}, or a medium-risk intent proceeds ` +
        `while a store is unavailable and is held when it is reachable`,
    );
  }
}
