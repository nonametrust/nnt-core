import { describe, it, expect } from "vitest";
import { GRADES, gradeFor, type Grade } from "./grade.js";

// What produces each of the three grades.
//
// §7 rules the vocabulary -- `clear | watch | hold` -- provisionally, and records
// that `hold` is the only value any document names. NOTHING ANYWHERE SAID WHAT
// PRODUCES `watch`, which review called the largest unruled number in the plan.
// It is ruled here, and it needs no number:
//
//   hold   the amount is at or above the threshold
//   watch  it is not, and at least one reason cleared the relatedness floor
//   clear  it is not, and nothing did
//
// The alternative was a fraction of the threshold, which would have needed a
// tenth uncalibrated field with no measurement behind it. This rule reuses two
// things already ruled -- the threshold by R3, R4 and R27, the reasons by R12 and
// `relatednessFloor` -- and says something a caller can act on: there IS evidence
// about this counterparty and your amount is below the bar. A fraction would only
// have said "your amount is largish", which the caller already knew.

describe("gradeFor", () => {
  it("holds at or above the threshold, whatever the evidence", () => {
    // `hold` is the amount's answer. Evidence lowered the threshold before this
    // point (R4); once the amount clears it, the count of reasons cannot un-hold it.
    expect(gradeFor({ amount: 2500, threshold: 480, reasonCount: 1 })).toBe("hold");
    expect(gradeFor({ amount: 480, threshold: 480, reasonCount: 0 })).toBe("hold");
    expect(gradeFor({ amount: 480, threshold: 480, reasonCount: 9 })).toBe("hold");
  });

  it("watches below the threshold when there is a reason", () => {
    expect(gradeFor({ amount: 100, threshold: 600, reasonCount: 1 })).toBe("watch");
    expect(gradeFor({ amount: 599.99, threshold: 600, reasonCount: 3 })).toBe("watch");
  });

  it("clears below the threshold with no reason, and that is not a reassurance", () => {
    // R29 ruled that a first-ever brief grades `clear` on NO EVIDENCE, because a
    // counterparty seen for the first time has no tags and a cold baseline computes
    // no surprise. That sentence belongs in the README, and this rule is what makes
    // it exact rather than approximate: `clear` means "nothing crossed", never
    // "nothing happened".
    expect(gradeFor({ amount: 100, threshold: 600, reasonCount: 0 })).toBe("clear");
    expect(gradeFor({ amount: 0, threshold: 600, reasonCount: 0 })).toBe("clear");
  });

  it("is MONOTONE in the amount: raising it never softens the grade", () => {
    // The property, not an example. A grade that could move backwards as the amount
    // rose would be a grade a caller could game by asking for more.
    const rank = (g: Grade): number => GRADES.indexOf(g);
    let previous = -1;
    for (const amount of [0, 1, 100, 479, 480, 481, 5000]) {
      const current = rank(gradeFor({ amount, threshold: 480, reasonCount: 1 }));
      expect(current, `amount ${amount} softened the grade`).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("is MONOTONE in the evidence: adding a reason never softens the grade", () => {
    const rank = (g: Grade): number => GRADES.indexOf(g);
    let previous = -1;
    for (const reasonCount of [0, 1, 2, 40]) {
      const current = rank(gradeFor({ amount: 100, threshold: 600, reasonCount }));
      expect(current, `${reasonCount} reasons softened the grade`).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("orders the vocabulary from least to most concerned, and says so once", () => {
    // `GRADES` is the order, declared once, so the monotonicity tests above and any
    // caller comparing two grades read it from the same place.
    expect(GRADES).toEqual(["clear", "watch", "hold"]);
  });

  it("refuses an amount or a threshold that is not a finite number", () => {
    // A NaN amount fails `>=` and would come back as `clear` or `watch` -- the
    // softest answer, produced by the worst input. Refused by name instead, the way
    // `holdsAt` refuses an invalid instant rather than reporting "does not hold".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => gradeFor({ amount: bad, threshold: 600, reasonCount: 0 }), `amount ${bad}`)
        .toThrow(RangeError);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(() => gradeFor({ amount: 100, threshold: bad, reasonCount: 0 }), `threshold ${bad}`)
        .toThrow(RangeError);
    }
  });

  it("refuses a reason count that is not a non-negative integer", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => gradeFor({ amount: 100, threshold: 600, reasonCount: bad }), `count ${bad}`)
        .toThrow(RangeError);
    }
  });

  it("admits an amount of zero, because a zero-value intent is a real intent", () => {
    // Not every intent moves value; a protocol call can be briefed too. Zero is a
    // legitimate amount and only a NEGATIVE one is a caller defect.
    expect(gradeFor({ amount: 0, threshold: 600, reasonCount: 1 })).toBe("watch");
  });
});
