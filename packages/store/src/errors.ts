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
export class MigrationDrift extends StoreError {}

const BY_SQLSTATE: Record<string, new (m: string) => StoreError> = {
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
 */
export function mapPgError(e: unknown): StoreError | null {
  if (typeof e !== "object" || e === null) return null;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const Ctor = BY_SQLSTATE[code];
  if (!Ctor) return null;
  const message = (e as { message?: unknown }).message;
  return new Ctor(typeof message === "string" ? message : code);
}
