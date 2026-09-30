import { validateObservation, type Observation, type WireObservation } from "@nonametrust/schema";
import { readObservation } from "@nonametrust/tagging";
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
