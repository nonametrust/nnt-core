/**
 * Every invariant the database holds raises a distinct SQLSTATE, and each maps
 * to a class here. Tests assert on the class and never on the message text, so
 * that rewording a message is not a red suite and swallowing a violation is
 * not a green one.
 */
export class StoreError extends Error {}

export class AppendOnlyViolation extends StoreError {}
export class ChainBroken extends StoreError {}
export class TimestampAltered extends StoreError {}
export class NamespaceShredded extends StoreError {}
// Raised in TypeScript, like NamespaceShredded, so it carries no SQLSTATE. It
// exists because an erasure request naming a subject that has no row must not
// resolve as success: nothing was examined, and "the data is gone" would be
// reported to an operator about data that was never looked for.
export class NamespaceNotFound extends StoreError {}
// Also raised in TypeScript. A read of an identifier no row carries is a
// caller's condition, not the store's defect, and a generic Error would make
// the two indistinguishable at the call site.
export class ObservationNotFound extends StoreError {}
// Also raised in TypeScript, and from `suppress` and `refresh` as well as from
// `get`: an update that matched no row would otherwise resolve as success
// about a tag that was never touched.
export class TagNotFound extends StoreError {}
// Raised in TypeScript, before anything is read or written. A caller-supplied
// idempotency key that differs from the derived one is refused rather than
// replaced: replaced, the caller would later ask for the key it wrote and be
// told nothing is there, a claim accepted and then denied.
export class IdempotencyKeyMismatch extends StoreError {}
// Also raised in TypeScript, from `promote`, after the source is read and
// before anything is written. A state has no instant to preserve, so the
// column would refuse the row on its own as a not-null violation; the class
// exists so a caller that promoted a state can tell that from a disk error.
export class StateNotPromotable extends StoreError {}
// Raised in TypeScript, from `get`, for the reason ObservationNotFound is.
export class PermanentRecordNotFound extends StoreError {}
export class MigrationDrift extends StoreError {}

const BY_SQLSTATE: Record<string, new (m: string, o?: ErrorOptions) => StoreError> = {
  NNT01: AppendOnlyViolation,
  NNT02: ChainBroken,
  NNT03: ChainBroken,
  NNT04: TimestampAltered,
};

/**
 * Returns a named error for a Postgres error this package raised, and null for
 * anything else. Null rather than a generic wrapper: an error we did not
 * design is rethrown unchanged, because flattening an unknown driver failure
 * into a store error hides it.
 *
 * The original is kept as `cause`. A trigger's `detail`, `hint`, `constraint`
 * and stack live on the pg error, and a chain break in production is debugged
 * from those, not from the message.
 */
export function mapPgError(e: unknown): StoreError | null {
  if (typeof e !== "object" || e === null) return null;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const Ctor = BY_SQLSTATE[code];
  if (!Ctor) return null;
  const message = (e as { message?: unknown }).message;
  return new Ctor(typeof message === "string" ? message : code, { cause: e });
}
