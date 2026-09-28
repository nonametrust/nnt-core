import { assertCalibration, assertPolicy, type Calibration, type Policy } from "@nonametrust/tagging";
import {
  assertRetentionPolicy,
  strengthAt,
  type AuditEntryInput,
  type ClearObservation,
  type RecordTriggerEvent,
  type RetentionPolicy,
  type StoredTag,
} from "@nonametrust/store";
import {
  assertAuditBody,
  RISK_TIERS,
  type BriefAuditBody,
  type BriefAuditReason,
  type RiskTier,
} from "./audit-body.js";
import { compositePolicyVersion } from "./composite-version.js";
import { gradeFor, type Grade } from "./grade.js";
import { assertBriefPolicy, type BriefPolicy } from "./policy.js";
import { isReason, relatedness, relatednessCase, type Related, type RelatednessCase } from "./relatedness.js";

/**
 * The reads the core is allowed to make, and nothing else.
 *
 * A NARROW PORT AND NOT THE REPOSITORIES THEMSELVES, which is a departure from
 * the plan's "reads through repositories handed to it" and the reason is G9.
 * Handing the core an `ObservationRepository` hands it `append`; a `TagRepository`
 * hands it `open`, `refresh` and `suppress`. "The core writes nothing" would then
 * rest on the core not calling methods it holds, which is convention -- and every
 * unenforced property in this repository has so far turned out to be false.
 *
 * With two read methods the claim is structural before it is measured. It is still
 * measured: `brief-db.test.ts` compares every table's `xmin` before and after,
 * because a type property is not a measurement.
 *
 * `listLive` takes no instant, which is not an omission. The store's own
 * `listLive(namespaceId, since?)` bounds `tagged_at` from BELOW, and R43 needs an
 * upper bound -- so the exclusion is applied here, to what the port returns. Its
 * `since` would be the wrong direction and, per its own docstring, selects on the
 * LAST refresh instant rather than the opening one.
 */
export interface BriefReads {
  readClear(observationId: string): Promise<ClearObservation>;
  listLive(namespaceId: string): Promise<readonly StoredTag[]>;
}

/** The four policies a brief is decided under. R26 joins their versions. */
export interface BriefPolicies {
  readonly retention: RetentionPolicy;
  readonly tagging: Policy;
  readonly calibration: Calibration;
  readonly brief: BriefPolicy;
}

/**
 * Why a reason's source would or would not open, R47. A CODE and never a
 * dereference.
 */
export type ReasonSource =
  | { readonly code: "SOURCE_PRESENT" }
  | {
      readonly code: "SOURCE_UNREADABLE";
      readonly periodExpired: boolean;
      readonly namespaceErased: boolean;
    };

/** One piece of evidence the brief both counted and may cite. */
export interface Reason {
  readonly tagId: string;
  /** The tag's OPENING observation, R30. A refresh does not move it. */
  readonly observationId: string;
  /** The TAG's channel, which M2 guarantees is its evidence's. */
  readonly channel: string;
  /** The TAG's aspect. `readClear` does not return one -- that is R40's whole point. */
  readonly aspect: string;
  /**
   * The clear column R13 names alongside the others, and which was dropped from the
   * requirements' shape without anyone recording the narrowing. Restored: R13 lists
   * `dated_at`, `channel`, `aspect` and `evidence_kind` as what survives in the clear,
   * and this is the one of the four that comes from the observation rather than the
   * tag. It is NOT in the audit body -- see `BriefAuditReason`.
   */
  readonly evidenceKind: string;
  /** `null` for a state, R19. */
  readonly datedAt: Date | null;
  /** `strengthAt(tag, at)`, the value this decision was made on. */
  readonly strength: number;
  readonly relatedness: number;
  readonly relatednessCase: RelatednessCase;
  /**
   * R30. **A post-refresh value at any past `at`** (R42): `refresh` overwrites
   * `g0`, `tagged_at`, `refresh_count` and `saturation_state` and keeps no
   * history, so a past instant's count cannot be reconstructed by any filter.
   */
  readonly refreshCount: number;
  readonly source: ReasonSource;
}

/** What the core is handed. It reads no clock and mints no id; both are inputs. */
export interface BriefInput {
  /** The wrapper's `clock.now()`. The core never reads one -- that is R1. */
  readonly at: Date;
  readonly briefId: string;
  readonly triggerId: string;
  /**
   * The intent's derived reading, CARRIED from `observe` (R40) and not decrypted
   * here. `readClear` returns the channel and not the aspect, and opening the
   * payload to get it costs a brief its replayability: after a sweep
   * `get(intent)` raises `PayloadExpired`, so a brief could not be replayed 90 to
   * 120 days later at all -- which would undermine R13, whose whole design is to
   * keep a reason whose source will not open.
   *
   * THE RESIDUAL RISK, STATED: an integrator calling this core directly with a
   * fabricated aspect gets wrong relatedness. Mitigated by the wrapper being the
   * supported entry point, which R20 already records is a convention rather than
   * a mechanism.
   */
  readonly intent: Related;
  /**
   * The intent's own observation. Three jobs: the R14 liveness check, R22's
   * observation-id exclusion, and the identity the audit body records.
   */
  readonly observationId: string;
  /** R8. Zero is admissible; negative is refused. */
  readonly amount: number;
  /** Refused unless it is the policy's `thresholdUnit` (R27, R44). */
  readonly unit: string;
  readonly riskTier: RiskTier;
  /**
   * The tags this intent opened OR REFRESHED (R41).
   *
   * R22 excludes "any tag whose `observation_id` is the intent's", and a refresh
   * keeps the OPENING observation's id -- measured -- so a tag the intent itself
   * refreshed survives an observation-id filter and reads full strength at the
   * intent's own instant. The intent then lowers its own threshold through the tag
   * it just refreshed, which is what R22 exists to prevent, one verb over. The
   * filter is on identity, not on provenance.
   */
  readonly ownTagIds: readonly string[];
  /**
   * From `observe`. `null` means no trigger effect, and it is the one branch that
   * is both R18 (a categorical intent has no surprise) and R29 (a cold continuous
   * intent has no baseline to be surprised against).
   *
   * NOT RECOMPUTED HERE, and it could not be: it lives only on `trigger_event`,
   * the tag row has none, and recomputing it would judge against a baseline that
   * already holds the intent's own fold -- which R10 forbids.
   */
  readonly surprise: number | null;
  readonly policies: BriefPolicies;
}

/**
 * The effects the WRAPPER performs. The core returns them and performs none.
 *
 * A RECORD AND NOT A TUPLE, which is a correction to Task 5's requirements. They
 * give `readonly [TriggerToRecord?, AuditBodyToAppend?]`, "in that order". Two
 * problems, and the second is the one that matters: a tuple of two optional
 * elements admits `[]` and `[trigger]`, so **a brief that writes a trigger and no
 * chain entry typechecks** -- and R24 rules that a committed write with no chain
 * entry is a named inconsistency, which the ledger extends to the brief verbatim.
 * The type should not make the inconsistency expressible.
 *
 * The trigger really is optional (R18, R29). The audit entry is not. And the ORDER
 * a tuple was carrying is a property of the wrapper, held by a test that records
 * the order the two calls actually happen in -- which is where it always was,
 * since a tuple cannot make a caller perform its elements in sequence.
 */
export interface BriefEffects {
  readonly trigger: RecordTriggerEvent | null;
  readonly audit: AuditEntryInput;
}

/** What the brief answers. */
export interface BriefOutput {
  readonly grade: Grade;
  readonly reasons: readonly Reason[];
  /**
   * `loweredBy` is REDUNDANT with `reasons[].tagId` under R39 -- they are the same
   * set -- and a test asserts the equality rather than letting the two drift. It
   * is reported anyway because a grade needs an account of itself that a reader
   * does not have to derive.
   */
  readonly threshold: {
    readonly base: number;
    readonly applied: number;
    readonly loweredBy: readonly string[];
  };
  readonly effects: BriefEffects;
}

/** A brief refused because the counterparty's namespace key is gone. R14. */
export class NamespaceErased extends Error {}

function requireNonBlank(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError(`brief.${field} must be a string, got ${typeof value}`);
  }
  if (value.trim().length === 0) throw new RangeError(`brief.${field} must not be blank`);
  return value;
}

/**
 * Every refusal up front, each naming its field.
 *
 * Up front rather than where each value is first used, for the reason
 * `assertBriefPolicy`'s own docstring gives: a bad value discovered three
 * functions deep arrives as a NaN in a comparison, and a NaN fails `>=` and comes
 * back as the SOFTEST grade produced by the worst input.
 */
function assertInput(input: BriefInput): void {
  if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
    throw new RangeError(`brief.at must be a valid instant, got ${String(input.at)}`);
  }
  requireNonBlank("briefId", input.briefId);
  requireNonBlank("triggerId", input.triggerId);
  requireNonBlank("observationId", input.observationId);
  requireNonBlank("intent.namespaceId", input.intent.namespaceId);
  requireNonBlank("intent.channel", input.intent.channel);
  requireNonBlank("intent.aspect", input.intent.aspect);

  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new RangeError(`brief.amount must be a non-negative finite number, got ${input.amount}`);
  }
  if (!RISK_TIERS.includes(input.riskTier)) {
    throw new RangeError(
      `brief.riskTier must be one of ${RISK_TIERS.join(", ")}, got ${JSON.stringify(input.riskTier)}`,
    );
  }
  if (input.surprise !== null && !Number.isFinite(input.surprise)) {
    throw new RangeError(`brief.surprise must be null or a finite number, got ${input.surprise}`);
  }
  if (!Array.isArray(input.ownTagIds)) {
    throw new RangeError(`brief.ownTagIds must be an array, got ${typeof input.ownTagIds}`);
  }
  input.ownTagIds.forEach((id, i) => requireNonBlank(`ownTagIds[${i}]`, id));

  // Each policy refused by its OWN package's predicate. One predicate cannot drift
  // from itself, and the brief is not the place to restate three other packages'
  // ranges.
  assertRetentionPolicy(input.policies.retention);
  assertPolicy(input.policies.tagging);
  assertCalibration(input.policies.calibration);
  assertBriefPolicy(input.policies.brief);

  // R27 and R44. Task 6 was to own this and cannot: without it a Task 5 brief with
  // `unit: "XLM"` grades a raw number against a USDC threshold. Refused rather than
  // coerced, because a coercion needs an exchange rate, which is a price feed and a
  // trust assumption this system does not have.
  const unit = requireNonBlank("unit", input.unit);
  if (unit !== input.policies.brief.thresholdUnit) {
    throw new RangeError(
      `brief.unit ${unit} is not the policy's thresholdUnit ${input.policies.brief.thresholdUnit}: ` +
        `the threshold is an amount in value units and converting one would need an exchange rate`,
    );
  }
}

/**
 * An instant as the audit body carries it, or null for a state.
 *
 * REFUSES AN INVALID DATE BY NAME. `toISOString()` throws a bare
 * "Invalid time value" with nothing in it to say which row, and this value comes
 * from the STORE rather than from the caller -- `readClear` returns whatever
 * `dated_at` holds. A brief that died with an unattributable RangeError halfway
 * through assembling its audit body would be a brief nobody could diagnose.
 */
function iso(field: string, at: Date | null): string | null {
  if (at === null) return null;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new RangeError(`brief.${field} from the store is not a valid instant: ${String(at)}`);
  }
  return at.toISOString();
}

/**
 * The brief, pure: no clock, no identifier, no write.
 *
 * THE ORDER OF THE READS IS A RULING, not an implementation detail. The intent's
 * clear row is read FIRST, because R14 refuses a brief on an erased namespace
 * "before any tag is read" and that cannot be seen from outside -- the test counts
 * the port's calls. The check sits on `readClear(observationId)` rather than on
 * `NamespaceRepository`: it has three reads, and the one that detects an erased
 * namespace, `dataKey`, UNWRAPS and hands key material to the engine on the happy
 * path, which is not what a liveness check should do.
 */
export async function brief(input: BriefInput, reads: BriefReads): Promise<BriefOutput> {
  assertInput(input);
  const { at, intent, policies } = input;
  const policy = policies.brief;

  // FIRST READ. R14.
  const intentClear = await reads.readClear(input.observationId);
  if (intentClear.namespaceErased) {
    throw new NamespaceErased(
      `brief refused: namespace ${intentClear.namespaceId} has been erased, so this ` +
        `counterparty's evidence cannot be read and a brief on it would be a brief on nothing`,
    );
  }
  // The caller hands the intent's namespace AND its observation. If the two
  // disagree, every tag is compared against a counterparty the intent is not about
  // and the answer is wrong in a way no output field shows.
  if (intentClear.namespaceId !== intent.namespaceId) {
    throw new RangeError(
      `brief.intent.namespaceId ${intent.namespaceId} is not the observation's namespace ` +
        `${intentClear.namespaceId}`,
    );
  }

  const own = new Set(input.ownTagIds);
  const live = await reads.listLive(intent.namespaceId);

  const counted: { tag: StoredTag; strength: number }[] = [];
  for (const t of live) {
    // BOTH FILTERS, and two review lenses converged on that independently.
    //
    // R41 ruled that the filter is on tag IDENTITY, because a refresh keeps the
    // OPENING observation's id, so a tag the intent refreshed survives an
    // observation-id filter and lowers the intent's own threshold. That ADDED a
    // filter; it did not retire R22's, and the plan's Task 5 acceptance still says
    // in bold "no reason's observation is the intent's own".
    //
    // The two are complementary rather than alternative: a tag the intent OPENED
    // carries the intent's `observation_id` and one it REFRESHED does not. On the
    // supported path `ownTagIds` covers both, and this changes nothing there. What
    // it closes is a caller that passes an incomplete list -- `assertInput` accepts
    // `[]` -- which reintroduced exactly the failure R22 exists to prevent. One
    // comparison against a value the core already holds is not a cost worth
    // declining.
    if (own.has(t.tagId) || t.observationId === input.observationId) continue;
    // R43. `strengthAt` returns `g0` for EVERY non-positive elapsed, so a tag
    // stamped after `at` reports full strength: a past brief counting it would be
    // reporting evidence that did not exist yet, at a strength it never had.
    // NECESSARY AND NOT SUFFICIENT (R42): a refreshed tag's earlier state is not
    // recoverable, because `refresh` overwrites it and keeps no history. So a
    // past-`at` brief is correct about what existed and approximate about its
    // strength, and both sentences are true of different things.
    if (t.taggedAt.getTime() > at.getTime()) continue;
    // NAMED, like the `dated_at` guard below. `strengthAt` refuses an invalid instant
    // with a bare "instant and taggedAt must be valid dates" that says nothing about
    // WHICH tag, and this value comes from the store rather than from the caller. Note
    // the exclusion above cannot catch it either: `NaN > x` is false, so an invalid
    // `taggedAt` walks straight past a comparison.
    if (Number.isNaN(t.taggedAt.getTime())) {
      throw new RangeError(
        `brief.reasons[${t.tagId}].taggedAt from the store is not a valid instant: ${String(t.taggedAt)}`,
      );
    }
    const strength = strengthAt(t, at, policies.calibration.halfLifeMs);
    // ONE PREDICATE FOR BOTH JOBS (R39): whatever fails this neither lowers the
    // threshold nor is citable, so a hold caused by a tag always has that tag among
    // its reasons and the only zero-reason hold is a hold on the amount alone.
    // `no-floor-outside-relatedness.test.ts` refuses any second comparison.
    if (!isReason({ ...t, strength }, intent, policy)) continue;
    counted.push({ tag: t, strength });
  }

  // DETERMINISTIC ORDER, and it is R1 rather than presentation. `listLive` orders
  // by `tagged_at desc`, and two tags stamped at one instant have no order at all,
  // so a brief that passed the store's order through would render a different body
  // on two runs over the same rows. Strength descending because that is the order a
  // reader wants, `tagId` ascending because a total order needs a tiebreak on
  // something unique and a tag id is.
  counted.sort((a, b) => b.strength - a.strength || (a.tag.tagId < b.tag.tagId ? -1 : 1));

  const reasons: Reason[] = [];
  for (const { tag, strength } of counted) {
    // One `readClear` per REASON and none per candidate. The latency measurement
    // that dissolved §7's cap question counted round trips, and a brief that opened
    // a row for every live tag would be paying for evidence it discards.
    const clear = await reads.readClear(tag.observationId);
    reasons.push({
      tagId: tag.tagId,
      observationId: tag.observationId,
      channel: tag.channel,
      aspect: tag.aspect,
      evidenceKind: clear.evidenceKind,
      datedAt: clear.datedAt,
      strength,
      relatedness: relatedness(intent, tag, policy),
      relatednessCase: relatednessCase(intent, tag),
      refreshCount: tag.refreshCount,
      // R13: KEPT and coded, never omitted. A reason dropped when its source stops
      // opening makes the brief's answer change as retention runs, with nothing
      // failing. R14 refuses on the INTENT's flag; a reason's flag is R13's
      // business, so an erased namespace here is a code and not a refusal.
      source:
        clear.periodExpired || clear.namespaceErased
          ? {
              code: "SOURCE_UNREADABLE",
              periodExpired: clear.periodExpired,
              namespaceErased: clear.namespaceErased,
            }
          : { code: "SOURCE_PRESENT" },
    });
  }

  // R4 and R44: multiplicative, once per reason. Multiplicative because the
  // threshold is an amount in value units and a subtraction would have to name a
  // currency while a factor does not.
  const base = policy.briefThreshold;
  const applied = base * Math.pow(policy.activeTagFactor, reasons.length);
  // THE LOWERED THRESHOLD CAN UNDERFLOW TO EXACTLY ZERO, and `gradeFor` refuses a
  // non-positive threshold. Found by measurement rather than by reading: timing the
  // real brief at 200 reasons showed a threshold of 2.5e-17, and following that to
  // its end gives the counts at which `base × factor^k` stops being a positive
  // double. At a base of 600: factor 0.8 underflows at 3340 reasons, 0.5 at 1075,
  // and 0.01 -- which `assertBriefPolicy` accepts -- at 162.
  //
  // 162 is reachable, and the consequence was the worst available one: **the
  // counterparty with the most evidence got no decision at all**, a RangeError out
  // of the grade arithmetic, which is not a grade and is not R7's unavailability
  // either.
  //
  // `hold` IS THE SAME RULE AT ITS LIMIT, not a new one. `gradeFor` holds when
  // `amount >= threshold`, and with a threshold of zero that is true of every
  // admissible amount including zero. So the grade moves clear -> watch -> hold as
  // reasons accumulate and never back, which is exactly the monotonicity `gradeFor`
  // promises -- and which a throw broke precisely at the boundary.
  //
  // FIXED HERE AND NOT IN `gradeFor`, deliberately. This is the one caller that
  // computed the number itself and therefore knows the case is an arithmetic limit
  // rather than a garbage input; `gradeFor`'s refusal is what protects it from a NaN
  // handed in by anyone else, and weakening it would trade a named defect for an
  // unnamed one. A test asserts that refusal still stands.
  //
  // The collapsed threshold is REPORTED as the zero it is, in the output and in the
  // audit body, rather than replaced by a substituted number -- which would be an
  // uncalibrated value R5 would have to declare.
  const grade =
    applied > 0
      ? gradeFor({ amount: input.amount, threshold: applied, reasonCount: reasons.length })
      : "hold";

  const trigger: RecordTriggerEvent | null =
    input.surprise === null
      ? null
      : {
          triggerId: input.triggerId,
          at,
          namespaceId: intent.namespaceId,
          observationId: input.observationId,
          status: "candidate",
          surprise: input.surprise,
        };

  const auditReasons: BriefAuditReason[] = reasons.map((r) => ({
    tagId: r.tagId,
    observationId: r.observationId,
    relatednessCase: r.relatednessCase,
    source: r.source.code,
    datedAt: iso(`reasons[${r.tagId}].datedAt`, r.datedAt),
    strength: r.strength,
    relatedness: r.relatedness,
  }));

  const body: BriefAuditBody = {
    briefId: input.briefId,
    // The id of the trigger this brief RECORDED, so a null here and a null trigger
    // are one fact rather than two that can disagree.
    triggerId: trigger === null ? null : trigger.triggerId,
    // `AuditChain.append` stamps its own `occurredAt` and a caller cannot supply
    // one, so the instant the brief was ABOUT has to travel in the body.
    at: at.toISOString(),
    namespaceId: intent.namespaceId,
    observationId: input.observationId,
    amount: input.amount,
    unit: input.unit,
    riskTier: input.riskTier,
    grade,
    threshold: { base, applied },
    reasons: auditReasons,
  };
  // Refused HERE and not at append time. `compositePolicyVersion` accepts an
  // interior newline, a NUL and a lone surrogate, all of which `canonicalForm` then
  // refuses three functions deep -- which is what `assertBriefPolicy`'s own
  // docstring says it exists to avoid.
  assertAuditBody(body);

  return {
    grade,
    reasons,
    threshold: { base, applied, loweredBy: reasons.map((r) => r.tagId) },
    effects: {
      trigger,
      audit: {
        policyVersion: compositePolicyVersion({
          retention: policies.retention.version,
          tagging: policies.tagging.version,
          calibration: policies.calibration.version,
          brief: policy.version,
        }),
        kind: "brief",
        body,
      },
    },
  };
}
