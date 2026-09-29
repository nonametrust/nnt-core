import { describe, it, expect, vi } from "vitest";
import {
  BaselineStale,
  Cancelled,
  ConstraintViolation,
  Deadlocked,
  NamespaceShredded,
  ObservationNotFound,
  PayloadExpired,
  TagRefreshStale,
} from "@nonametrust/store";
import { BRIEF_POLICY_V0, type BriefPolicy } from "./policy.js";
import {
  EngineTimeout,
  RETRYABLE_SQLSTATES,
  CANCELLED_SQLSTATES,
  classifyStoreFailure,
  isRetryable,
  retrying,
  tierUnderUnavailability,
  withStoreTimeout,
  RetriesExhausted,
} from "./availability.js";

// Task 7: R6, R7, R27's ceiling, R28.
//
// R7's SET IS MATCHED ON WHAT ARRIVES FROM A STORE CALL, not on the absence of a
// field, and the plan says why: a tagging `RangeError` has no SQLSTATE either. That
// is made structural here rather than argued -- `classifyStoreFailure` is only ever
// applied to the result of a store call, because the only thing that calls it wraps
// one.
//
// AND THE READS DO NOT MAP THEIR DRIVER ERRORS, which the plan did not know.
// Measured against the real cluster: `TagRepository.listLive` and
// `ObservationRepository.readClear` -- the brief's only two reads -- have no
// `mapPgError` call, so a lock timeout on the read path arrives as a raw
// `DatabaseError` carrying `code: "55P03"` and NEVER as `Cancelled`. The writes
// (`record`, `AuditChain.append`) do map. So every rule below is matched on BOTH the
// mapped class and the raw SQLSTATE, or it would hold on the write path only -- and
// for `Deadlocked` that would be R7's own failure arriving through a door R7 did not
// check.

/** A raw driver error, as `pg` really produces one. */
const driverError = (over: Record<string, unknown>): Error =>
  Object.assign(new Error(String(over["message"] ?? "driver")), over);

const POLICY: BriefPolicy = { ...BRIEF_POLICY_V0, mediumCeiling: 100, briefThreshold: 600 };

describe("classifyStoreFailure", () => {
  describe("names the condition for each of R7's three", () => {
    it("a connection that was refused, which carries no SQLSTATE", () => {
      // Measured: a port nothing listens on gives `code: "ECONNREFUSED"`.
      expect(classifyStoreFailure(driverError({ code: "ECONNREFUSED" }))).toBe("connection");
    });

    it("a connection that timed out", () => {
      // The plan records that a connect timeout carries "no `code` field at all".
      // Measured on this cluster it carries `ETIMEDOUT` -- so BOTH are admitted, and
      // neither is the discriminator. What makes it unavailable is that it arrived
      // from a store call carrying no SQLSTATE.
      expect(classifyStoreFailure(driverError({ code: "ETIMEDOUT" }))).toBe("connection");
      expect(classifyStoreFailure(driverError({}))).toBe("connection");
    });

    it("a statement the server cancelled, as the store's mapped class", () => {
      expect(classifyStoreFailure(new Cancelled("canceling statement"))).toBe("cancelled");
    });

    it("a statement the server cancelled, as the RAW sqlstate the read path really gives", () => {
      // The finding that shaped this module. `listLive` and `readClear` do not map, so
      // on the brief's read path this is the only form that ever arrives.
      for (const code of ["55P03", "57014"]) {
        expect(classifyStoreFailure(driverError({ code })), code).toBe("cancelled");
      }
    });

    it("a timeout the ENGINE set itself", () => {
      expect(classifyStoreFailure(new EngineTimeout("listLive exceeded 250ms"))).toBe(
        "engine_timeout",
      );
    });
  });

  describe("refuses to call a DEADLOCK unavailable (R7)", () => {
    it("as the store's mapped class", () => {
      // The first version of the plan put `Deadlocked` in the unavailable set and a
      // review caught it as a quiet reversal: 40P01 is mapped to `Deadlocked` precisely
      // so a caller can tell it from a constraint and RETRY. Running the tiered failure
      // policy on it throws away the one correct response.
      expect(classifyStoreFailure(new Deadlocked("deadlock detected"))).toBeNull();
    });

    it("as the RAW sqlstate, which is the only form the read path produces", () => {
      for (const code of ["40P01", "40001"]) {
        expect(classifyStoreFailure(driverError({ code })), code).toBeNull();
      }
    });
  });

  describe("refuses to call an ordinary refusal unavailable", () => {
    it.each([
      ["a constraint violation", new ConstraintViolation("dup", "23505", "trigger_event_pkey")],
      ["a stale baseline", new BaselineStale("stale")],
      ["a stale tag refresh", new TagRefreshStale("stale")],
      ["a shredded namespace", new NamespaceShredded("shredded")],
      ["an expired payload", new PayloadExpired("expired")],
      ["a missing observation", new ObservationNotFound("missing")],
    ])("%s", (_label, e) => {
      expect(classifyStoreFailure(e)).toBeNull();
    });

    it("a constraint sqlstate arriving raw", () => {
      for (const code of ["23505", "23503", "23514"]) {
        expect(classifyStoreFailure(driverError({ code })), code).toBeNull();
      }
    });

    it("a RangeError, which is what a bad value looks like and never a store outage", () => {
      expect(classifyStoreFailure(new RangeError("brief.amount must be non-negative"))).toBeNull();
    });
  });

  it("treats an unmapped sqlstate as a refusal and not as an outage", () => {
    // A SQLSTATE the store does not map still means the server answered. Calling that
    // unavailable would run the tiered policy on a database that is up.
    expect(classifyStoreFailure(driverError({ code: "42P01" }))).toBeNull();
  });

  it("holds the two sqlstate sets apart, and names them", () => {
    expect([...CANCELLED_SQLSTATES].sort()).toEqual(["55P03", "57014"]);
    expect([...RETRYABLE_SQLSTATES].sort()).toEqual(["23505", "40001", "40P01"]);
    for (const code of CANCELLED_SQLSTATES) {
      expect(RETRYABLE_SQLSTATES.has(code), `${code} is in both sets`).toBe(false);
    }
  });
});

describe("isRetryable (R28's set)", () => {
  it.each([
    ["a deadlock, mapped", new Deadlocked("deadlock")],
    ["a stale baseline", new BaselineStale("stale")],
    ["a stale tag refresh", new TagRefreshStale("stale")],
  ])("retries %s", (_label, e) => {
    expect(isRetryable(e)).toBe(true);
  });

  it("retries a deadlock arriving RAW, which the read path is the only source of", () => {
    expect(isRetryable(driverError({ code: "40P01" }))).toBe(true);
    expect(isRetryable(driverError({ code: "40001" }))).toBe(true);
  });

  it("retries the 23505 on the live-tag pair, and NOT every 23505", () => {
    // R28 names one unique key. A 23505 on the trigger's primary key is the wrapper's
    // "already landed" signal and retrying it would write nothing forever.
    expect(isRetryable(new ConstraintViolation("dup", "23505", "tag_one_live_per_pair"))).toBe(true);
    expect(isRetryable(new ConstraintViolation("dup", "23505", "trigger_event_pkey"))).toBe(false);
    expect(isRetryable(new ConstraintViolation("dup", "23505", null))).toBe(false);
  });

  it("does NOT retry an outage, which is the tiered policy's business", () => {
    expect(isRetryable(new Cancelled("cancelled"))).toBe(false);
    expect(isRetryable(driverError({ code: "ECONNREFUSED" }))).toBe(false);
    expect(isRetryable(new EngineTimeout("timeout"))).toBe(false);
  });

  it("does not retry an ordinary refusal", () => {
    expect(isRetryable(new NamespaceShredded("shredded"))).toBe(false);
    expect(isRetryable(new RangeError("bad input"))).toBe(false);
  });
});

describe("tierUnderUnavailability (R6, R27's ceiling)", () => {
  it("lets a LOW-risk intent proceed, and says it must be logged", () => {
    const out = tierUnderUnavailability("low", 1_000_000, POLICY);
    expect(out.decision).toBe("proceed");
    expect(out.code).toBe("STORE_UNAVAILABLE_PROCEEDED");
  });

  it("lets a MEDIUM-risk intent proceed under the ceiling", () => {
    expect(tierUnderUnavailability("medium", 99, POLICY).decision).toBe("proceed");
  });

  it("refuses a MEDIUM-risk intent AT the ceiling, so the bound is not an off-by-one", () => {
    // "under" is strict. At the ceiling the amount is not under it.
    expect(tierUnderUnavailability("medium", 100, POLICY).decision).toBe("refuse");
    expect(tierUnderUnavailability("medium", 101, POLICY).decision).toBe("refuse");
  });

  it("holds a HIGH-risk intent at any amount, including zero", () => {
    for (const amount of [0, 1, 99, 1_000_000]) {
      expect(tierUnderUnavailability("high", amount, POLICY).decision, String(amount)).toBe(
        "refuse",
      );
    }
  });

  it("takes the ceiling from the POLICY and not from the caller (design §6:281)", () => {
    // A caller supplying its own ceiling is a caller raising it, and degrading
    // availability is not a way to bypass the layer. The only way to move this bound
    // is to ship a policy, which the audit body's composite version then names.
    const generous = { ...POLICY, mediumCeiling: 500 };
    expect(tierUnderUnavailability("medium", 400, POLICY).decision).toBe("refuse");
    expect(tierUnderUnavailability("medium", 400, generous).decision).toBe("proceed");
  });

  it("carries a CODE and never a grade, because design §6 says error states are codes", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      const out = tierUnderUnavailability(tier, 1, POLICY);
      expect(out.code).toMatch(/^STORE_UNAVAILABLE_/);
      expect(["clear", "watch", "hold"]).not.toContain(out.code as unknown as string);
    }
  });

  it("refuses an amount it cannot compare, rather than proceeding on it", () => {
    // A NaN fails `<` and would come back as the SOFTEST answer from the worst input,
    // which is the failure `gradeFor` and `holdsAt` both refuse.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => tierUnderUnavailability("medium", bad, POLICY), String(bad)).toThrow(
        /unavailability amount must be a non-negative finite number/,
      );
    }
  });

  it("refuses a tier outside the vocabulary at runtime (R45)", () => {
    expect(() => tierUnderUnavailability("mid" as never, 1, POLICY)).toThrow(
      /unavailability riskTier must be one of low, medium, high/,
    );
  });
});

describe("withStoreTimeout (the engine's own timeout, R7's third condition)", () => {
  it("returns the value when the call finishes in time", async () => {
    await expect(withStoreTimeout(() => Promise.resolve(7), 1000, "listLive")).resolves.toBe(7);
  });

  it("raises an EngineTimeout naming the call and the bound", async () => {
    const never = () => new Promise<number>(() => {});
    await expect(withStoreTimeout(never, 20, "listLive")).rejects.toThrow(
      /listLive did not answer within 20ms/,
    );
    await expect(withStoreTimeout(never, 20, "listLive")).rejects.toBeInstanceOf(EngineTimeout);
  });

  it("classifies its own timeout as unavailable, which closes the loop", async () => {
    const e = await withStoreTimeout(() => new Promise<number>(() => {}), 20, "x").catch(
      (err: unknown) => err,
    );
    expect(classifyStoreFailure(e)).toBe("engine_timeout");
  });

  it("lets the call's OWN failure through unchanged, rather than reporting a timeout", async () => {
    const boom = new NamespaceShredded("shredded");
    await expect(withStoreTimeout(() => Promise.reject(boom), 1000, "dataKey")).rejects.toBe(boom);
  });

  it("clears its timer, so a fast call does not hold the process for its whole budget", async () => {
    // Held with fake timers, because the leak is invisible otherwise: a resolved call
    // with an uncleared 30-second timer passes every assertion about its VALUE and
    // keeps the event loop alive for thirty seconds. Deleting the `clearTimeout`
    // survived until this row existed.
    vi.useFakeTimers();
    try {
      await expect(withStoreTimeout(() => Promise.resolve(1), 30_000, "listLive")).resolves.toBe(1);
      expect(vi.getTimerCount(), "a timer is still pending after the call resolved").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer when the call FAILS too, not only when it succeeds", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        withStoreTimeout(() => Promise.reject(new NamespaceShredded("shredded")), 30_000, "dataKey"),
      ).rejects.toBeInstanceOf(NamespaceShredded);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a bound that is not a positive finite number", async () => {
    for (const bad of [0, -1, Number.NaN]) {
      await expect(
        withStoreTimeout(() => Promise.resolve(1), bad, "x"),
        String(bad),
      ).rejects.toThrow(/timeout budget must be a positive finite number/);
    }
  });
});

describe("retrying (R28's bound)", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const out = await retrying(
      async () => {
        calls += 1;
        return "ok";
      },
      { maxRetries: 3, label: "fold" },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a retryable failure and returns the success that follows", async () => {
    let calls = 0;
    const out = await retrying(
      async () => {
        calls += 1;
        if (calls < 3) throw new Deadlocked("deadlock");
        return "ok";
      },
      { maxRetries: 3, label: "fold" },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("makes at most maxRetries RETRIES, so the call count is bounded at one plus the bound", async () => {
    // An unbounded retry loop is a denial of service on ourselves, which is the
    // argument the producer cap already makes.
    //
    // THE ESCAPE HATCH IS WHAT MAKES THIS TESTABLE. An earlier version of this row
    // threw a retryable failure forever and waited for `RetriesExhausted`; with the
    // bound removed it did not go red, it HUNG -- vitest's test timeout aborted the
    // test while the promise kept spinning and kept the worker alive, so a mutation
    // run could not tell "unbounded" from "slow". A test cannot measure an infinite
    // loop by waiting for it.
    //
    // So the stub stops being retryable after ten calls. A correct bound never reaches
    // the hatch; an unbounded loop hits it and comes back as the WRONG error, fast.
    let calls = 0;
    await expect(
      retrying(
        async () => {
          calls += 1;
          if (calls > 10) throw new NamespaceShredded("escape hatch: the loop is unbounded");
          throw new Deadlocked("deadlock");
        },
        { maxRetries: 2, label: "fold" },
      ),
    ).rejects.toBeInstanceOf(RetriesExhausted);
    expect(calls, "the bound was not honoured").toBe(3);
  });

  it("records the code and the subject on an exhausted retry, and not the message", async () => {
    // R21: a refusal is recorded as a code and an observation id, never as the message
    // -- `surpriseOf`'s RangeError carries the observed VALUE, and an audit body
    // outlives every key.
    let calls = 0;
    const e = await retrying(
      async () => {
        calls += 1;
        // The escape hatch, as in the bound row above: without it an unbounded loop
        // hangs the runner instead of going red.
        if (calls > 10) throw new NamespaceShredded("escape hatch: the loop is unbounded");
        throw new Deadlocked("deadlock detected on relation tag, value 12345.678");
      },
      { maxRetries: 1, label: "fold", subject: "obs-1" },
    ).catch((err: unknown) => err as RetriesExhausted);

    expect(e.code).toBe("RETRIES_EXHAUSTED");
    expect(e.subject).toBe("obs-1");
    expect(e.attempts).toBe(2);
    expect(e.message).not.toContain("12345.678");
    expect(e.message).toContain("fold");
  });

  it("does NOT retry something outside the set, and raises it unchanged", async () => {
    let calls = 0;
    const boom = new NamespaceShredded("shredded");
    await expect(
      retrying(
        async () => {
          calls += 1;
          throw boom;
        },
        { maxRetries: 5, label: "fold" },
      ),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it("does NOT retry an outage, which the tiered policy answers instead", async () => {
    let calls = 0;
    await expect(
      retrying(
        async () => {
          calls += 1;
          throw new Cancelled("cancelled");
        },
        { maxRetries: 5, label: "fold" },
      ),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(calls).toBe(1);
  });

  it("refuses a bound that is not a positive integer, matching BriefPolicy.maxRetries", async () => {
    for (const bad of [0, -1, 2.5]) {
      await expect(
        retrying(async () => "ok", { maxRetries: bad, label: "x" }),
        String(bad),
      ).rejects.toThrow(/maxRetries must be a positive integer/);
    }
  });

  it("keeps the last failure as the cause, so the exhausted code is diagnosable", async () => {
    const last = new Deadlocked("the last one");
    let calls = 0;
    const e = await retrying(
      async () => {
        calls += 1;
        if (calls > 10) throw new NamespaceShredded("escape hatch: the loop is unbounded");
        throw last;
      },
      { maxRetries: 1, label: "fold" },
    ).catch((err: unknown) => err as RetriesExhausted);
    expect(e.cause).toBe(last);
  });
});
