import { describe, it, expect } from "vitest";
import { datedAt, holdsAt } from "./timing.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

// The gate for the claim that datedAt is the only reader of a date off an
// observation is gates/single-date-reader.test.ts at the repository root. It
// used to live here, and so scanned this package alone.
describe("datedAt", () => {
  it("returns the instant for an event", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a state, so a state can never be dated", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "trustline_open",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
      source: src, payload: {},
    })).toBeNull();
  });

  it("dates an event by observedAt, not by when it was fetched or ingested", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
      ingestedAt: "2026-09-05T11:00:00.000Z",
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a closed state as well as an open one", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "trustline_open",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2026-09-03T00:00:00.000Z",
      source: src, payload: {},
    })).toBeNull();
  });
});

// R16: whether a STATE still holds at an instant.
//
// WHY IT LIVES HERE, beside `datedAt`, and why that is the whole ruling. The M2
// ledger tells M3's engine to check that a state still holds before it opens or
// refreshes a tag; the root gate refuses any line naming `validUntil` outside
// this file. The first version of M3's plan put the check in the engine and gave
// the gate a new exemption -- and the alternative it rejected is better by the
// gate's own design: this module is ALREADY the single exempt date reader and it
// held no interval, so putting `holdsAt` beside `datedAt` is not "the interval in
// two places", it is the designated place. Exempting a file in the one package
// that imports both the store and tagging would also have forced a change to the
// gate's own sentence, "a new package enters under it on the day it is created,
// with no exemption".
//
// The cost, recorded: `@nonametrust/schema` gains a function, so its version
// moves.
describe("holdsAt", () => {
  const state = (validFrom: string, validUntil: string | null) => ({
    schemaVersion: "0.1.0" as const, namespace: { kind: "wallet" as const, id: "G" },
    channel: "protocol" as const, evidenceKind: "state" as const, kind: "trustline_open",
    validFrom, validUntil, source: src, payload: {},
  });
  const anEvent = (observedAt: string) => ({
    schemaVersion: "0.1.0" as const, namespace: { kind: "wallet" as const, id: "G" },
    channel: "volume" as const, evidenceKind: "event" as const, kind: "payment",
    observedAt, source: src, payload: {},
  });
  const at = (iso: string) => new Date(iso);

  it("is false for a state whose validity has passed", () => {
    const s = state("2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    expect(holdsAt(s, at("2026-09-04T00:00:00.000Z"))).toBe(false);
    expect(holdsAt(s, at("2026-09-03T00:00:00.001Z"))).toBe(false);
  });

  it("is true AT validUntil itself, so the interval is closed at its end", () => {
    // The boundary is a decision and not an accident. Closed at both ends: a
    // state valid until noon still holds at noon. Half-open would be the other
    // defensible choice, and the reason this one is written down is that whichever
    // it is, a caller comparing instants a millisecond apart must be able to read
    // it off this file rather than infer it from a test that only checks one side.
    const s = state("2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    expect(holdsAt(s, at("2026-09-03T00:00:00.000Z"))).toBe(true);
    expect(holdsAt(s, at("2026-09-02T23:59:59.999Z"))).toBe(true);
  });

  it("is false BEFORE validFrom, which the plan's acceptance does not name", () => {
    // The plan names only `validUntil`. A state that begins tomorrow does not hold
    // today either, and an engine that only checked the upper bound would open a
    // tag from evidence that has not started -- the same defect at the other end.
    const s = state("2026-09-05T00:00:00.000Z", null);
    expect(holdsAt(s, at("2026-09-04T23:59:59.999Z"))).toBe(false);
    expect(holdsAt(s, at("2026-09-05T00:00:00.000Z"))).toBe(true);
  });

  it("holds indefinitely when validUntil is null", () => {
    const s = state("2026-09-01T00:00:00.000Z", null);
    expect(holdsAt(s, at("2026-09-01T00:00:00.000Z"))).toBe(true);
    expect(holdsAt(s, at("2099-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("holds at the single instant of a zero-length interval", () => {
    // `validUntil === validFrom` is admissible -- the schema refuses only
    // `validUntil` BEFORE `validFrom` -- so this is a reachable state and the
    // closed-interval rule decides it.
    const s = state("2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
    expect(holdsAt(s, at("2026-09-02T00:00:00.000Z"))).toBe(true);
    expect(holdsAt(s, at("2026-09-02T00:00:00.001Z"))).toBe(false);
    expect(holdsAt(s, at("2026-09-01T23:59:59.999Z"))).toBe(false);
  });

  it("is true for an EVENT, whatever the instant, and says why", () => {
    // An event has no interval to fall outside of. Answering `true` is a choice
    // and not an absence of one: the caller's question is "may this evidence open
    // or refresh a tag", and an event's answer is always yes -- its currency is
    // the half-life's business, which is tagging's, and never this function's.
    //
    // The alternative, a three-valued answer like `datedAt`'s, was rejected
    // because every caller would have to collapse it to a boolean and the
    // collapse is where the mistake would live.
    const e = anEvent("2026-09-05T09:00:00.000Z");
    expect(holdsAt(e, at("2026-09-05T09:00:00.000Z"))).toBe(true);
    expect(holdsAt(e, at("2099-01-01T00:00:00.000Z"))).toBe(true);
    expect(holdsAt(e, at("1999-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("refuses an invalid instant rather than answering false", () => {
    // `NaN` fails every comparison, so an unrefused invalid date would report
    // "does not hold" for a state that does -- a wrong answer dressed as a
    // decision. The store refuses an invalid instant in `strengthAt` for exactly
    // this reason.
    const s = state("2026-09-01T00:00:00.000Z", null);
    expect(() => holdsAt(s, new Date("not a date"))).toThrow(RangeError);
  });

  it("refuses a state whose own interval does not parse", () => {
    // The schema would have refused this on the way in; a caller building an
    // observation by hand can still produce it, and a silent `false` would look
    // like an expired state.
    const bad = { ...state("2026-09-01T00:00:00.000Z", null), validFrom: "not a date" };
    expect(() => holdsAt(bad, new Date("2026-09-02T00:00:00.000Z"))).toThrow(RangeError);
  });
});
