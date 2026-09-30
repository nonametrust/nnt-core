import { holdsAt, validateObservation, type Observation, type WireObservation } from "@nonametrust/schema";
import { readObservation, tagObservation, type AspectContext, type LiveTagInput } from "@nonametrust/tagging";
import { StoreError, strengthAt, type StoredTag } from "@nonametrust/store";
import { compose, type Composed } from "./compose.js";
import { retrying } from "./availability.js";
import { AuditEntryMissing } from "./run-brief.js";
import { compositePolicyVersion } from "./composite-version.js";
import type { BriefPolicies } from "./brief.js";
import type { Related } from "./relatedness.js";

/**
 * The observation the wire offered is not one the schema admits.
 *
 * Carries the schema's own reasons, because a producer has to be able to act on the
 * refusal and "invalid" is not actionable.
 *
 * **`errors` CARRY WIRE VALUES AND MUST NOT BE RECORDED.** An earlier version of this
 * docstring said they were "the validator's field messages, not a payload value". A
 * review measured otherwise: zod's enum messages carry `received '<value>'` — so a
 * `direction`, a `field`, a `namespace.kind` or a `schemaVersion` appears verbatim —
 * and a strict object's message carries the unknown KEY names, which on this wire can
 * be an address. R21 says a per-observation refusal is recorded as a CODE and an
 * observation id, never as the message, and these are messages.
 */
export class ValidationFailed extends Error {
  readonly code = "OBSERVATION_INVALID" as const;
  constructor(readonly errors: readonly string[]) {
    super(`observe: the observation is not valid: ${errors.join("; ")}`);
  }
}

/**
 * The envelope validated and the READING still could not be derived.
 *
 * **THIS CLASS EXISTS BECAUSE THE ARGUMENT IT REPLACES WAS FALSE.** The first version
 * of this module argued that validating first keeps tagging's value-carrying refusals
 * out of reach. Measured by a review: `decimalStringSchema` is
 * `/^(0|[1-9]\d*)(\.\d+)?$/` with **no length bound**, so a 309-digit `amount`
 * passes `validateObservation` and only then does tagging throw
 * `amount 999…999 does not fit a double` — the entire value in the message, as a bare
 * `RangeError` nothing named.
 *
 * And that is precisely the case Task 8's acceptance names: "a 308-digit amount is
 * recorded with its code and observation id … and the refusal's message text appears
 * nowhere in the audit body". So the one refusal the plan cares about is the one
 * validating first does not stop.
 *
 * The value stays on `cause`, for a human reading stderr. The CODE and the channel are
 * what anything recording this may use, which is R21's shape.
 */
export class UnreadableObservation extends Error {
  readonly code = "OBSERVATION_UNREADABLE" as const;
  constructor(
    readonly channel: string,
    options: ErrorOptions,
  ) {
    super(`observe: ${channel} passed the schema and its reading could not be derived`, options);
  }
}

/**
 * Whether this observation offers a reading a brief may be given, R46.
 *
 * A RETURNED CODE RATHER THAN A THROW, and that is the correction a review forced. R46
 * is about the INTENT being briefed — and the first version threw, on a function the
 * ingest path would call. Ingesting the two-reading form is M2's designed behaviour:
 * `tagObservation` tags both `hops` and `amount`, and `amount` is the dust signal
 * `cluster_proximity` carries a calibrated weight for. A throw here would have refused
 * every dust observation at the door and **deleted the channel's signal to enforce a
 * rule about briefs**.
 *
 * So the refusal is on the RETURN and never on the fold, which is also the shape R7
 * settled for unavailability: design §6 says error states are codes, not prose.
 */
export type IntentReading =
  | { readonly briefable: true; readonly reading: Related }
  | {
      readonly briefable: false;
      readonly code: "INTENT_HAS_MANY_READINGS";
      readonly aspects: readonly string[];
    };

/** What one wire observation offers the ingest path and the brief. */
export interface ObservationReadings {
  /** The validated observation, so a caller need not validate twice. */
  readonly validated: Observation & { idempotencyKey: string };
  /**
   * EVERY reading, for the fold. Ingest tags all of them; the count rule below
   * governs only what a brief may be handed.
   */
  readonly all: readonly Related[];
  readonly intent: IntentReading;
}

/**
 * The readings this observation derives, and which of them a brief may be given.
 *
 * **WHY THE READING IS DERIVED HERE AND NOT IN THE BRIEF (R40).** Relatedness needs
 * the intent's `(channel, aspect)`, and `readClear` returns the channel and NOT the
 * aspect — the aspect comes from the payload. Opening the payload inside the brief
 * means a brief cannot be replayed after the month expires, because `get` then raises
 * `PayloadExpired`; that would undermine R13, whose whole design is to keep a reason
 * whose source will not open.
 *
 * **R46 IS NARROWER THAN IT SAYS.** It reads "`cluster_proximity` yields TWO — `hops`
 * and `amount` — so a `cluster_proximity` intent cannot be briefed in M3". In
 * `reading.ts:159-173` `hops` is always produced and `amount` is pushed only
 * `if (p.amount !== undefined)`, and no other channel can produce two at all. So the
 * rule is on the COUNT and never on the channel name. This is not new knowledge: M2's
 * own `reading.test.ts:140` has held the one-reading form since it was written, and
 * R46 was ruled against a tested, documented property without reading it.
 *
 * **THE NAMESPACE ID IS THE CALLER'S AND IS NOT CROSS-CHECKED HERE.** A wrong one
 * yields a `Related` that scores zero against every real tag, which is R57's "wrong in
 * a way no output field shows" — and R57 is the gate: the brief refuses an
 * `intent.namespaceId` that is not its observation's. This function cannot make that
 * check, because the store's namespace id is not derivable from the wire without a
 * query. The ingest path takes it from `append`'s result rather than inventing one.
 */
export function readingsOf(wire: WireObservation, namespaceId: string): ObservationReadings {
  if (typeof namespaceId !== "string") {
    throw new RangeError(`observe.namespaceId must be a string, got ${typeof namespaceId}`);
  }
  if (namespaceId.trim().length === 0) {
    throw new RangeError(`observe.namespaceId must not be blank`);
  }
  // REFUSED RATHER THAN TRIMMED, for the reason `thresholdUnit` is: the value returned
  // here is what R57 compares against the observation's namespace by string equality,
  // so trimming on the way through would decide that comparison silently. A review
  // measured that a `.trim()` added here survived every row.
  if (namespaceId !== namespaceId.trim()) {
    throw new RangeError(
      `observe.namespaceId must not be padded, got ${JSON.stringify(namespaceId)}`,
    );
  }
  const validated = validateObservation(wire);
  if (!validated.ok) throw new ValidationFailed(validated.errors);

  // Tagging's refusals carry observed VALUES, and a validated envelope does not stop
  // them — see `UnreadableObservation`. Wrapped here so nothing downstream has to
  // decide whether a bare `RangeError` is safe to record.
  let readings;
  try {
    readings = readObservation(validated.value);
  } catch (cause) {
    throw new UnreadableObservation(validated.value.channel, { cause });
  }

  const all: Related[] = readings.map((r) => ({
    namespaceId,
    channel: r.channel,
    aspect: r.aspect,
  }));
  const intent: IntentReading =
    all.length === 1
      ? { briefable: true, reading: all[0]! }
      : {
          briefable: false,
          code: "INTENT_HAS_MANY_READINGS",
          aspects: all.map((r) => r.aspect),
        };
  return { validated: validated.value, all, intent };
}

/**
 * A per-observation refusal, R21: a CODE and an observation id, never the message.
 *
 * The observation is appended BEFORE its payload is read, which is what gives this an
 * id to carry — `append` parses the envelope only (`observationSchema`), so a payload
 * tagging cannot read reaches tagging and its `RangeError` names the whole value. R21
 * says the code goes in and the message does not, and an audit body outlives both the
 * month key and the namespace key.
 *
 * The underlying failure stays on `cause`, for a human reading stderr.
 */
export class RefusedObservation extends Error {
  constructor(
    readonly code: string,
    /**
     * `null` when the refusal happened BEFORE the row existed — an envelope zod
     * rejects. R21 asks for a code and an observation id; when there is no id the
     * honest answer is no id, never the message.
     */
    readonly observationId: string | null,
    options: ErrorOptions,
  ) {
    super(
      observationId === null
        ? `observe: an observation was refused as ${code} before it was stored`
        : `observe: ${observationId} refused as ${code}`,
      options,
    );
  }
}

/** What one ingested observation leaves behind, and what a brief needs from it. */
export interface ObserveResult {
  readonly observationId: string;
  /** False on a re-delivery: `append` had seen this idempotency key before. */
  readonly created: boolean;
  /** R23: a re-delivery folds NOTHING, and says so. */
  readonly folded: boolean;
  /**
   * Whether the stored observation's payload can still be opened. False only on the
   * third `append` arm: a re-delivery whose month expired or whose namespace was
   * erased. R13's business on the brief side; named here so a caller is not left to
   * infer it.
   */
  readonly readable: boolean;
  readonly periodExpired: boolean;
  readonly namespaceErased: boolean;
  /** R40/R46: the reading a brief may be handed, or why there is none. */
  readonly intent: IntentReading;
  /** R41: the tags this observation opened OR refreshed. */
  readonly ownTagIds: readonly string[];
  /** R18/R29: null for a categorical reading and for a cold baseline. */
  readonly surprise: number | null;
}

/**
 * Ingest one observation: append it, fold it, tag it, and record it.
 *
 * **THE ORDER IS FORCED BY THE STORE AND BY R21.** `append` refuses to run inside a
 * transaction and `AuditChain.append` refuses one too, so R10's unit of work is exactly
 * the fold and the tag write, with the append before it and the chain entry after. And
 * the payload cannot be read before the append even if one wanted to: R21 records a
 * refusal against an OBSERVATION ID, which does not exist until the row does.
 *
 * **R10: ONE TRANSACTION, AND THE RETRY RE-RUNS ALL OF IT.** This ruling replaced a
 * wrong one and carries its measurement: "baseline first, then tag, and the retry
 * re-reads both" does not avoid the double fold, it CREATES a committed fold with no
 * tag, and the retry folds again because `tagReading` always computes the next baseline
 * from the one it was given — which already holds the first fold. Measured with the
 * real repositories: one writer retried once left `count = 12` for 11 observations,
 * with the mean moved. So the reads are INSIDE the transaction and the retry re-runs
 * them.
 *
 * **R24: the chain entry is written after the commit**, and a missing one is a named
 * inconsistency rather than a rollback — the chain's job is to record what happened,
 * not to be the transaction log.
 */
export async function observe(
  composed: Composed,
  wire: WireObservation,
  policies: BriefPolicies,
): Promise<ObserveResult> {
  const at = composed.clock.now();

  // OUTSIDE the transaction, because `append` refuses one. A new observation for an
  // erased namespace is refused here, by name, by the store's own gate.
  //
  // R21 EVEN HERE, WHERE THERE IS NO ID YET. `append` runs `observationSchema.parse`,
  // and a zod refusal carries wire content in its message -- a review measured an
  // unknown key shaped like a Stellar address arriving verbatim. No observation id
  // exists to name it by, which is a reason to omit the id and NOT a reason to let the
  // message escape unwrapped.
  let appended;
  try {
    appended = await composed.observations.append(wire);
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw new RefusedObservation("OBSERVATION_INVALID", null, { cause });
  }
  const observationId =
    appended.created || appended.readable ? appended.observation.observationId : appended.observationId;

  // THE NAMESPACE ID IS THE STORE'S, and it is not on the append result: a
  // `StoredObservation` carries `namespace: {kind, id}` — the wire's names — and the
  // internal id lives on the namespace row `append` ensured. R57 compares the reading's
  // namespace against the observation's by that id, so taking it from anywhere else
  // would compare two different things.
  const stored = await composed.namespaces.find(wire.namespace.kind, wire.namespace.id);
  if (stored === null) {
    throw new Error(`observe: ${observationId} was appended and its namespace is not there`);
  }
  const namespaceId = stored.namespaceId;

  let readings;
  try {
    readings = readingsOf(wire, namespaceId);
  } catch (cause) {
    // R21: the code and the id, never the message. The observation row exists, which is
    // what makes the id available to name it by.
    const code = (cause as { code?: string }).code ?? "OBSERVATION_UNREADABLE";
    throw new RefusedObservation(code, observationId, { cause });
  }

  // R23: a re-delivery folds NOTHING. `append` answers `{created:false}` on a repeat,
  // and nothing records which observations a baseline has absorbed, so folding again
  // would double-count. The cost is stated rather than hidden: a crash between a
  // successful append and its fold loses that contribution permanently, and nothing
  // detects it. Closing that needs a fold ledger, which is M4's.
  if (!appended.created) {
    // THREE ARMS, NOT TWO. An earlier comment here said "`append` answers
    // `{created:false}` on a repeat", which collapses the third arm into the second: a
    // re-delivery whose namespace was erased or whose month expired answers
    // `{created:false, readable:false}` with its own flags, and was returned as an
    // ordinary re-delivery with a briefable reading and nothing saying otherwise.
    //
    // The reading is still derivable -- it comes from the wire, which is in hand -- so
    // it is still returned. What changes is that the result SAYS the source will not
    // open, and a caller is not left to infer it from silence. R14 refuses a brief on
    // an erased namespace, and this is the ingest-side half of the same fact.
    const readable = appended.readable;
    return {
      observationId,
      created: false,
      folded: false,
      readable,
      periodExpired: readable ? false : appended.periodExpired,
      namespaceErased: readable ? false : appended.namespaceErased,
      intent: readings.intent,
      ownTagIds: [],
      surprise: null,
    };
  }

  const observation = { ...readings.validated, observationId } as Observation;

  // A STATE WHOSE VALIDITY HAS PASSED OPENS NO TAG. `holdsAt` is the single exempt
  // date reader, and an event always holds.
  const holds = holdsAt(observation, at);

  const folded = await retrying(
    async () =>
      // R10's unit of work. Every read is inside, so the retry re-runs them.
      composed.handle.transaction().execute(async (trx) => {
        const inner = compose(trx, composed.clock, composed.ring, composed.retention);
        const baselines = await inner.baselines.forNamespace(namespaceId);
        const contexts = new Map<string, AspectContext>();
        const liveByAspect = new Map<string, StoredTag>();

        for (const reading of readings.all) {
          const baseline =
            baselines.find((b) => b.channel === reading.channel && b.aspect === reading.aspect) ?? null;
          const live = await inner.tags.findLive(namespaceId, reading.channel, reading.aspect);
          if (live !== null) liveByAspect.set(reading.aspect, live);
          const liveTag: LiveTagInput | null =
            live === null
              ? null
              : {
                  g0: live.g0,
                  taggedAt: live.taggedAt,
                  refreshCount: live.refreshCount,
                  saturationState: live.saturationState,
                  decayedStrength: strengthAt(live, at, policies.calibration.halfLifeMs),
                };
          contexts.set(reading.aspect, { baseline, liveTag });
        }

        const tagged = tagObservation({
          namespaceId,
          observation,
          at,
          contexts,
          policy: policies.tagging,
          calibration: policies.calibration,
        });

        const ownTagIds: string[] = [];
        let surprise: number | null = null;

        for (const result of tagged.readings) {
          if (result.baseline !== null) {
            const before = contexts.get(result.reading.aspect)?.baseline ?? null;
            await inner.baselines.upsert(result.baseline, before === null ? null : before.count);
          }
          if (result.verdict !== null && result.verdict.kind === "measured") {
            surprise = result.verdict.surprise;
          }
          // A state past its validity opens no tag, and a refresh of one is likewise
          // not this observation's to make.
          if (result.decision === null || !holds) continue;

          if (result.decision.kind === "new") {
            const opened = await inner.tags.open({
              namespaceId,
              observationId,
              channel: result.decision.channel,
              aspect: result.decision.aspect,
              g0: result.decision.g0,
              taggedAt: result.decision.taggedAt,
            });
            ownTagIds.push(opened.tagId);
          } else {
            const live = liveByAspect.get(result.decision.aspect)!;
            await inner.tags.refresh(live.tagId, {
              g0: result.decision.g0,
              taggedAt: result.decision.taggedAt,
              refreshCount: result.decision.refreshCount,
              saturationState: result.decision.saturationState,
            });
            ownTagIds.push(live.tagId);
          }
        }
        return { ownTagIds, surprise };
      }),
    { maxRetries: policies.brief.maxRetries, label: "observe", subject: observationId },
  );

  // R24: AFTER the commit, because `AuditChain.append` refuses a transaction — and
  // RETRIED under R28, then NAMED, never rolled back. The fold and the tag are already
  // committed; rolling them back to keep the chain tidy would make the chain the
  // transaction log, which is exactly what R24 says it is not. So an exhausted append
  // leaves a fold with no entry, says so by name, and writes the condition to
  // structured stderr — the chain cannot record its own absence.
  const entry = {
    policyVersion: compositePolicyVersion({
      retention: policies.retention.version,
      tagging: policies.tagging.version,
      calibration: policies.calibration.version,
      brief: policies.brief.version,
    }),
    kind: "observe",
    // R25: IDS, CODES, VERSIONS AND INSTANTS. An earlier version carried `aspects`,
    // and a review measured what that costs: an aspect is templated from the payload
    // (`amount/${assetCode}/${direction}`, `event/${p.event}`, `quoted/${p.unit}`) and
    // the schema bounds none of those strings, so a 56-character address-shaped
    // `assetCode` reached the chain's canonical form verbatim. The row is hash-chained
    // and outlives every key, which is the one place a payload field must never go.
    //
    // The aspects are recoverable from the tag rows the ids name, for as long as those
    // rows exist -- which is the right lifetime for them and not the chain's.
    body: {
      observationId,
      namespaceId,
      at: at.toISOString(),
      readings: readings.all.length,
      tagIds: folded.ownTagIds,
    },
  };
  try {
    await retrying(async () => composed.audit.append(entry), {
      maxRetries: policies.brief.maxRetries,
      label: "observe.audit",
      subject: observationId,
    });
  } catch (cause) {
    // A CODE AND IDS ONLY, R21: whatever failed may carry an observed value, and a line
    // on stderr is as durable as whatever collects it.
    process.stderr.write(
      `${JSON.stringify({
        event: "engine.observe.audit_entry_missing",
        at: at.toISOString(),
        code: "AUDIT_ENTRY_MISSING",
        observationId,
        namespaceId,
        tagIds: folded.ownTagIds,
      })}\n`,
    );
    throw new AuditEntryMissing(
      `observe ${observationId} folded and tagged, and its chain entry did not land: ` +
        `the writes are committed and are NOT rolled back, so this is a named ` +
        `inconsistency rather than a failure that undid itself`,
      { cause },
    );
  }

  return {
    observationId,
    created: true,
    folded: true,
    readable: true,
    periodExpired: false,
    namespaceErased: false,
    intent: readings.intent,
    ownTagIds: folded.ownTagIds,
    surprise: folded.surprise,
  };
}

