import { datedAt, type Channel, type Observation } from "@nonametrust/schema";
import { assertBaseline, emptyBaseline, updateBaseline, type BaselineState } from "./baseline.js";
import { assertCalibration, channelWeightWithSource, type Calibration, type WeightSource } from "./calibration.js";
import { calibrateG0, uncertaintyOf } from "./g0.js";
import { assertPolicy, scaleFloorFor, type Policy } from "./policy.js";
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
// under the wording assertPolicy gives them, so a refusal reads the same
// whether the pipeline's entry or the arithmetic notices. refreshTag is
// public and reachable without passing through tagReading's entry check; a
// NaN increment would leave as a NaN strength, and a ceiling of zero would
// saturate every tag at nothing. The categorical base is read only below
// tagReading's own assertPolicy and carries no second check: one was
// written, and the sweep showed it unreachable.
function requireRefreshFields(policy: Policy): { increment: number; ceiling: number } {
  const increment = policy.refreshIncrement;
  if (!(increment >= 0) || !Number.isFinite(increment)) {
    throw new RangeError(`policy.refreshIncrement must be a non-negative finite number, got ${increment}`);
  }
  const ceiling = policy.g0Ceiling;
  if (!(ceiling > 0 && ceiling <= 1)) {
    throw new RangeError(`policy.g0Ceiling must lie in (0, 1], got ${ceiling}`);
  }
  return { increment, ceiling };
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
 */
export function refreshTag(live: LiveTagInput, freshG0: number, instant: Date, policy: Policy): TagRefresh {
  requireStrength("live tag g0", live.g0);
  requireStrength("decayed strength", live.decayedStrength);
  requireStrength("fresh g0", freshG0);
  requireInstant("live tag instant", live.taggedAt);
  requireInstant("instant", instant);
  if (!Number.isSafeInteger(live.refreshCount) || live.refreshCount < 0) {
    throw new RangeError(`refresh count must be a non-negative integer, got ${live.refreshCount}`);
  }
  const { increment, ceiling } = requireRefreshFields(policy);

  const taggedAt = new Date(Math.max(live.taggedAt.getTime(), instant.getTime()));
  const refreshCount = live.refreshCount + 1;

  if (live.saturationState === "saturated") {
    return { g0: live.g0, taggedAt, refreshCount, saturationState: "saturated" };
  }
  const raised = Math.max(live.decayedStrength, freshG0) + increment;
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
interface Provenance {
  policyVersion: string;
  calibrationVersion: string;
  weightSource: WeightSource;
}

export type TagDecision =
  | ({ kind: "new"; channel: Channel; aspect: string; g0: number; taggedAt: Date; surprise: number | null } & Provenance)
  | ({ kind: "refresh"; channel: Channel; aspect: string; g0: number; taggedAt: Date; refreshCount: number; saturationState: "open" | "saturated"; surprise: number | null } & Provenance);

export interface ReadingInput {
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
 * The instant a tag opened by this observation is stamped at. An event's
 * own instant, through datedAt, the single reader of a date off an
 * observation; for a state datedAt returns null and the call's instant
 * stands in, since a standing condition has no instant of its own and the
 * tag's own taggedAt is what carries it forward from here.
 */
function instantOf(o: Observation, at: Date): Date {
  const dated = datedAt(o);
  if (dated === null) return new Date(at.getTime());
  const instant = new Date(dated);
  requireInstant("event instant", instant);
  return instant;
}

/**
 * The decision for one g0: a new tag when the pair has none, a refresh of
 * the live one otherwise. Either way the instant is the observation's own,
 * as instantOf gives it.
 *
 * A consequence worth stating. For an event that instant is the event's,
 * and the call's instant may be later: minutes on a synchronous path, days
 * on a backfill. The decayed strength the caller hands in was computed at
 * the call's instant, so on a refresh the maximum compares a strength
 * decayed to the call's instant against a fresh g0 stamped at the earlier
 * one. That under-credits the standing tag by the gap and never over-credits
 * it, and it is held that way on purpose: the alternative, decaying to the
 * event's instant, would need the curve this package does not have.
 */
function decide(input: ReadingInput, g0: number, surprise: number | null, weightSource: WeightSource): TagDecision {
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
  const refreshed = refreshTag(input.liveTag, g0, instant, input.policy);
  return { kind: "refresh", channel: reading.channel, aspect: reading.aspect, ...refreshed, surprise, ...provenance };
}

/**
 * One reading, judged and folded in. This is the pure function the spec
 * describes: in, the reading, the baseline for its pair, the live tag with
 * its strength now, the policy and the calibration; out, the next baseline
 * and either no decision or a decision.
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
 * the policy's categorical base, and a live tag on the pair is refreshed.
 * A baseline offered for a categorical reading is a key the caller got
 * wrong, and is refused rather than dropped.
 *
 * The timescale divergence is computed on the next state and carried out.
 * Nothing below reads it into the decision; tag.test.ts holds that two
 * baselines differing only in their fast and slow pairs decide alike.
 */
export function tagReading(input: ReadingInput): ReadingResult {
  assertPolicy(input.policy);
  assertCalibration(input.calibration);
  requireInstant("at", input.at);
  const { reading, policy, calibration } = input;
  const { weight, source } = channelWeightWithSource(reading.channel, calibration, policy);

  if (reading.kind === "categorical") {
    if (input.baseline !== null) {
      throw new RangeError(
        `categorical reading ${reading.channel}/${reading.aspect} has no baseline, but one was given for ${input.baseline.channel}/${input.baseline.aspect}`,
      );
    }
    const g0 = weight * policy.categoricalBase;
    return { reading, baseline: null, verdict: null, timescaleDivergence: null, decision: decide(input, g0, null, source) };
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
    decision = decide(input, g0, verdict.surprise, source);
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
 * function runs, so the two cannot disagree about the key.
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
