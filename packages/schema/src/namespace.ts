import { z } from "zod";
import { utcDatetimeSchema } from "./scalars.js";

/**
 * Continuity is an integration assertion, never an inference. The engine does
 * not resolve entities and never silently merges identities, so a claim that
 * two addresses are the same counterparty arrives with an asserter and a
 * reason, and is stored as provenance.
 */
// Both objects in this module are strict. An unknown key is rejected rather
// than stripped, because a stripped key tells the integrator a field is
// flowing when it is not. Gated in namespace.test.ts.
export const continuityAssertionSchema = z.object({
  // A whitespace-only asserter is not a who and a whitespace-only reason is
  // not a why, so both are trimmed before the length check.
  assertedBy: z.string().trim().min(1),
  assertedAt: utcDatetimeSchema,
  reason: z.string().trim().min(1),
}).strict();
export type ContinuityAssertion = z.infer<typeof continuityAssertionSchema>;

/**
 * Addresses, domains and endpoints are attributes of a namespace, not the
 * namespace itself. Where the integration supplies nothing richer, a wallet
 * address is the anchor. Muxed addresses resolve to the base address before
 * they reach this type: `id` holds the base address and `muxedId` holds the
 * muxed identifier, which is an attribute of the namespace and not part of
 * which counterparty is meant, so it stays out of the idempotency key
 * (gated in idempotency.test.ts). This is the subject's own identity; the
 * `muxedId` on an address_integrity payload describes an advertised address
 * inside a transition and is a different thing.
 *
 * The id is compared byte for byte, with no trimming, case folding or URL
 * normalisation: two spellings are two namespaces. Gated in
 * idempotency.test.ts.
 */
export const namespaceRefSchema = z.object({
  kind: z.enum(["wallet", "domain", "endpoint", "merchant"]),
  // The id is a part of the idempotency key, which joins its parts on a NUL,
  // so it may not contain one. Gated in namespace.test.ts.
  id: z.string().min(1).regex(/^[^\u0000]*$/, {
    message: "must not contain NUL, the idempotency key separator",
  }),
  // The muxed identifier as Horizon reports it in `to_muxed_id` or
  // `from_muxed_id`. The schema checks only that it is non-empty.
  muxedId: z.string().min(1).optional(),
  continuity: continuityAssertionSchema.optional(),
}).strict();
export type NamespaceRef = z.infer<typeof namespaceRefSchema>;
