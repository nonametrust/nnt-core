import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  fixedClock,
  keyRingFromEnv,
  openDb,
  RETENTION_V0,
  type Clock,
  type KeyRing,
} from "@nonametrust/store";
import { compose, COMPOSED_KEYS, type Composed } from "./compose.js";

// The composition root's own test, and it holds the gate §3 and §8 of M3's plan
// both require and which the plan gives to no task.
//
// WHAT WAS MEASURED, and it is why this file exists: seven of the eight
// clock-bearing classes in the store take their clock UNCHECKED.
// `ObservationRepository` is the one exception -- its constructor refuses a clock
// that is not its `NamespaceRepository`'s, by identity (observation.ts:171) --
// and §8's claim that "the store now refuses that between two of its own
// repositories" is true of exactly that one pair and false of every other. So one
// clock for the whole composition is a property the ENGINE has to hold, and a
// composition root that is merely the conventional place to construct things
// holds nothing.
//
// The clock is compared with `===` and not by the instant it returns. Two
// `fixedClock`s on the same start return equal instants forever and are still two
// objects, so an equality check would pass for exactly the arrangement this rule
// exists to refuse -- and then diverge the moment one of them is advanced.
//
// NO QUERY IS RUN HERE. `openDb` constructs a pool lazily, so a handle that
// points at nothing is enough to construct every repository; the DB-backed
// properties are in `brief-db.test.ts`. A composition test that needed a database
// would be a composition test that gets skipped when one is missing.

const ring: KeyRing = keyRingFromEnv({
  NNT_MASTER_KEY: randomBytes(32).toString("base64"),
} as NodeJS.ProcessEnv);

const UNREACHABLE = "postgres://nnt@127.0.0.1:1/nnt_composition_never_queried";

/** Everything `compose` returns that carries a clock, by key. */
function clockBearing(composed: Composed): [string, Clock][] {
  return Object.entries(composed).flatMap(([key, value]) => {
    if (key === "clock" || typeof value !== "object" || value === null) return [];
    const clock: unknown = (value as { clock?: unknown }).clock;
    return clock === undefined ? [] : [[key, clock as Clock]];
  });
}

describe("compose", () => {
  const build = (clock: Clock): Composed => compose(openDb(UNREACHABLE), clock, ring, RETENTION_V0);

  it("hands every clock-bearing repository the SAME clock object", () => {
    const clock = fixedClock(new Date("2026-09-21T00:00:00.000Z"));
    const composed = build(clock);

    const foreign = clockBearing(composed).filter(([, c]) => c !== clock);
    expect(
      foreign.map(([key]) => key),
      "these were built with a clock that is not the one compose was given",
    ).toEqual([]);
  });

  it("is checking eight of them, so wiring a ninth without its clock is not invisible", () => {
    // The count is the whole point. A `clockBearing` that found nothing would
    // make the test above pass over an empty list, which is the shape of gate
    // this repository has already shipped twice: a scan that is green because it
    // scanned nothing.
    const clock = fixedClock(new Date("2026-09-21T00:00:00.000Z"));
    // `ring` and `retention` are values rather than repositories, so they carry no
    // clock and are correctly absent from this list.
    expect(clockBearing(build(clock)).map(([key]) => key).sort()).toEqual([
      "audit",
      "baselines",
      "namespaces",
      "observations",
      "permanentRecords",
      "tags",
      "triggers",
      "volatility",
    ]);
  });

  it("builds a hot-window repository, which takes NO clock and is correctly absent above", () => {
    // Recorded rather than left as an absence: `HotWindowRepository`'s
    // constructor is `(db)` alone (hot-window.ts:31), so it cannot be handed a
    // foreign clock and its absence from the identity list is correct rather
    // than an omission. Without this assertion, deleting it from `compose`
    // entirely would turn no test red.
    const composed = build(fixedClock(new Date("2026-09-21T00:00:00.000Z")));
    expect(composed.hotWindows).toBeDefined();
    expect((composed.hotWindows as { clock?: unknown }).clock).toBeUndefined();
  });

  it("returns exactly the keys it declares, so a dropped repository is a red test", () => {
    const composed = build(fixedClock(new Date("2026-09-21T00:00:00.000Z")));
    expect(Object.keys(composed).sort()).toEqual([...COMPOSED_KEYS].sort());
  });

  it("carries the ring and the retention policy, so Task 8 can re-compose on a transaction", () => {
    // R10 puts the fold and the tag write in one transaction, and the ingest path
    // opens one and composes again onto it. `NamespaceRepository` keeps its ring
    // private, so without these a caller holding only the repositories could not.
    const composed = build(fixedClock(new Date("2026-09-21T00:00:00.000Z")));
    expect(composed.ring).toBe(ring);
    expect(composed.retention).toBe(RETENTION_V0);
    // And re-composing on the same handle really works, which is the point of carrying
    // them at all.
    const again = compose(composed.handle, composed.clock, composed.ring, composed.retention);
    expect(again.namespaces.clock).toBe(composed.clock);
    expect(again.namespaces.policy).toBe(RETENTION_V0);
    // THE RING TOO, which an earlier version of this row did not assert. A review
    // measured that the re-composition checked the clock and the policy and never the
    // ring -- so the commit message crediting it with holding the ring was wrong, and
    // the ring was held only by the plain identity assert above.
    expect(again.ring).toBe(composed.ring);
    expect(again.retention).toBe(composed.retention);
  });

  it("carries the clock it was given, for the wrapper that reads `at` off it", () => {
    const clock = fixedClock(new Date("2026-09-21T00:00:00.000Z"));
    expect(build(clock).clock).toBe(clock);
  });

  it("satisfies the one cross-check the store DOES make, on the policy as well as the clock", () => {
    // `ObservationRepository` refuses a `policy` that is not its namespace
    // repository's by identity too (observation.ts:151). Asserted here because
    // `compose` taking one `retention` argument is what makes it hold, and a
    // future `compose` that built a second policy object would construct fine
    // everywhere else and throw only here.
    expect(() => build(fixedClock(new Date("2026-09-21T00:00:00.000Z")))).not.toThrow();
    const composed = build(fixedClock(new Date("2026-09-21T00:00:00.000Z")));
    expect(composed.namespaces.policy).toBe(RETENTION_V0);
  });

  it("refuses a clock that is not a clock, rather than building eight broken repositories", () => {
    const clock = { now: "2026-09-21" } as unknown as Clock;
    expect(() => compose(openDb(UNREACHABLE), clock, ring, RETENTION_V0)).toThrow(
      /compose\(\) clock\.now must be a function/,
    );
  });
});
