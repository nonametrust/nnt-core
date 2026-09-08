/**
 * Time enters the indexer through this interface and through no other route.
 * `Date.now()` appears in this package only in clock.test.ts, so a test can
 * run a thirty-day backfill against a fake source in milliseconds and the
 * rate limiter can be proved without sleeping.
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
