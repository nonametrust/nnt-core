import { z } from "zod";
import { type Channel } from "./channel.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  observationSchema,
  type Observation,
} from "./observation.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { decimalStringSchema } from "./scalars.js";

// Every payload object is strict, like every other object in this package. An
// unknown key is rejected rather than stripped, because a stripped key tells
// the indexer a field is flowing when it is not. Gated in payloads.test.ts.

/**
 * A counterparty's advertised payment address moved from `previous` to
 * `current`. One observation records exactly one transition; a revert is a
 * second transition, with its own source reference, and is a second
 * observation. Two transitions in one day is the anomaly the engine looks
 * for, and a flag folding both into one observation would hide it.
 * `previous` is required: a change with no previous address is a first
 * sighting, not a change, and belongs to a different kind. `muxedId` is the
 * muxed identifier when the address was muxed; the namespace itself always
 * holds the base address.
 */
const addressIntegrity = z.object({
  previous: z.string().min(1),
  current: z.string().min(1),
  muxedId: z.string().optional(),
}).strict();

/** How long the counterparty took to respond, in whole or fractional ms. */
const latency = z.object({ latencyMs: z.number().nonnegative() }).strict();

/**
 * What the counterparty asked for. `quoted` is the decimal amount, `unit` is
 * its denomination, for example "USDC". What the amount buys is the `kind` of
 * the observation, for example "price_quoted" for one x402 request.
 */
const price = z.object({ quoted: decimalStringSchema, unit: z.string().min(1) }).strict();

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
 * Value moved. The type is written out rather than inferred so that the field
 * documentation reaches the declarations a mapper author reads; the validator
 * below is checked against it, and `payloads.test.ts` checks the two agree in
 * both directions.
 */
export interface VolumePayload {
  /** Decimal string, no sign, no exponent, no leading zero: "0.2500000". */
  amount: string;
  /** The asset code as the chain reports it, for example "USDC" or "XLM". */
  assetCode: string;
  /**
   * Relative to the namespace this observation is about, not to the payer.
   * "in" means value reached the counterparty; "out" means it left. One chain
   * payment therefore yields an "in" observation for the receiver's namespace
   * and an "out" observation for the sender's, and the idempotency key, which
   * carries the namespace, keeps both.
   */
  direction: "in" | "out";
}

const volume = z.object({
  amount: decimalStringSchema,
  assetCode: z.string().min(1),
  direction: z.enum(["in", "out"]),
}).strict() satisfies z.ZodType<VolumePayload>;

/**
 * Graph proximity to a known operation cluster. `hops` is the shortest path
 * length from the counterparty to the cluster, so a direct contact is 1.
 * `amount` is the value of the contact when there was one, for dust.
 */
const clusterProximity = z.object({
  clusterId: z.string().min(1),
  hops: z.number().int().positive(),
  amount: decimalStringSchema.optional(),
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

/**
 * The payload type each channel carries, for a mapper that builds one. The
 * volume entry resolves to the documented interface rather than to the
 * validator's inferred type, so the direction convention reaches a reader on
 * this route as well; `payloads.test.ts` holds the two identical.
 */
export type PayloadByChannel = {
  [C in Channel]: C extends "volume" ? VolumePayload : z.infer<(typeof BY_CHANNEL)[C]>;
};
export type AddressIntegrityPayload = PayloadByChannel["address_integrity"];
export type LatencyPayload = PayloadByChannel["latency"];
export type PricePayload = PayloadByChannel["price"];
export type ProtocolPayload = PayloadByChannel["protocol"];
export type ClusterProximityPayload = PayloadByChannel["cluster_proximity"];
export type ContentPayload = PayloadByChannel["content"];

/** The validator for one channel, typed to that channel's payload. */
export function payloadSchemaFor<C extends Channel>(channel: C): (typeof BY_CHANNEL)[C] {
  return BY_CHANNEL[channel];
}

export type ValidationResult =
  | { ok: true; value: Observation & { idempotencyKey: string } }
  | { ok: false; errors: string[] };

/**
 * "path: message". An issue with no path, such as an unknown key on a strict
 * object, is reported at `root` so no error starts with a bare colon. Payload
 * issues are prefixed with the key they sit under in the envelope.
 */
function formatIssue(issue: z.ZodIssue, root: string, prefix: string[] = []): string {
  const path = [...prefix, ...issue.path].join(".");
  return `${path || root}: ${issue.message}`;
}

/** Assigned by the engine on ingest; their presence on the wire is an error. */
const ENGINE_ASSIGNED = ["observationId", "ingestedAt"] as const;

/**
 * Validates that the input is an object, then that no engine-assigned field
 * arrived on the wire, then the schema version, then the envelope, then the
 * channel-specific payload, then assigns the deterministic idempotency key.
 * Every layer must pass; a valid envelope with a malformed payload is a
 * rejection, because a half-understood observation that reaches the tagging
 * pipeline is worse than one that never arrives.
 *
 * The object check comes first because an unparsed JSON string is the first
 * mistake a caller makes, and blaming `schemaVersion` for it sends them to the
 * wrong place.
 *
 * The engine-field check runs on the raw input, before the envelope parses,
 * because the envelope would otherwise complain about the field's format, an
 * invalid uuid or a null where a string was expected, and send the producer
 * to fix a field whose correct fix is to delete it.
 *
 * The version is checked next and exactly. Both sides of this contract live in
 * one repository and move together, so a producer declaring a version we do not
 * implement is telling us its shape was written against a different schema, and
 * accepting it half-understood is the worse failure. The check exists because
 * an exported version constant that nothing reads is a claim with no gate.
 *
 * `observationId`, `ingestedAt` and `idempotencyKey` are the engine's to
 * assign. The first two must be absent on the wire. The key may be present
 * only if it equals the derived one, so a producer that precomputes it with
 * `deriveIdempotencyKey` is not turned away; one that gets it wrong is
 * rejected rather than corrected, because a silently replaced key means the
 * producer's deduplication and ours disagree about what a duplicate is, and
 * neither side would ever learn it. The message carries the derived key so the
 * producer can see what it should have sent.
 */
export function validateObservation(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    const received = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
    return {
      ok: false,
      errors: [`observation: expected a parsed JSON object, received ${received}`],
    };
  }
  const supplied = ENGINE_ASSIGNED.filter((field) => field in input);
  if (supplied.length > 0) {
    return {
      ok: false,
      errors: supplied.map(
        (field) => `${field}: assigned by the engine on ingest and must not appear on the wire`,
      ),
    };
  }
  const declared = (input as { schemaVersion?: unknown }).schemaVersion;
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
      errors: envelope.error.issues.map((i) => formatIssue(i, "observation")),
    };
  }
  const o = envelope.data;
  const payload = payloadSchemaFor(o.channel).safeParse(o.payload);
  if (!payload.success) {
    return {
      ok: false,
      errors: payload.error.issues.map((i) => formatIssue(i, "payload", ["payload"])),
    };
  }
  const idempotencyKey = deriveIdempotencyKey(o.source, o.channel, o.namespace);
  if (o.idempotencyKey !== undefined && o.idempotencyKey !== idempotencyKey) {
    return {
      ok: false,
      errors: [
        `idempotencyKey: received ${o.idempotencyKey}, but source, channel and namespace derive ${idempotencyKey}; omit it on the wire or compute it with deriveIdempotencyKey`,
      ],
    };
  }
  return { ok: true, value: { ...o, idempotencyKey } };
}
