import { strengthAt, type StoredTag } from "@nonametrust/store";
import { assertBriefPolicy, type BriefPolicy } from "./policy.js";
import { isReason, type Related } from "./relatedness.js";

/**
 * The reads a threshold needs: one.
 *
 * Narrower than `BriefReads` on purpose. A threshold is a count of reasons, and a
 * count needs no `readClear` — that call exists to give a REASON its dated instant
 * and its source code, which a threshold does not report. So the query costs one
 * round trip where the brief costs one plus one per reason, and the difference is
 * visible in the type rather than in a comment.
 */
export interface ThresholdReads {
  listLive(namespaceId: string): Promise<readonly StoredTag[]>;
}

/**
 * What a threshold is asked about.
 *
 * **IT TAKES THE INTENT, and that is R39's cost paid in a signature.** Design §6
 * asks for "the current threshold as a query" and M3's plan wrote
 * `thresholdFor(namespaceId, at)`. Neither is implementable once relatedness gates
 * the lowering: the same counterparty at the same instant has a different threshold
 * for a `price` intent than for an `address_integrity` one, because a different set
 * of tags clears `relatednessFloor` against each. An intent-free query would have to
 * pick one of those answers and could not say which.
 *
 * So design §6's sentence either goes or becomes a second, intent-free query that no
 * brief uses. This is the one the brief uses.
 *
 * It takes `policy` and `halfLifeMs` rather than all four policies, because those
 * are what a threshold reads: the other two contribute only their versions, and a
 * version belongs to the audit body rather than to this arithmetic.
 */
export interface ThresholdQuery {
  readonly at: Date;
  readonly intent: Related;
  /** The intent's own observation, for R22's exclusion. */
  readonly observationId: string;
  /** The tags this intent opened OR refreshed, for R41's. */
  readonly ownTagIds: readonly string[];
  readonly policy: BriefPolicy;
  /** `Calibration.halfLifeMs`, which `strengthAt` takes as an argument. */
  readonly halfLifeMs: number;
}

/** A threshold with an account of itself. */
export interface Threshold {
  readonly base: number;
  readonly applied: number;
  /**
   * The tags that lowered it, which under R39 is exactly the set the brief may
   * cite. A test asserts the two are equal at both entry points.
   */
  readonly loweredBy: readonly string[];
}

/** One tag that both lowers the threshold and may be cited. */
export interface CountedTag {
  readonly tag: StoredTag;
  /** `strengthAt(tag, at, halfLifeMs)`, the value the decision was made on. */
  readonly strength: number;
}

/**
 * The threshold after the lowering, R4.
 *
 * MULTIPLICATIVE AND ONCE PER REASON. Multiplicative because the threshold is an
 * amount in value units and a subtraction would have to name a currency while a
 * factor does not; once per reason because two reasons compose, so the lowered
 * threshold is `briefThreshold × activeTagFactor^k` and not a single multiplication.
 *
 * ONE FUNCTION, called by `thresholdFor` and by the brief. The plan's acceptance —
 * "the threshold query and the brief read one value at one instant" — is satisfiable
 * by two copies of this arithmetic that a test compares, and a review found the
 * brief had inlined exactly that. Two copies are two things that drift; this is one.
 *
 * IT CAN RETURN ZERO, and that is R60 rather than a bug. `base × factor^k` stops
 * being a positive double at 3340 reasons under factor 0.8 and at 162 under 0.01,
 * which `assertBriefPolicy` accepts. The zero is returned honestly: the brief grades
 * `hold` on it, which is `amount >= threshold` at its limit, and a clamp here would
 * be an uncalibrated number R5 would have to declare.
 */
export function loweredThreshold(policy: BriefPolicy, reasonCount: number): number {
  if (!Number.isSafeInteger(reasonCount) || reasonCount < 0) {
    throw new RangeError(
      `threshold reasonCount must be a non-negative integer, got ${reasonCount}`,
    );
  }
  return policy.briefThreshold * Math.pow(policy.activeTagFactor, reasonCount);
}

/**
 * The tags that count, in the order R53 fixes.
 *
 * SHARED BY THE QUERY AND THE BRIEF, which is what makes their agreement structural
 * rather than asserted. Every exclusion here is a ruling, and a divergence between
 * two copies of them would be invisible in the brief's output: R22 and R41 on which
 * tags are the intent's own, R43 on the instant, and R39's single predicate for both
 * jobs.
 */
export async function countedTags(
  query: ThresholdQuery,
  reads: ThresholdReads,
): Promise<readonly CountedTag[]> {
  assertBriefPolicy(query.policy);
  if (!Number.isFinite(query.halfLifeMs) || query.halfLifeMs <= 0) {
    throw new RangeError(
      `threshold.halfLifeMs must be a positive finite number, got ${query.halfLifeMs}`,
    );
  }
  if (!(query.at instanceof Date) || Number.isNaN(query.at.getTime())) {
    throw new RangeError(`threshold.at must be a valid instant, got ${String(query.at)}`);
  }

  const own = new Set(query.ownTagIds);
  const live = await reads.listLive(query.intent.namespaceId);

  const counted: CountedTag[] = [];
  for (const t of live) {
    // BOTH FILTERS, and two review lenses converged on that independently. R41 ruled
    // the filter is on tag IDENTITY, because a refresh keeps the OPENING
    // observation's id, so a tag the intent refreshed survives an observation-id
    // filter and lowers the intent's own threshold. That ADDED a filter; it did not
    // retire R22's, and the plan's acceptance still says in bold "no reason's
    // observation is the intent's own". On the supported path `ownTagIds` covers
    // both; what the second closes is a caller that passes an incomplete list.
    if (own.has(t.tagId) || t.observationId === query.observationId) continue;
    // NAMED, because this value comes from the store rather than from the caller and
    // `strengthAt` refuses it with a message that says nothing about WHICH tag. It
    // must be checked BEFORE the comparison below: `NaN > x` is false, so an invalid
    // instant walks straight past it.
    if (Number.isNaN(t.taggedAt.getTime())) {
      throw new RangeError(
        `threshold.tags[${t.tagId}].taggedAt from the store is not a valid instant: ` +
          `${String(t.taggedAt)}`,
      );
    }
    // R43. `strengthAt` returns `g0` for EVERY non-positive elapsed, so a tag stamped
    // after `at` reports full strength: a past threshold counting it would be
    // reporting evidence that did not exist yet, at a strength it never had.
    // NECESSARY AND NOT SUFFICIENT (R42): a refreshed tag's earlier state is not
    // recoverable, so a past instant is correct about what existed and approximate
    // about how strong it was.
    if (t.taggedAt.getTime() > query.at.getTime()) continue;
    const strength = strengthAt(t, query.at, query.halfLifeMs);
    // ONE PREDICATE FOR BOTH JOBS (R39). Whatever fails this neither lowers the
    // threshold nor is citable, so a hold caused by a tag always has that tag among
    // its reasons and the only zero-reason hold is a hold on the amount alone.
    // `no-floor-outside-relatedness.test.ts` refuses this module to name a floor,
    // which is why the comparison is `isReason` and not two of its own.
    if (!isReason({ ...t, strength }, query.intent, query.policy)) continue;
    counted.push({ tag: t, strength });
  }

  // R53, and it is R1 rather than presentation. `listLive` orders by `tagged_at
  // desc`, and two tags stamped at one instant have no order at all, so a threshold
  // or a brief that passed the store's order through would answer differently on two
  // runs over the same rows. Strength descending because that is the order a reader
  // wants; `tagId` ascending because a total order needs a tiebreak on something
  // unique, and an observation id is NOT unique across tags — a mutant that used one
  // survived until a fixture stopped making the two coincide.
  counted.sort((a, b) => b.strength - a.strength || (a.tag.tagId < b.tag.tagId ? -1 : 1));
  return counted;
}

/**
 * This counterparty's threshold for THIS intent at THIS instant, with the tags that
 * lowered it.
 *
 * R3, R4 and R27's arithmetic half. The unit refusal is the BRIEF's, not this
 * function's: it exists because an amount is graded against a threshold, and a query
 * that returns a threshold has no amount to grade. A `thresholdFor` demanding a unit
 * would be refusing a question nobody asked.
 *
 * Task 9's comparison must use THIS function rather than an intent-free one, and the
 * ledger records a second constraint on it: the day-eleven threshold cannot be
 * produced by replaying a past `at` against a store seeded to day twenty-one,
 * because a daily-refreshed state's `tagged_at` has moved and R43 then excludes it.
 * It has to be taken live, with the clock advanced through the corpus.
 */
export async function thresholdFor(
  query: ThresholdQuery,
  reads: ThresholdReads,
): Promise<Threshold> {
  const counted = await countedTags(query, reads);
  return {
    base: query.policy.briefThreshold,
    applied: loweredThreshold(query.policy, counted.length),
    loweredBy: counted.map((c) => c.tag.tagId),
  };
}
