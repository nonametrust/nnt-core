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
 * A muxed address: M followed by 68 base32 characters. Matched in one case or
 * the other rather than with the `i` flag, for the same reason the repository
 * gate does it that way: a mixed-case run is not an address anyone produced.
 */
const MUXED_SHAPE = /^(?:M[A-Z2-7]{68}|m[a-z2-7]{68})$/;

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
}).strict().superRefine((ref, ctx) => {
  // The whitepaper's claim is that a muxed address resolves to its base
  // address before it reaches this type. This is that claim's gate, and it is
  // deliberately negative: it refuses the muxed shape and asserts nothing
  // about what a valid base address looks like. A positive check would
  // enforce "a wallet id is a Stellar account", which is a stronger claim than
  // the whitepaper makes and which a second chain would invalidate.
  //
  // Still not enforced, and stated in docs/observation-contract.md as the
  // indexer's own rule: that a wallet id is a checksum-valid account.
  if (ref.kind !== "wallet") return;
  if (!MUXED_SHAPE.test(ref.id)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["id"],
    message:
      "a wallet id is the base address: resolve the muxed address and carry its subaccount in muxedId",
  });
});
export type NamespaceRef = z.infer<typeof namespaceRefSchema>;
