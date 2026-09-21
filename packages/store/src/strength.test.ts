import { describe, it, expect } from "vitest";
import { strengthAt } from "./strength.js";
import type { StoredTag } from "./repositories/tag.js";

const DAY = 24 * 60 * 60 * 1000;
const base: StoredTag = {
  tagId: "t", namespaceId: "n", observationId: "o", channel: "address_integrity",
  aspect: "transition",
  g0: 1, taggedAt: new Date("2026-09-12T00:00:00.000Z"),
  refreshCount: 0, saturationState: "open", suppressionFactor: 1,
  retiredAt: null,
};

describe("strengthAt", () => {
  it("is g0 at the instant of tagging", () => {
    expect(strengthAt(base, base.taggedAt, 7 * DAY)).toBeCloseTo(1, 12);
  });

  it("halves after one half-life", () => {
    expect(strengthAt(base, new Date("2026-09-19T00:00:00.000Z"), 7 * DAY)).toBeCloseTo(0.5, 12);
  });

  // Day twelve to day twenty-one is the whitepaper's scenario. A tag opened on
  // day twelve must still be readable on day twenty-one.
  it("is still positive nine days on, which the day-12 to day-21 scenario needs", () => {
    const s = strengthAt(base, new Date("2026-09-21T00:00:00.000Z"), 7 * DAY);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.5);
  });

  it("does not exceed g0 before the tag existed", () => {
    expect(strengthAt(base, new Date("2026-09-01T00:00:00.000Z"), 7 * DAY)).toBeCloseTo(1, 12);
  });

  it("falls faster under suppression, and suppression is the only way it falls faster", () => {
    const instant = new Date("2026-09-19T00:00:00.000Z");
    const plain = strengthAt(base, instant, 7 * DAY);
    const suppressed = strengthAt({ ...base, suppressionFactor: 4 }, instant, 7 * DAY);
    expect(suppressed).toBeLessThan(plain);
    expect(suppressed).toBeCloseTo(Math.pow(0.5, 4), 12);
  });

  // The brief put this at a factor of 100 over a year, which is 0.5^5214 and
  // below what a double can hold; see the boundary test below. Sixty days at
  // the same factor is 0.5^857, around 1e-258, and is the same claim at a
  // point the arithmetic can represent.
  it("is still positive at a factor of 100 over sixty days, which is 0.5^857", () => {
    expect(
      strengthAt({ ...base, suppressionFactor: 100 }, new Date("2026-11-11T00:00:00.000Z"), 7 * DAY),
    ).toBeGreaterThan(0);
  });

  // The exponential never reaches zero; a double does, once the exponent
  // passes about 1074 half-lives of suppressed time. That is a floor of the
  // representation and not a deletion: nothing was written, the row is as it
  // was, and the value is derived from it at every read. Pinned so that the
  // boundary is a known number and so that nobody "fixes" it later with a
  // clamp to a positive constant, which would be a strength that is not a
  // function of the stored tag.
  it("reads as exactly zero past the double's floor, which is where the representation ends and not where the tag does", () => {
    const halfLife = 7 * DAY;
    const at = (halfLives: number) =>
      strengthAt(base, new Date(base.taggedAt.getTime() + halfLives * halfLife), halfLife);
    expect(at(1000)).toBeGreaterThan(0);
    expect(at(1100)).toBe(0);
  });

  it("refuses a non-positive half-life rather than dividing by zero", () => {
    expect(() => strengthAt(base, base.taggedAt, 0)).toThrow(RangeError);
    expect(() => strengthAt(base, base.taggedAt, -1)).toThrow(RangeError);
    expect(() => strengthAt(base, base.taggedAt, Number.NaN)).toThrow(RangeError);
  });

  // A strength of NaN compares false against every threshold, so an invalid
  // instant would read as "below threshold" with no error anywhere.
  it("refuses an invalid instant rather than returning NaN", () => {
    expect(() => strengthAt(base, new Date("not a date"), 7 * DAY)).toThrow(RangeError);
    expect(() => strengthAt({ ...base, taggedAt: new Date(Number.NaN) }, base.taggedAt, 7 * DAY))
      .toThrow(RangeError);
  });

  it("is a pure function of its arguments", () => {
    const instant = new Date("2026-09-19T00:00:00.000Z");
    expect(strengthAt(base, instant, 7 * DAY)).toBe(strengthAt(base, instant, 7 * DAY));
  });

  // Not in the brief. The suppression test above pins one factor at one
  // instant; this pins the shape of the claim that suppression is the same
  // curve run faster: a factor of k at elapsed t is the plain curve at k*t,
  // which is what "multiplies elapsed time" means and what a subtraction from
  // g0 would not satisfy.
  it("under a factor of k is the plain curve read k times further along", () => {
    const factor = 3;
    const suppressed = strengthAt(
      { ...base, suppressionFactor: factor }, new Date(base.taggedAt.getTime() + 2 * DAY), 7 * DAY,
    );
    const plainLater = strengthAt(base, new Date(base.taggedAt.getTime() + factor * 2 * DAY), 7 * DAY);
    expect(suppressed).toBeCloseTo(plainLater, 12);
  });

  it("scales with g0, so a weaker tag is the same curve lower down", () => {
    const instant = new Date("2026-09-19T00:00:00.000Z");
    expect(strengthAt({ ...base, g0: 0.4 }, instant, 7 * DAY)).toBeCloseTo(0.2, 12);
  });
});
