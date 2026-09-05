/**
 * Time enters the store through this interface and through no other route.
 * `Date.now()` does not appear in this package outside clock.test.ts: the
 * day-12 / day-21 scenario runs twenty-one simulated days in milliseconds,
 * which is impossible if any component reads the wall clock directly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FixedClock extends Clock {
  advance(ms: number): void;
}

export function fixedClock(start: Date): FixedClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}
