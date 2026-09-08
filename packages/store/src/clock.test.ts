import { describe, it, expect } from "vitest";
import { fixedClock, systemClock } from "./clock.js";

describe("fixedClock", () => {
  it("does not move on its own", () => {
    const c = fixedClock(new Date("2026-09-07T00:00:00.000Z"));
    const a = c.now();
    const b = c.now();
    expect(b.getTime()).toBe(a.getTime());
  });

  it("advances by exactly what it is told, so twenty-one days cost nothing", () => {
    const c = fixedClock(new Date("2026-09-07T00:00:00.000Z"));
    c.advance(21 * 24 * 60 * 60 * 1000);
    expect(c.now().toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("hands out a copy, so a caller cannot move the clock by mutating its answer", () => {
    const c = fixedClock(new Date("2026-09-07T00:00:00.000Z"));
    c.now().setFullYear(2000);
    expect(c.now().toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });
});

describe("systemClock", () => {
  // This file is the one place in the package permitted to call Date.now(),
  // and only to check systemClock against it.
  it("returns a date near now", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
