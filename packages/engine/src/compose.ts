import {
  AuditChain,
  BaselineRepository,
  HotWindowRepository,
  NamespaceRepository,
  ObservationRepository,
  PermanentRecordRepository,
  TagRepository,
  TriggerEventRepository,
  VolatilityRepository,
  type Clock,
  type Db,
  type KeyRing,
  type RetentionPolicy,
} from "@nonametrust/store";

/**
 * Everything one composition holds. Returned as a record rather than assembled by
 * the caller, because the caller assembling it is the arrangement this module
 * exists to remove.
 *
 * `handle` and `clock` are carried so a caller needs nothing else: the wrapper
 * reads `at` off the clock, and Task 8 opens a transaction on the handle and
 * composes again onto it under R10.
 */
export interface Composed {
  /**
   * The `Db` or `Transaction` every repository here was built on.
   *
   * NAMED `handle` AND NOT `db` on purpose: `Db` is `Kysely<Schema>` and
   * `Transaction<Schema>` extends it, so the same type covers both and a field
   * called `db` would read as "not a transaction" to someone deciding whether
   * R10's per-transaction rebuild is possible. It is; that is why this parameter
   * is typed the way it is.
   */
  readonly handle: Db;
  readonly clock: Clock;
  readonly namespaces: NamespaceRepository;
  readonly observations: ObservationRepository;
  readonly tags: TagRepository;
  readonly permanentRecords: PermanentRecordRepository;
  readonly baselines: BaselineRepository;
  readonly triggers: TriggerEventRepository;
  readonly volatility: VolatilityRepository;
  readonly hotWindows: HotWindowRepository;
  readonly audit: AuditChain;
}

/**
 * Written as a mapped type over `Composed` rather than as a list, so a field
 * added to `Composed` and not to `compose` is a compile error in two directions:
 * missing here, and missing from the returned object literal.
 */
const COMPOSED_KEY_SET: { readonly [K in keyof Composed]: true } = {
  handle: true,
  clock: true,
  namespaces: true,
  observations: true,
  tags: true,
  permanentRecords: true,
  baselines: true,
  triggers: true,
  volatility: true,
  hotWindows: true,
  audit: true,
};

/** The keys `compose` returns, for the test that pins them. */
export const COMPOSED_KEYS: readonly (keyof Composed)[] = Object.keys(
  COMPOSED_KEY_SET,
) as (keyof Composed)[];

/**
 * The composition root: the ONE place in this package that constructs a store
 * class, so the whole composition shares one clock.
 *
 * WHY IT IS A GATE AND NOT A CONVENIENCE. Measured across the store's EIGHT
 * clock-bearing classes -- nine are composed here, and `HotWindowRepository` takes
 * no clock -- seven take their clock UNCHECKED.
 * `ObservationRepository` is the single exception, refusing a clock that is not
 * its `NamespaceRepository`'s by identity, and M3's plan §8 generalises that one
 * pair into "the store now refuses that between two of its own repositories" --
 * which is false of the other seven. So "one clock per composition" is the
 * engine's property to hold, and `compose-gate.test.ts` refuses a second
 * construction site anywhere in this package.
 *
 * THE CLOCK IS PASSED, NEVER MADE. `ids.ts` records the same rule for
 * identifiers: `at` is the store's own injected clock on every path including
 * replay, because `open` and `refresh` refuse a `taggedAt` after `clock.now()`
 * and a second clock object is a class of bug the store already refuses between
 * one pair.
 *
 * WHAT THIS STILL DOES NOT HOLD, recorded rather than claimed shut: two
 * `compose` calls with two different clocks are invisible to every gate. This
 * makes one clock the norm, not a guarantee. Closing it would need a rule that
 * recognises the *caller* of a composition root, and nobody has written one.
 *
 * `handle` is a `Db` OR a `Transaction`, and the one type covers both because
 * `Transaction<Schema>` extends `Kysely<Schema>`. Task 8 rebuilds every
 * repository per transaction under R10, and this signature is what lets it.
 * Note that three methods refuse a transaction outright --
 * `ObservationRepository.append`, `PermanentRecordRepository.promote` and
 * `AuditChain.append` -- so a composition on a transaction is not a composition
 * with fewer capabilities by accident; it is one whose writers say so.
 */
export function compose(
  handle: Db,
  clock: Clock,
  ring: KeyRing,
  retention: RetentionPolicy,
): Composed {
  // Refused here rather than discovered as a TypeError inside the first repository
  // that calls it, which for a brief is several reads in. A JavaScript caller
  // bypasses the `Clock` type, and this is the seam every instant in the system
  // comes through.
  if (typeof clock.now !== "function") {
    throw new TypeError(`compose() clock.now must be a function, got ${typeof clock.now}`);
  }

  // ONE policy object and ONE clock object flow into all of them, which is what
  // makes `ObservationRepository`'s two identity checks pass. Build the namespace
  // repository first: it is the only one another repository takes.
  const namespaces = new NamespaceRepository(handle, ring, clock, retention);

  return {
    handle,
    clock,
    namespaces,
    observations: new ObservationRepository(handle, namespaces, clock, retention),
    tags: new TagRepository(handle, clock),
    permanentRecords: new PermanentRecordRepository(handle, ring, clock, retention),
    baselines: new BaselineRepository(handle, clock),
    triggers: new TriggerEventRepository(handle, clock),
    volatility: new VolatilityRepository(handle, clock),
    // No clock, so there is no foreign one to hand it. Its absence from
    // `compose.test.ts`'s identity list is correct rather than an omission, and
    // that file says so.
    hotWindows: new HotWindowRepository(handle),
    // THE RING IS THE THIRD ARGUMENT HERE AND THE SECOND EVERYWHERE ELSE.
    // `new NamespaceRepository(handle, ring, clock, ...)` against
    // `new AuditChain(handle, clock, ring)`. Both parameters are objects of
    // different shapes, so a swap is a type error today -- but it is the kind of
    // asymmetry that becomes silent the moment either type loosens, and this is
    // the one call site where it can be seen.
    audit: new AuditChain(handle, clock, ring),
  };
}
