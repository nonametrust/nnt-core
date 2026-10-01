import type { Observation } from "./observation.js";

/**
 * The only place in the system permitted to read a date off an observation for
 * a timing computation. States return null, so no distance, window or decay
 * calculation can silently credit a standing condition as a dated hit.
 */
export function datedAt(o: Observation): string | null {
  return o.evidenceKind === "event" ? o.observedAt : null;
}

/**
 * Whether this observation's evidence holds at `at`.
 *
 * WHY IT IS IN THIS FILE (R16). The M2 ledger tells M3's engine to check that a
 * state still holds before it opens or refreshes a tag, and
 * `gates/single-date-reader.test.ts` refuses any line naming `validFrom` or
 * `validUntil` outside this module. The first version of M3's plan put the check
 * in the engine and gave the gate a new exemption; the alternative it had
 * rejected is better by the gate's own design. This module is already the single
 * exempt date reader and it held no interval, so `holdsAt` beside `datedAt` is
 * not "the interval in two places" -- it is the designated place. Exempting a
 * file in the one package that imports both the store and tagging would also
 * have forced a change to the gate's own sentence, that a new package enters
 * under it on the day it is created with no exemption.
 *
 * WITHOUT IT: a state whose validity ended keeps opening and refreshing tags
 * forever, because `datedAt` returns null for a state and exposes nothing about
 * its interval.
 *
 * THE INTERVAL IS CLOSED AT BOTH ENDS. A state valid from noon until midnight
 * holds AT noon and AT midnight. Half-open would be equally defensible; what
 * would not be defensible is leaving it to be inferred, because a caller
 * comparing instants a millisecond apart has to be able to read the rule rather
 * than reconstruct it. A zero-length interval, `validUntil === validFrom`, is
 * admissible -- the schema refuses only a `validUntil` BEFORE `validFrom` -- and
 * under this rule it holds at exactly that one instant.
 *
 * BOTH BOUNDS, not only the upper one. M3's plan names only `validUntil`; a state
 * that begins tomorrow does not hold today either, and an engine checking one end
 * would open a tag from evidence that has not started.
 *
 * AN EVENT ALWAYS HOLDS, and that is a choice rather than an omission. An event
 * has no interval to fall outside of, and the caller's question is "may this
 * evidence open or refresh a tag" -- for an event the answer is always yes,
 * because its currency is the half-life's business, which belongs to
 * `@nonametrust/tagging` and never to this function. A three-valued answer like
 * `datedAt`'s was rejected: every caller would have to collapse it to a boolean,
 * and the collapse is where the mistake would live.
 *
 * An unparseable instant on either side is REFUSED rather than reported as "does
 * not hold". `NaN` fails every comparison, so a silent `false` would say a state
 * has expired when nothing of the kind was measured -- a wrong answer dressed as
 * a decision. `strengthAt` in the store refuses an invalid instant for the same
 * reason.
 */
export function holdsAt(o: Observation, at: Date): boolean {
  const instant = at.getTime();
  if (Number.isNaN(instant)) {
    throw new RangeError(`holdsAt was given an invalid instant: ${String(at)}`);
  }
  if (o.evidenceKind === "event") return true;
  const from = Date.parse(o.validFrom);
  if (Number.isNaN(from)) {
    throw new RangeError(`validFrom ${o.validFrom} is not a parseable instant`);
  }
  if (instant < from) return false;
  if (o.validUntil === null) return true;
  const until = Date.parse(o.validUntil);
  if (Number.isNaN(until)) {
    throw new RangeError(`validUntil ${o.validUntil} is not a parseable instant`);
  }
  return instant <= until;
}
