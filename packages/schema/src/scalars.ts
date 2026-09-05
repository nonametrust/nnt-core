import { z } from "zod";

/**
 * The two scalar formats the contract fixes, shared by the envelope, the
 * namespace, the source and the payloads so that every field of one kind
 * gives the same answer and the same error.
 */

/**
 * Every timestamp in the contract is ISO 8601 in UTC, ending in Z. Offsets are
 * rejected rather than normalised, because a producer that sends "+03:00" once
 * will send it everywhere, and the place to learn the rule is the first
 * rejection, with a message that states it. Gated in payloads.test.ts on every
 * timestamp field.
 */
export const UTC_DATETIME_MESSAGE =
  "must be an ISO 8601 UTC timestamp ending in Z, such as 2026-09-05T10:00:00.000Z";
export const utcDatetimeSchema = z.string().datetime({ message: UTC_DATETIME_MESSAGE });

/**
 * Amounts and prices travel as decimal strings, never as numbers, because a
 * JSON number is a double and Stellar amounts carry seven decimals. The
 * pattern admits what Horizon emits ("0.0000100", "500") and nothing else: no
 * sign, no exponent, no locale separator, no leading zero, so that one value
 * has one spelling and a stored amount compares as a string. Direction carries
 * the sign. Gated in payloads.test.ts.
 */
export const DECIMAL_STRING_MESSAGE =
  "must be a non-negative decimal string with no leading zero, such as \"12.5\"";
export const decimalStringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, { message: DECIMAL_STRING_MESSAGE });
