import { describe, it, expect } from "vitest";
import { fixedClock, systemClock } from "./clock.js";

describe("fixedClock", () => {
  it("does not move on its own", () => {
    const c = fixedClock(new Date("2026-09-08T00:00:00.000Z"));
    expect(c.now().getTime()).toBe(c.now().getTime());
  });

  it("advances by exactly what it is told", () => {
    const c = fixedClock(new Date("2026-09-08T00:00:00.000Z"));
    c.advance(30 * 24 * 60 * 60 * 1000);
    expect(c.now().toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  it("hands out a copy, so mutating the answer does not move the clock", () => {
    const c = fixedClock(new Date("2026-09-08T00:00:00.000Z"));
    c.now().setFullYear(2000);
    expect(c.now().toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });
});

describe("systemClock", () => {
  // The one permitted Date.now() in this package.
  it("returns a date near now", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
