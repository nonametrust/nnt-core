import { describe, it, expect } from "vitest";
import {
  RETENTION_V0,
  assertRetentionPolicy,
  expiresAt,
  periodCloses,
  periodOf,
  type RetentionPolicy,
} from "./retention.js";

// Every test that reads a policy field overrides it with a number no other
// field shares, so a function reading the wrong field would show rather than
// happen to agree.
function aPolicy(over: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { ...RETENTION_V0, ...over };
}

describe("the period", () => {
  // The period is the calendar month of `ingestedAt`, not of `datedAt`: a
  // state has no dated instant at all, and a backfill keyed on the event's
  // month would be born expired, which contradicts the rule that no
  // observation is dropped at write time.
  it("is the UTC calendar month of the instant, rendered as its first day", () => {
    expect(periodOf(new Date("2026-09-21T23:59:59.999Z"))).toBe("2026-09-01");
    expect(periodOf(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });

  // UTC and not the process's zone. East of UTC the last hours of a month
  // are already the next month locally, and a machine that filed them under
  // the wrong key would put them beyond a shred that did not cover them.
  it("is UTC, so an instant local midnight would move does not move", () => {
    // 2026-10-01T00:30Z is 03:30 on 1 October in UTC+3 and 20:30 on
    // 30 September in UTC-4. Both must read October.
    expect(periodOf(new Date("2026-10-01T00:30:00.000Z"))).toBe("2026-10-01");
    expect(periodOf(new Date("2026-09-30T23:30:00.000Z"))).toBe("2026-09-01");
    // And the year boundary, which the month boundary above does not cover:
    // 2026-12-31T23:30Z is 02:30 on 1 January 2027 in UTC+3, so a local read
    // of the YEAR alone would file this under 2027 while the month still
    // read December. Kerem's machine is UTC+3, so without this a half-local
    // implementation passes here and files January under December's key in
    // production.
    expect(periodOf(new Date("2026-12-31T23:30:00.000Z"))).toBe("2026-12-01");
  });

  it("closes at the first instant of the following month, and December rolls the year", () => {
    expect(periodCloses("2026-09-01").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodCloses("2026-12-01").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("handles a leap February and a short month", () => {
    expect(periodOf(new Date("2028-02-29T12:00:00.000Z"))).toBe("2028-02-01");
    expect(periodCloses("2028-02-01").toISOString()).toBe("2028-03-01T00:00:00.000Z");
    expect(periodCloses("2026-02-01").toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("refuses an instant that is not one, and a period that is not a first-of-month", () => {
    expect(() => periodOf(new Date(Number.NaN))).toThrow(RangeError);
    for (const bad of ["2026-09", "2026-09-02", "not-a-date", ""]) {
      expect(() => periodCloses(bad), bad).toThrow(RangeError);
    }
  });
});

describe("expiry", () => {
  // Expiry is derived from the period and the policy alone. It takes no
  // clock: a backfill of last year must expire ninety days after last year's
  // month closed, not ninety days after the day it was loaded.
  it("is the policy's grace after the month closes, and reads no clock", () => {
    // March closes at 1 April; ninety days on is 30 June, not 1 July --
    // April 30 + May 31 + June 29. Checked against a calendar rather than
    // assumed, because an off-by-one here shreds a month a day early.
    const at = expiresAt("2025-03-01", aPolicy({ graceDays: 90 }));
    expect(at.toISOString()).toBe("2025-06-30T00:00:00.000Z");
  });

  it("moves with the policy's grace rather than with a constant", () => {
    const short = expiresAt("2026-09-01", aPolicy({ graceDays: 1 }));
    expect(short.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    const none = expiresAt("2026-09-01", aPolicy({ graceDays: 0 }));
    expect(none.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("the v0 policy", () => {
  // Each number is declared with its source rather than invented, and this
  // test is where the sources are pinned. The cap in particular: "ten
  // thousand an hour" would have refused the A1 backfill sixty times over
  // and turned our own indexer into a denial of service, so it is sized by a
  // written rule against the one delivery that exists.
  it("declares the four inputs with the values their sources give", () => {
    expect(RETENTION_V0).toEqual({
      version: "retention-v0",
      graceDays: 90,
      period: "calendar-month-utc",
      producerWindowMs: 86_400_000,
      producerMaxObservations: 1_000_000,
    });
  });

  it("is a value: nothing can edit it for the next computation", () => {
    expect(Object.isFrozen(RETENTION_V0)).toBe(true);
  });

  // The measured delivery the cap is sized against: 646,890 observations for
  // 100 accounts over 31 days, its busiest account 187,313. Both must pass in
  // one window with an order of magnitude to spare, or the cap is a rule
  // against ourselves.
  it("admits the largest delivery measured to date, with room", () => {
    expect(RETENTION_V0.producerMaxObservations).toBeGreaterThan(646_890);
    expect(RETENTION_V0.producerMaxObservations).toBeGreaterThan(646_890 * 1.5);
  });
});

describe("assertRetentionPolicy", () => {
  it("accepts the declared policy", () => {
    expect(() => assertRetentionPolicy(RETENTION_V0)).not.toThrow();
  });

  // Named one by one: a policy refused by a message that does not say which
  // field is a policy nobody can fix.
  it("refuses each bad field by name", () => {
    const cases: Array<[Partial<RetentionPolicy>, RegExp]> = [
      [{ version: "" }, /version/],
      [{ version: "   " }, /version/],
      [{ graceDays: -1 }, /graceDays/],
      [{ graceDays: 1.5 }, /graceDays/],
      [{ producerWindowMs: 0 }, /producerWindowMs/],
      [{ producerWindowMs: -1 }, /producerWindowMs/],
      [{ producerMaxObservations: 0 }, /producerMaxObservations/],
      [{ producerMaxObservations: 1.5 }, /producerMaxObservations/],
    ];
    for (const [over, pattern] of cases) {
      expect(() => assertRetentionPolicy(aPolicy(over)), JSON.stringify(over)).toThrow(pattern);
    }
  });

  it("accepts a zero grace, because expiring at the month's close is a policy and not a defect", () => {
    expect(() => assertRetentionPolicy(aPolicy({ graceDays: 0 }))).not.toThrow();
  });
});
