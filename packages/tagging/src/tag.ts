import { datedAt, type Channel, type Observation } from "@nonametrust/schema";
import { assertBaseline, emptyBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { assertCalibration, channelWeightWithSource, type Calibration, type WeightSource } from "./calibration.js";
import { calibrateG0, uncertaintyOf } from "./g0.js";
import { assertPolicy, requireNonNegative, requireUnitInterval, scaleFloorFor, type Policy } from "./policy.js";
import { readObservation, type Reading } from "./reading.js";
import { robustScale } from "./scale.js";
import { judgeSurprise, type SurpriseVerdict } from "./threshold.js";
import { timescaleDivergence } from "./timescales.js";

// This module is the composition. It takes values from every other module of
// the package and nothing takes anything from it, so it is the root of the
// graph and the graph stays acyclic. There is no try/catch here: a refusal
// raised below, by the surprise or by anything else, leaves this function as
// the refusal it is, and is never turned into the absence of a tag.

/**
 * The live tag on a (namespace, channel, aspect), as the caller holds it,
 * together with its strength at the instant of this call.
 *
 * The strength is an input and not something this package computes. The
 * decay curve shipped in M1 as strengthAt and lives in packages/store; a
 * tagging that called it would depend on store, and one that reimplemented
 * it would be the second definition of the same function. The caller has
 * the tag and the instant already, so it passes one number.
 */
export interface LiveTagInput {
  g0: number;
  taggedAt: Date;
  refreshCount: number;
  saturationState: "open" | "saturated";
  /** strengthAt(tag, at, halfLifeMs), computed by the caller at `at`. */
  decayedStrength: number;
}

export interface TagRefresh {
  g0: number;
  taggedAt: Date;
  refreshCount: number;
  saturationState: "open" | "saturated";
}

function requireStrength(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${value}`);
  }
}

function requireInstant(name: string, value: Date): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid date`);
}

// The two policy fields refreshTag reads are checked where they are read,
// by the predicates assertPolicy itself applies, so a refusal reads the
// same whether the pipeline's entry or the arithmetic notices. refreshTag
// is public and reachable without passing through the entry's check; a NaN
// increment would leave as a NaN strength, and a ceiling of zero would
// saturate every tag at nothing. The categorical base is read only below
// the entry's own assertPolicy and carries no second check: one was
// written, and the sweep showed it unreachable.
function requireRefreshFields(policy: Policy): { increment: number; ceiling: number } {
  return {
    increment: requireNonNegative("policy.refreshIncrement", policy.refreshIncrement),
    ceiling: requireUnitInterval("policy.g0Ceiling", policy.g0Ceiling, true),
  };
}

/**
 * A repeated deviation on an already-tagged pair refreshes rather than
 * stacks.
 *
 * The new strength is the maximum of the decayed current strength and the
 * fresh g0, plus a bounded increment that saturates at the ceiling. Not
 * the sum: a sum is the pump. Not the maximum over the stored g0: together
 * with the moved instant that would revive the tag to full at every repeat.
 *
 * The instant moves forward. If it did not, the new g0 would be discounted
 * by the whole elapsed time at the first read and the tag would collapse
 * rather than refresh. Because the clock resets, the clock is not what
 * stops an attacker; the maximum makes identical repeats idempotent and the
 * increment saturates. Forward only: an observation that arrives late, with
 * an instant behind the tag's, does not move the tag back.
 *
 * A saturated tag refreshes its instant and its count but not its g0. Said
 * with its consequence, so nobody discovers it later: a repeat on a
 * saturated tag brings it back to the ceiling with a fresh instant, however
 * far it had decayed. That is bounded, at the ceiling, and bounded is what
 * saturation means; the ceiling is the most a pair can ever be worth, and a
 * standing deviation that keeps recurring is worth exactly that.
 *
 * Bounded only if the g0 handed back is itself at or below the ceiling, and
 * that is refused rather than clamped when it is not. A saturated tag above
 * the ceiling was written under a policy whose ceiling was higher, and
 * clamping it would report a changed value under the version that did not
 * produce it. The cost, stated where whoever pays it will look: lowering the
 * ceiling in a later policy version requires migrating the saturated tags
 * above it, because this function refuses them until someone does. The
 * open path is not refused, since it reads the decayed strength and bounds
 * its result by the arithmetic above.
 *
 * The decayed strength is held at or below the live g0. No curve the caller
 * could honestly run produces more, so a larger one is a mismatched pair or
 * a bad computation, and it is refused rather than folded in.
 *
 * Whether the increment is added is one rule, and it is a ruling rather
 * than a reading of section 10: the increment is earned by a deviation
 * that crossed a threshold, not by an observation arriving. The caller
 * says whether this one crossed, and the composing function below is where
 * that is known. On a continuous channel the thing that crossed is the
 * surprise against the noise-adaptive threshold, and a refresh reached
 * that way earns the increment. On a categorical channel nothing crosses,
 * because nothing gates a categorical channel: no baseline, no threshold,
 * no minimum count. So a categorical refresh takes the maximum of the
 * decayed strength and the fresh g0, moves the instant and the count, and
 * adds nothing. The maximum is what stops a standing condition fading,
 * which is the defect M1's own refresh had while a condition still held;
 * the fresh g0 is what the deviation is worth today, the decayed strength
 * is what an earlier crossing earned, and the tag keeps the larger.
 *
 * This rule replaces an earlier one drawn on the wrong axis. The earlier
 * ruling took the increment off the state path and kept it on the event
 * path, on the reasoning that a state still holding tomorrow is one fact
 * and not one fact per morning, and that an increment on persistence would
 * let every standing condition climb from its channel weight to the
 * ceiling and sit in front of every future decision, which is a brief
 * nobody reads. The reasoning was right and the axis was wrong, because it
 * applies verbatim to a routine recurring event on an ungated channel:
 * fourteen ordinary daily memos on the content channel, every one an
 * event, climbed from 0.4982 through 0.7663 to the ceiling, after which
 * every later memo revived the saturated tag to full strength. What marks
 * a repeat worth crediting is that a gate said so, and event-versus-state
 * is not a gate. A state on a categorical channel crosses nothing, so the
 * state path behaves exactly as it did under the earlier ruling.
 *
 * A limit, stated here rather than discovered: no categorical tag is ever
 * raised past its weight times the categorical base by repetition, however
 * often the deviation recurs, until a later milestone gives categorical
 * channels a threshold. The specification has no rule for what makes a
 * categorical observation a deviation, and inventing one here would be
 * inventing a number with no source. Under this limit the day-twelve
 * address change and its revert are one tag at 0.6387 and not 0.6887.
 *
 * The argument is refused unless it is a boolean, because this function is
 * public and its fifth argument used to be the evidence kind: a caller
 * still passing "event" would otherwise be truthy and earn an increment
 * nothing gated.
 */
export function refreshTag(live: LiveTagInput, freshG0: number, instant: Date, policy: Policy, crossed: boolean): TagRefresh {
  if (typeof crossed !== "boolean") {
    throw new RangeError(`crossed must be true or false, got ${String(crossed)}`);
  }
  requireStrength("live tag g0", live.g0);
  requireStrength("decayed strength", live.decayedStrength);
  requireStrength("fresh g0", freshG0);
  requireInstant("live tag instant", live.taggedAt);
  requireInstant("instant", instant);
  if (!Number.isSafeInteger(live.refreshCount) || live.refreshCount < 0) {
    throw new RangeError(`refresh count must be a non-negative integer, got ${live.refreshCount}`);
  }
  if (live.decayedStrength > live.g0) {
    throw new RangeError(`decayed strength ${live.decayedStrength} exceeds the live tag g0 ${live.g0} it decays from`);
  }
  const { increment, ceiling } = requireRefreshFields(policy);

  const taggedAt = new Date(Math.max(live.taggedAt.getTime(), instant.getTime()));
  const refreshCount = live.refreshCount + 1;

  if (live.saturationState === "saturated") {
    if (live.g0 > ceiling) {
      throw new RangeError(
        `saturated tag g0 ${live.g0} lies above policy.g0Ceiling ${ceiling}; a tag saturated under a higher ceiling must be migrated before it is refreshed`,
      );
    }
    return { g0: live.g0, taggedAt, refreshCount, saturationState: "saturated" };
  }
  const held = Math.max(live.decayedStrength, freshG0);
  const raised = crossed ? held + increment : held;
  const g0 = Math.min(raised, ceiling);
  return {
    g0,
    taggedAt,
    refreshCount,
    saturationState: raised >= ceiling ? "saturated" : "open",
  };
}

/**
 * What produced a decision. The two versions are the milestone's constraint;
 * the weight's source is what makes naming the calibration version honest,
 * since latency and price take a policy number that the calibration never
 * produced while the version is named beside it all the same. The source is
 * set by calibration.ts, from the one predicate that also chooses the
 * number; nothing here decides it.
 */
export interface Provenance {
  policyVersion: string;
  calibrationVersion: string;
  weightSource: WeightSource;
}

export type TagDecision =
  | ({ kind: "new"; channel: Channel; aspect: string; g0: number; taggedAt: Date; surprise: number | null } & Provenance)
  | ({ kind: "refresh"; channel: Channel; aspect: string; g0: number; taggedAt: Date; refreshCount: number; saturationState: "open" | "saturated"; surprise: number | null } & Provenance);

// Not exported, and not by oversight. The reading is the aspect, and spec
// section 3 says the aspect is derived from the observation and never
// supplied by a caller. A public function taking this shape would let a
// caller pair any observation with any reading, and nothing below checks
// that the two belong together: a price observation handed a hand-built
// volume reading came back as a volume tag stamped with the price event's
// instant. The only way in is tagObservation, which derives the reading.
interface ReadingInput {
  namespaceId: string;
  observation: Observation;
  reading: Reading;
  /** The instant of this call. A state's tag is stamped here. */
  at: Date;
  /** The baseline for (namespaceId, reading.channel, reading.aspect), or null when none exists yet. */
  baseline: BaselineState | null;
  /** The live tag on the same pair, or null when none. */
  liveTag: LiveTagInput | null;
  policy: Policy;
  calibration: Calibration;
}

export interface ReadingResult {
  reading: Reading;
  /** The next baseline state; null for a categorical reading, which has none. */
  baseline: BaselineState | null;
  /** Null for a categorical reading. */
  verdict: SurpriseVerdict | null;
  /** Exposed and not acted on; null for a categorical reading. */
  timescaleDivergence: number | null;
  decision: TagDecision | null;
}

/**
 * The instant a tag opened or refreshed by this observation is stamped at.
 *
 * For a state, datedAt returns null and the call's instant stands in: a
 * standing condition has no instant of its own, and the tag's own taggedAt
 * is what carries it forward from here.
 *
 * For an event, the earlier of the event's own instant, through datedAt,
 * the single reader of a date off an observation, and the call's. An
 * observation cannot have happened after the moment we decided on it, so
 * when the event's instant is the later of the two it is not information:
 * it is clock skew on the producer, or a value the producer manufactured.
 * The instant is producer-supplied and therefore attacker-influenced, and
 * the tag's instant is what the decay curve reads; the store's curve
 * returns the full initial strength at any instant before taggedAt. Left
 * unbounded, an event stamped in 2099 and decided in 2026 opened a tag that
 * sat at full strength until 2099, and the forward-only rule in refreshTag
 * then pinned an existing tag there against every later observation.
 *
 * Clamped, not refused. A refusal would turn two seconds of skew on a
 * producer into a stopped pipeline, which is a worse failure than the one
 * being closed. Clamping loses nothing: the event's own instant stays on
 * the observation and in the store, the tag's instant governs decay only,
 * and a tag that decays from the moment we learned of the observation is
 * conservative and true. No new number is introduced; both operands were
 * already in hand. The call's instant is refused at the entry before
 * anything is read, so the minimum below is over two valid dates.
 */
function instantOf(o: Observation, at: Date): Date {
  const dated = datedAt(o);
  if (dated === null) return new Date(at.getTime());
  const instant = new Date(dated);
  requireInstant("event instant", instant);
  return new Date(Math.min(instant.getTime(), at.getTime()));
}

/**
 * The decision for one g0: a new tag when the pair has none, a refresh of
 * the live one otherwise. Either way the instant is the observation's own,
 * as instantOf gives it, and the refresh is told whether the observation
 * crossed a threshold, which is what decides whether the increment
 * applies. Only tagReading knows that, and it says so per path: the
 * verdict's own answer on a continuous channel, and false on a categorical
 * one, where there is no threshold to cross.
 *
 * A consequence worth stating. For an event that instant is the event's,
 * and the call's instant may be later: minutes on a synchronous path, days
 * on a backfill. It is never earlier, because instantOf clamps an event's
 * instant to the call's; the gap runs in one direction only. The decayed
 * strength the caller hands in was computed at the call's instant, so on a
 * refresh the maximum compares a strength decayed to the call's instant
 * against a fresh g0 stamped at the earlier one. The decayed operand is
 * under-credited by the gap and never over-credited. The fresh operand is
 * stamped at the event's instant only when that instant is at or after the
 * tag's; an event backfilled from behind the tag is stamped at the tag's
 * instant by the forward-only rule, later than its own, and that is the one
 * place a fresh strength is dated after its event. Held that way on
 * purpose: the alternative, decaying to the event's instant, would need
 * the curve this package does not have.
 *
 * The forward-only rule takes the maximum of the tag's instant and the
 * clamped one, so a live tag can only ever be moved to an instant at or
 * before the call's. What the rule cannot undo is a tag that already
 * carries a future instant, written before the clamp existed; none has
 * been, since no engine has written a tag from this package yet, and
 * refreshTag, which is public, trusts the instant it is handed the way it
 * trusts the live tag's own.
 */
function decide(input: ReadingInput, g0: number, surprise: number | null, weightSource: WeightSource, crossed: boolean): TagDecision {
  const { reading } = input;
  const instant = instantOf(input.observation, input.at);
  const provenance: Provenance = {
    policyVersion: input.policy.version,
    calibrationVersion: input.calibration.version,
    weightSource,
  };
  if (input.liveTag === null) {
    return { kind: "new", channel: reading.channel, aspect: reading.aspect, g0, taggedAt: instant, surprise, ...provenance };
  }
  const refreshed = refreshTag(input.liveTag, g0, instant, input.policy, crossed);
  return { kind: "refresh", channel: reading.channel, aspect: reading.aspect, ...refreshed, surprise, ...provenance };
}

/**
 * One reading, judged and folded in. This is the pure function the spec
 * describes: in, the reading, the baseline for its pair, the live tag with
 * its strength now, the policy and the calibration; out, the next baseline
 * and either no decision or a decision. Private, because the reading is an
 * argument here and the one caller that may build one is tagObservation
 * below; see ReadingInput.
 *
 * On a continuous channel the order is fixed and tag.test.ts holds it:
 * judge against the baseline as it stands, then clip and update. The
 * verdict is cold below the minimum count and produces nothing; the update
 * happens regardless, because a cold baseline is exactly the one that needs
 * the observation. The uncertainty g0 carries is the history before this
 * observation, like the verdict.
 *
 * The baseline handed in is held to the reading's own key before anything
 * reads it: namespace, channel and aspect all three. The channel matters
 * beyond bookkeeping, because the verdict takes the channel and the state
 * as two arguments and reads the fleet prior off the first, so a state of
 * one channel judged under another would be measured against the wrong
 * prior with nothing downstream able to notice. This is the one caller of
 * the verdict, and it is where the two are pinned equal.
 *
 * On a categorical channel there is no baseline, no surprise and no
 * threshold: the observation tags from day one at its channel weight times
 * the policy's categorical base, and a live tag on the pair is refreshed
 * in instant and count but never raised, because nothing crossed and the
 * increment is earned by a crossing. That is a stated limit and not a
 * property: a categorical deviation that genuinely recurs is worth no more
 * on its hundredth day than on its first, until a later milestone gives
 * categorical channels a threshold of their own. None is invented here;
 * the specification has no rule for what makes a categorical observation
 * a deviation. A baseline offered for a categorical reading is a key the
 * caller got wrong, and is refused rather than dropped.
 *
 * The schema does not couple the evidence kind to the channel, so a state
 * carrying a continuous payload is valid and takes the continuous path:
 * judged, folded into the baseline, and able to cross. Under the one rule
 * a crossing state earns the increment like any crossing, and the tag test
 * pins that consequence so nobody discovers it. No producer emits one
 * today, and whether a standing condition should enter a continuous
 * baseline at all is a schema question this milestone does not answer.
 *
 * The timescale divergence is computed on the next state and carried out.
 * Nothing below reads it into the decision; tag.test.ts holds that two
 * baselines differing only in their fast and slow pairs decide alike.
 */
function tagReading(input: ReadingInput): ReadingResult {
  const { reading, policy, calibration } = input;
  const { weight, source } = channelWeightWithSource(reading.channel, calibration, policy);

  if (reading.kind === "categorical") {
    if (input.baseline !== null) {
      throw new RangeError(
        `categorical reading ${reading.channel}/${reading.aspect} has no baseline, but one was given for ${input.baseline.channel}/${input.baseline.aspect}`,
      );
    }
    const g0 = weight * policy.categoricalBase;
    return { reading, baseline: null, verdict: null, timescaleDivergence: null, decision: decide(input, g0, null, source, false) };
  }

  if (input.baseline !== null) {
    assertBaseline(input.baseline);
    const b = input.baseline;
    if (b.namespaceId !== input.namespaceId || b.channel !== reading.channel || b.aspect !== reading.aspect) {
      throw new RangeError(
        `baseline ${b.namespaceId}/${b.channel}/${b.aspect} is not the baseline for ${input.namespaceId}/${reading.channel}/${reading.aspect}`,
      );
    }
  }
  const before = input.baseline ?? emptyBaseline(input.namespaceId, reading.channel, reading.aspect);
  const floor = scaleFloorFor(policy, reading.channel, reading.aspect);

  const verdict = judgeSurprise(reading.value, input.baseline, reading.channel, floor, policy);
  const next = updateBaseline(before, reading.value, robustScale(before, floor), policy);
  const divergence = timescaleDivergence(next, floor);

  let decision: TagDecision | null = null;
  if (verdict.kind === "measured" && verdict.crosses) {
    const g0 = calibrateG0(verdict.surprise, uncertaintyOf(before.count, policy), weight, policy);
    decision = decide(input, g0, verdict.surprise, source, verdict.crosses);
  }
  return { reading, baseline: next, verdict, timescaleDivergence: divergence, decision };
}

export interface AspectContext {
  baseline: BaselineState | null;
  liveTag: LiveTagInput | null;
}

export interface TaggingInput {
  namespaceId: string;
  observation: Observation;
  at: Date;
  /** Keyed by aspect. An aspect with no entry is one nobody has seen. */
  contexts: ReadonlyMap<string, AspectContext>;
  policy: Policy;
  calibration: Calibration;
}

export interface TaggingResult {
  readings: ReadingResult[];
  policyVersion: string;
  calibrationVersion: string;
}

const UNSEEN: AspectContext = { baseline: null, liveTag: null };

/**
 * An observation, read into its readings and each one tagged against its
 * own context. The caller supplies the contexts by aspect; it learns which
 * aspects to fetch from readObservation, which is the same derivation this
 * function runs, so the two cannot disagree about the key. A context keyed
 * under an aspect the observation does not read into is never looked at:
 * the readings come from the observation, and the contexts only answer for
 * them. That is what keeps the aspect out of a caller's hands.
 *
 * The policy, the calibration and the instant are refused here, once,
 * before anything is read; every reading below runs under that check.
 */
export function tagObservation(input: TaggingInput): TaggingResult {
  assertPolicy(input.policy);
  assertCalibration(input.calibration);
  requireInstant("at", input.at);
  const readings = readObservation(input.observation).map((reading) => {
    const context = input.contexts.get(reading.aspect) ?? UNSEEN;
    return tagReading({
      namespaceId: input.namespaceId,
      observation: input.observation,
      reading,
      at: input.at,
      baseline: context.baseline,
      liveTag: context.liveTag,
      policy: input.policy,
      calibration: input.calibration,
    });
  });
  return {
    readings,
    policyVersion: input.policy.version,
    calibrationVersion: input.calibration.version,
  };
}
