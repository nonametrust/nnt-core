import { z } from "zod";

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
  assertedAt: z.string().datetime(),
  reason: z.string().trim().min(1),
}).strict();
export type ContinuityAssertion = z.infer<typeof continuityAssertionSchema>;

/**
 * Addresses, domains and endpoints are attributes of a namespace, not the
 * namespace itself. Where the integration supplies nothing richer, a wallet
 * address is the anchor. Muxed addresses resolve to the base address before
 * they reach this type; the muxed identifier is an attribute.
 */
export const namespaceRefSchema = z.object({
  kind: z.enum(["wallet", "domain", "endpoint", "merchant"]),
  // The id is a part of the idempotency key, which joins its parts on a NUL,
  // so it may not contain one. Gated in namespace.test.ts.
  id: z.string().min(1).regex(/^[^\u0000]*$/, {
    message: "must not contain NUL, the idempotency key separator",
  }),
  continuity: continuityAssertionSchema.optional(),
}).strict();
export type NamespaceRef = z.infer<typeof namespaceRefSchema>;
