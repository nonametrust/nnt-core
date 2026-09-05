import type { Observation } from "./observation.js";

/**
 * The only place in the system permitted to read a date off an observation for
 * a timing computation. States return null, so no distance, window or decay
 * calculation can silently credit a standing condition as a dated hit.
 */
export function datedAt(o: Observation): string | null {
  return o.evidenceKind === "event" ? o.observedAt : null;
}
