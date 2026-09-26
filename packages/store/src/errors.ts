/**
 * Every invariant the database holds maps to a class here. The triggers this
 * package writes raise their own SQLSTATEs, NNT01 to NNT09, and each maps to
 * a class of its own; the constraints Postgres names for itself, the foreign
 * keys, unique keys and check constraints, arrive as 23503, 23505 and 23514
 * and map to one class carrying the SQLSTATE and the constraint's name. Tests
 * assert on the class and never on the message text, so that rewording a
 * message is not a red suite and swallowing a violation is not a green one.
 */
export class StoreError extends Error {}

export class AppendOnlyViolation extends StoreError {}
export class ChainBroken extends StoreError {}
export class TimestampAltered extends StoreError {}
export class NamespaceShredded extends StoreError {}
// NNT05, from the guard on namespace. Not NNT01: a shred reversal or a
// re-attributed identity is not an append-only violation, since the row is
// meant to be updated, and an operator must be able to tell the two apart
// by class.
export class NamespaceAltered extends StoreError {}
// Raised by the namespace_key guard, under NNT06. Like the namespace guard's
// class and unlike the append-only one: this table is meant to be updated,
// because expiry IS an update, so a refusal here says an update broke a rule
// rather than that the row was immutable.
export class PeriodKeyAltered extends StoreError {}
// Raised in TypeScript, not by the database. A month whose key has been
// shredded is a payload nobody can read, and that is a different condition
// from a shredded namespace: the counterparty space is intact and every other
// month of it is still readable. An operator told "shredded" about an expired
// month would look for an erasure request that never happened.
export class PayloadExpired extends StoreError {}
// Raised by the tag guard, under its own SQLSTATE rather than the append-only
// one: the tag table is meant to be updated, so a refusal here says an update
// broke a rule the arithmetic holds, not that the row was immutable.
export class TagAltered extends StoreError {}
// Raised in TypeScript by `refresh`, and deliberately not a ConstraintViolation:
// nothing was refused by the database, the caller's read is simply older than
// the row. The cure is to read the live tag again and decide again, which is
// a different instruction from "this tag does not exist".
export class TagRefreshStale extends StoreError {}

// Raised in TypeScript, so it carries no SQLSTATE: the database refused
// nothing, this repository counted and declined. It names the producer, the
// window and the count because an operator's next move depends on all three
// -- R3 rules that this cap is not a defence against an attacker (the
// producer name is free text until signatures are enforced) but a tripwire
// for our own indexer in a loop, and a tripwire that does not say what it
// counted is a tripwire nobody can act on.
export class SourceRateExceeded extends StoreError {}

// Raised in TypeScript when a write path is handed a repository built on a
// Transaction. R21: reads compose and writes do not. Kysely refuses a nested
// transaction with a bare Error, and it does so AFTER the earlier steps of
// the write have already written into the caller's transaction, so this
// moves the refusal to the front and gives it a name. The rule is not
// fastidiousness: composing two of this store's writes in one transaction
// produces a lock-ordering cycle that deadlocks in about a second, measured.
export class WriteInsideTransaction extends StoreError {}

// 40P01, Postgres's own deadlock detector firing about a second after two
// transactions have taken this store's row locks in opposite orders.
//
// R21 refuses the three writes that open a transaction of their own, and
// review then measured that it is NOT enough: `{shred A; shred B}` against
// `{shred B; shred A}` deadlocks, and so does a shred against
// `expirePeriods`. Those are single statements, they compose in a caller's
// transaction, and nothing refuses them. Naming the failure is not a fix and
// does not pretend to be one -- it is so a caller can tell a deadlock from a
// constraint and retry, which is the correct response to 40P01 and the
// wrong one to almost everything else this store raises.
export class Deadlocked extends StoreError {}
// 55P03 and 57014: an operator's `lock_timeout` or `statement_timeout`
// cancelling a statement this store was waiting on. Neither is ours to
// allocate and neither is a defect -- section 4 of `0007` tells the hand-run
// migration path to set one on purpose, and a lock wait bounded by policy is
// what a healthy operator does.
//
// Mapped because an unmapped one is worse than either. Measured against a
// server with `lock_timeout = 50ms`: an `append` queued behind an erasure's
// row lock came back with a raw driver error carrying `code: '55P03'` and a
// message about `PL/pgSQL function observation_target_writable()` -- from
// inside this store's own trigger -- where the caller was told to expect
// `NamespaceShredded`. Under the same setting BOTH sides of a deadlock get
// 55P03 and `Deadlocked` never fires at all. Nothing was written wrongly in
// any case; the transaction aborts. What was wrong is that a caller catching
// this package's classes caught nothing.
//
// One class for both, because the caller's answer is the same: the work did
// not happen, the reason is a policy and not a rule, and retrying is
// reasonable if the policy allows time. Distinct from `Deadlocked` because a
// deadlock says two callers collided and this says one waited too long.
export class Cancelled extends StoreError {}
// Raised in TypeScript, so it carries no SQLSTATE. (NamespaceShredded used
// to be the comparison here and no longer is: NNT08 maps to it since the
// erasure gate, so it arrives both ways.) It
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
// Raised in TypeScript, from `sealDay`, when nothing had been appended by the
// close of the day named. There is no chain head to seal, and a seal row
// pointing at nothing would be a claim about a history that did not exist.
export class NothingToSeal extends StoreError {}
// Also raised in TypeScript, from `sealDay`, for a day whose close is not yet
// past on the clock. A seal fixes a head that later entries of an open day
// would contradict, and once sealed it cannot be corrected.
export class DayNotClosed extends StoreError {}
// Also raised in TypeScript, from `sealDay`, when the day already carries a
// seal and the head at its close is no longer the one that was sealed. A
// re-run over the same head returns quietly; this difference is the signal
// the seal exists to give, and it is raised rather than overwritten.
export class SealMismatch extends StoreError {}
// Both raised in TypeScript, from `get`, for the reason ObservationNotFound
// is. baseline and volatility have no such class: a namespace with no
// baseline or no estimate yet is every new namespace, so their reads answer
// empty and null rather than raise.
export class TriggerEventNotFound extends StoreError {}
export class HotWindowNotFound extends StoreError {}
export class MigrationDrift extends StoreError {}
// Both raised in TypeScript, from crypto.ts, about bytes read back from the
// database. CiphertextMalformed: a stored wrapped key or sealed payload whose
// layout is not one this package writes, a header cut short, a nonce of the
// wrong length, a version byte no decode branch knows. CiphertextRejected:
// the layout is right and the cipher refused it, which is what a payload
// moved to another row, a rewritten column beside it, a flipped bit and the
// wrong key all look like; GCM cannot say which, and this class does not
// pretend to. A malformed master key is neither: that is a RangeError,
// raised at startup before any stored byte is read, because the key is the
// ring's argument and not the store's state.
export class CiphertextMalformed extends StoreError {}
export class CiphertextRejected extends StoreError {}

/**
 * A constraint the database holds under a SQLSTATE Postgres assigns rather
 * than one this package chose: a foreign key (23503), a unique key (23505) or
 * a check (23514). The constraint's name is the discriminator, since one code
 * covers many constraints; it is a field so that a caller asserts on the class
 * and reads the name, rather than comparing the code, which is the message-text
 * problem in a different costume. The driver's error stays as `cause`.
 *
 * Two places look at a raw 23505 before this mapping runs and must keep doing
 * so: the observation repository's duplicate retry and the audit chain's seal
 * race. Both inspect the driver error in their own catch, ahead of
 * `mapPgError`, because a duplicate arriving as this class would be a failure
 * to them rather than the retry they exist for.
 */
export class ConstraintViolation extends StoreError {
  readonly sqlstate: string;
  readonly constraint: string | null;
  constructor(message: string, sqlstate: string, constraint: string | null, options?: ErrorOptions) {
    super(message, options);
    this.sqlstate = sqlstate;
    this.constraint = constraint;
  }
}

const CONSTRAINT_SQLSTATES: ReadonlySet<string> = new Set(["23503", "23505", "23514"]);

const BY_SQLSTATE: Record<string, new (m: string, o?: ErrorOptions) => StoreError> = {
  NNT01: AppendOnlyViolation,
  NNT02: ChainBroken,
  NNT03: ChainBroken,
  NNT04: TimestampAltered,
  NNT05: NamespaceAltered,
  NNT06: PeriodKeyAltered,
  NNT07: TagAltered,
  NNT08: NamespaceShredded,
  // The insert gate's month half: a write under a month whose key the
  // retention clock already took. Mapped to the class that already means
  // exactly that, so a caller has one thing to catch whether the month died
  // before the read or before the write.
  NNT09: PayloadExpired,
  "55P03": Cancelled,
  "57014": Cancelled,
  // Postgres's own, not one this schema allocated.
  "40P01": Deadlocked,
};

/**
 * Returns a named error for a Postgres error this package designed, the
 * SQLSTATEs its triggers raise and the three codes its declared constraints
 * are refused under, and null for anything else. Null rather than a generic
 * wrapper: an error we did not design is rethrown unchanged, because
 * flattening an unknown driver failure into a store error hides it.
 *
 * The original is kept as `cause`. A trigger's `detail`, `hint`, `constraint`
 * and stack live on the pg error, and a chain break in production is debugged
 * from those, not from the message.
 */
export function mapPgError(e: unknown): StoreError | null {
  if (typeof e !== "object" || e === null) return null;
  const { code, message, constraint } = e as { code?: unknown; message?: unknown; constraint?: unknown };
  if (typeof code !== "string") return null;
  const text = typeof message === "string" ? message : code;
  if (CONSTRAINT_SQLSTATES.has(code)) {
    return new ConstraintViolation(
      text, code, typeof constraint === "string" ? constraint : null, { cause: e },
    );
  }
  const Ctor = BY_SQLSTATE[code];
  if (!Ctor) return null;
  return new Ctor(text, { cause: e });
}
