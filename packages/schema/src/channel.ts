import { z } from "zod";

/**
 * The seven channels an observation may bear on.
 *
 * Five come from the developer brief: address integrity, latency, price,
 * protocol, volume. Two were added when the frozen study catalog was mapped
 * onto them and did not fit. The dust channel is graph proximity to an
 * operation cluster rather than a counterparty aspect, and it is what the
 * fleet consolidation of whitepaper section 5.1 attaches to. The memo channel
 * is free-text content rather than a protocol event.
 */
export const CHANNELS = [
  "address_integrity",
  "latency",
  "price",
  "protocol",
  "volume",
  "cluster_proximity",
  "content",
] as const;

export type Channel = (typeof CHANNELS)[number];
export const channelSchema = z.enum(CHANNELS);

/**
 * An event happened at an instant. A state holds over an interval. The
 * distinction exists because the study's S3 signal is a standing condition
 * that was credited to every window including the seven-day one, while
 * controls could not measure it at all, which inflated the headline in one
 * direction by three points.
 *
 * What is enforced: a state never enters a timing computation. `datedAt` in
 * `./timing.ts` is the single reader of a date off an observation and returns
 * null for a state; `timing.test.ts` is the gate. The shape itself, an
 * instant with no interval or an interval with no instant, is gated by
 * `observation.test.ts`.
 *
 * Not yet enforced: that an event decays from its instant, and that a state
 * is refreshed while it holds. Both belong to a later milestone and nothing
 * in this package implements them.
 */
export const EVIDENCE_KINDS = ["event", "state"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
