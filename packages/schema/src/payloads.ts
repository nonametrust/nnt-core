import { z } from "zod";
import { type Channel } from "./channel.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  observationSchema,
  type Observation,
} from "./observation.js";
import { deriveIdempotencyKey } from "./idempotency.js";

/**
 * Amounts and prices travel as decimal strings, never as numbers, because a
 * JSON number is a double and Stellar amounts carry seven decimals. The
 * pattern admits what Horizon emits ("0.0000100", "500") and nothing else: no
 * sign, no exponent, no locale separator. Direction carries the sign.
 */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, {
  message: "must be a non-negative decimal string such as \"12.5\"",
});

// Every payload object is strict, like every other object in this package. An
// unknown key is rejected rather than stripped, because a stripped key tells
// the indexer a field is flowing when it is not. Gated in payloads.test.ts.

/**
 * A counterparty's payment address moved. `previous` is required: a change
 * with no previous address is a first sighting, not a change, and belongs to
 * a different kind. `reverted` marks the day-twelve scenario, a change that
 * went back. `muxedId` is the muxed identifier when the address was muxed;
 * the namespace itself always holds the base address.
 */
const addressIntegrity = z.object({
  previous: z.string().min(1),
  current: z.string().min(1),
  reverted: z.boolean().optional(),
  muxedId: z.string().optional(),
}).strict();

/** How long the counterparty took to respond, in whole or fractional ms. */
const latency = z.object({ latencyMs: z.number().nonnegative() }).strict();

/**
 * What the counterparty asked for. `quoted` is the decimal amount, `unit` is
 * its denomination, for example "USDC". What the amount buys is the `kind` of
 * the observation, for example "price_quoted" for one x402 request.
 */
const price = z.object({ quoted: decimalString, unit: z.string().min(1) }).strict();

/**
 * A protocol-level fact about the counterparty: a trustline, an asset it
 * accepts, an account flag. `event` names the fact. When the fact concerns an
 * asset, `assetCode` and `assetIssuer` identify it and `issuerKnown` records
 * whether the issuer resolved against the producer's known-issuer list.
 */
const protocol = z.object({
  event: z.string().min(1),
  assetCode: z.string().optional(),
  assetIssuer: z.string().optional(),
  issuerKnown: z.boolean().optional(),
}).strict();

/**
 * Value moved. `direction` is relative to the namespace the observation is
 * about: "in" means value reached the counterparty, "out" means it left.
 * The same chain payment therefore produces an "in" observation for the
 * receiver's namespace and an "out" observation for the sender's, and the
 * idempotency key keeps both.
 */
const volume = z.object({
  amount: decimalString,
  assetCode: z.string().min(1),
  direction: z.enum(["in", "out"]),
}).strict();

/**
 * Graph proximity to a known operation cluster. `hops` is the shortest path
 * length from the counterparty to the cluster, so a direct contact is 1.
 * `amount` is the value of the contact when there was one, for dust.
 */
const clusterProximity = z.object({
  clusterId: z.string().min(1),
  hops: z.number().int().positive(),
  amount: decimalString.optional(),
}).strict();

/** Free text the counterparty produced, and which field it arrived in. */
const content = z.object({
  text: z.string(),
  field: z.enum(["memo", "error", "response"]),
}).strict();

const BY_CHANNEL = {
  address_integrity: addressIntegrity,
  latency,
  price,
  protocol,
  volume,
  cluster_proximity: clusterProximity,
  content,
} satisfies Record<Channel, z.ZodTypeAny>;

/** The payload type each channel carries, for a mapper that builds one. */
export type PayloadByChannel = { [C in Channel]: z.infer<(typeof BY_CHANNEL)[C]> };
export type AddressIntegrityPayload = PayloadByChannel["address_integrity"];
export type LatencyPayload = PayloadByChannel["latency"];
export type PricePayload = PayloadByChannel["price"];
export type ProtocolPayload = PayloadByChannel["protocol"];
export type VolumePayload = PayloadByChannel["volume"];
export type ClusterProximityPayload = PayloadByChannel["cluster_proximity"];
export type ContentPayload = PayloadByChannel["content"];

export function payloadSchemaFor(channel: Channel): z.ZodTypeAny {
  return BY_CHANNEL[channel];
}

export type ValidationResult =
  | { ok: true; value: Observation & { idempotencyKey: string } }
  | { ok: false; errors: string[] };

/** "path: message", with a name for the root so no error starts with a colon. */
function describe(root: string, issue: z.ZodIssue): string {
  const path = issue.path.join(".");
  const where = path === "" ? root : root === "observation" ? path : `${root}.${path}`;
  return `${where}: ${issue.message}`;
}

/**
 * Validates the schema version, then the envelope, then the channel-specific
 * payload, then assigns the deterministic idempotency key. Every layer must
 * pass; a valid envelope with a malformed payload is a rejection, because a
 * half-understood observation that reaches the tagging pipeline is worse than
 * one that never arrives.
 *
 * The version is checked first and exactly. Both sides of this contract live in
 * one repository and move together, so a producer declaring a version we do not
 * implement is telling us its shape was written against a different schema, and
 * accepting it half-understood is the worse failure. The check exists because
 * an exported version constant that nothing reads is a claim with no gate.
 *
 * The key is the engine's to assign. A producer that sends one anyway and gets
 * it wrong is rejected rather than corrected, because a silently replaced key
 * means the producer's deduplication and ours disagree about what a duplicate
 * is, and neither side would ever learn it.
 */
export function validateObservation(input: unknown): ValidationResult {
  const declared = (input as { schemaVersion?: unknown } | null | undefined)?.schemaVersion;
  if (declared !== OBSERVATION_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `schemaVersion: expected ${OBSERVATION_SCHEMA_VERSION}, received ${String(declared)}`,
      ],
    };
  }
  const envelope = observationSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      errors: envelope.error.issues.map((i) => describe("observation", i)),
    };
  }
  const o = envelope.data;
  const payload = payloadSchemaFor(o.channel).safeParse(o.payload);
  if (!payload.success) {
    return {
      ok: false,
      errors: payload.error.issues.map((i) => describe("payload", i)),
    };
  }
  const idempotencyKey = deriveIdempotencyKey(o.source, o.channel, o.namespace);
  if (o.idempotencyKey !== undefined && o.idempotencyKey !== idempotencyKey) {
    return {
      ok: false,
      errors: [
        "idempotencyKey: does not match the key derived from source, channel and namespace; omit it on the wire",
      ],
    };
  }
  return { ok: true, value: { ...o, idempotencyKey } };
}
