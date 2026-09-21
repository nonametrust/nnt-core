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
// The window is deliberately NOT the shipped 86,400,000 here. That number
// equals DAY_MS, so expiry computed from the wrong field would agree with
// expiry computed from the right one and no test would see it -- which is
// exactly what happened until review mutated it.
function aPolicy(over: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { ...RETENTION_V0, producerWindowMs: 7, ...over };
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
  //
  // Run under two zones on purpose, one far east and one far west, because
  // this author's machine is UTC+3 and a test written only for it does not
  // hold on a CI runner at UTC: review found that a local YEAR getter
  // survives at UTC and in New York and dies only east of Greenwich. A rule
  // that holds only on the machine that wrote it is not held.
  it("is UTC in every zone the process might run in", () => {
    const was = process.env.TZ;
    try {
      for (const zone of ["UTC", "Etc/GMT-14", "Etc/GMT+12", "America/New_York"]) {
        process.env.TZ = zone;
        // 2026-10-01T00:30Z is already October everywhere east of UTC and
        // still September west of it; UTC says October.
        expect(periodOf(new Date("2026-10-01T00:30:00.000Z")), zone).toBe("2026-10-01");
        expect(periodOf(new Date("2026-09-30T23:30:00.000Z")), zone).toBe("2026-09-01");
        // The year boundary, which the month boundary does not cover: a local
        // read of the YEAR alone files this under 2027 east of Greenwich
        // while the month still reads December.
        expect(periodOf(new Date("2026-12-31T23:30:00.000Z")), zone).toBe("2026-12-01");
        expect(periodOf(new Date("2027-01-01T00:30:00.000Z")), zone).toBe("2027-01-01");
      }
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
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

  // Month 00 and month 13 both parse and both produce a real date through
  // Date.UTC, which normalises them into the neighbouring year. That is the
  // silent "January under December's key" this card's cost line names, so it
  // is refused by name rather than normalised.
  it("refuses a month outside 01 to 12 rather than rolling it into another year", () => {
    for (const bad of ["2026-00-01", "2026-13-01"]) {
      expect(() => periodCloses(bad), bad).toThrow(/month/);
    }
  });

  // Unanchored or loose on width, the pattern reads a year out of a longer
  // number and accepts a period with an instant glued to it.
  it("refuses a period that only contains a period", () => {
    for (const bad of ["12026-09-01", "2026-09-011", "2026-09-01T00:00:00Z", " 2026-09-01", "2026-9-01"]) {
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

  // The cap must admit the one delivery that exists, or it is a rule against
  // ourselves. The margin is stated as what it is -- 1.55x -- rather than as
  // a multiplier the constant happens to clear: an earlier version asserted
  // `> 646_890 * 1.5` beside a comment claiming an order of magnitude, which
  // is 6.5 million. The comment was wrong, and a test whose threshold is
  // chosen after the constant proves nothing.
  const A1_DELIVERY = 646_890;
  it("admits the largest delivery measured to date, at the margin the comment claims", () => {
    expect(RETENTION_V0.producerMaxObservations).toBeGreaterThan(A1_DELIVERY);
    const margin = RETENTION_V0.producerMaxObservations / A1_DELIVERY;
    expect(margin).toBeGreaterThan(1.5);
    expect(margin).toBeLessThan(2);
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
      // The field is a literal type, so only a cast can produce this -- and a
      // cast is exactly how a future policy version would arrive with a
      // period this arithmetic does not implement.
      [{ period: "rolling-30-days" } as unknown as Partial<RetentionPolicy>, /period/],
    ];
    for (const [over, pattern] of cases) {
      expect(() => assertRetentionPolicy(aPolicy(over)), JSON.stringify(over)).toThrow(pattern);
    }
  });

  it("accepts a zero grace, because expiring at the month's close is a policy and not a defect", () => {
    expect(() => assertRetentionPolicy(aPolicy({ graceDays: 0 }))).not.toThrow();
  });
});
