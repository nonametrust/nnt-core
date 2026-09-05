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
 * An event happened at an instant and decays from it. A state holds over an
 * interval, is refreshed while it holds, and never enters a timing
 * computation. The distinction exists because the study's S3 signal is a
 * standing condition that was credited to every window including the
 * seven-day one, while controls could not measure it at all, which inflated
 * the headline in one direction by three points.
 */
export const EVIDENCE_KINDS = ["event", "state"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
