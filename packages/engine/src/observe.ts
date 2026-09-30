import { validateObservation, type Observation, type WireObservation } from "@nonametrust/schema";
import { readObservation } from "@nonametrust/tagging";
import type { Related } from "./relatedness.js";

/**
 * The observation the wire offered is not one the schema admits.
 *
 * Carries the schema's own reasons rather than a summary, because a producer has to
 * be able to act on the refusal and "invalid" is not actionable. The reasons are the
 * validator's field messages, not a payload value — `validateObservation` refuses the
 * ENVELOPE, and the payload's own refusals happen later in tagging, where R21 governs
 * what may be recorded.
 */
export class ValidationFailed extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`observe: the observation is not valid: ${errors.join("; ")}`);
  }
}

/**
 * The observation derived more than one reading, R46.
 *
 * R40 hands the brief "the intent's derived reading", singular, and
 * `readObservation` returns an array — so one of the two has to give. Choosing
 * between two readings would invent a rule nobody has measured: which of them is
 * "the" intent for relatedness, and which surprise goes on the candidate trigger.
 * Refusing is honest, is one line, and leaves M4 the ruling with a population to
 * measure it against.
 */
export class MultipleReadings extends Error {
  constructor(
    readonly channel: string,
    readonly aspects: readonly string[],
  ) {
    super(
      `observe: ${channel} derived ${aspects.length} readings (${aspects.join(", ")}) and M3 ` +
        `briefs one: choosing between them would decide which reading is the intent's, ` +
        `which nobody has measured`,
    );
  }
}

/**
 * The reading a brief is handed for this observation, R40.
 *
 * **WHY IT IS DERIVED HERE AND NOT IN THE BRIEF.** Relatedness needs the intent's
 * `(channel, aspect)`, and `readClear` returns the channel and NOT the aspect — the
 * aspect comes from the payload. Opening the payload inside the brief means a brief
 * cannot be replayed after the month expires, because `get` then raises
 * `PayloadExpired`; that would undermine R13, whose whole design is to keep a reason
 * whose source will not open. So the reading is derived once, here, and carried.
 *
 * **R46 IS NARROWER THAN IT SAYS, and this is measured rather than taken on trust.**
 * R46 reads "`cluster_proximity` yields TWO — `hops` and `amount` — so a
 * `cluster_proximity` intent cannot be briefed in M3". In `reading.ts:159-173` `hops`
 * is always produced and `amount` is pushed only `if (p.amount !== undefined)`, and no
 * other channel can produce two at all. So the refusal is on the COUNT and never on
 * the channel name: a `cluster_proximity` observation with no amount derives one
 * reading and is as briefable as any other. R46's outward-facing sentence is true of
 * the two-reading form only, and the README should say so.
 *
 * The schema validates FIRST. Tagging's own refusals carry observed values —
 * `surpriseOf`'s `RangeError` names the deviation and the scale — and R21 keeps those
 * out of anything recorded, so the cheapest way to honour it is not to reach them with
 * an observation the envelope already refuses.
 */
export function readingOf(wire: WireObservation, namespaceId: string): Related {
  if (typeof namespaceId !== "string" || namespaceId.trim().length === 0) {
    throw new RangeError(`observe.namespaceId must not be blank`);
  }
  const validated = validateObservation(wire);
  if (!validated.ok) throw new ValidationFailed(validated.errors);

  const readings = readObservation(validated.value as Observation);
  if (readings.length !== 1) {
    throw new MultipleReadings(
      validated.value.channel,
      readings.map((r) => r.aspect),
    );
  }
  const only = readings[0]!;
  return { namespaceId, channel: only.channel, aspect: only.aspect };
}
