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
  reportUnavailable,
  type UnavailabilityReport,
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

    it("a TypeError, which a programming fault inside a repository really produces", () => {
      // Narrowing the branch to `RangeError` alone SURVIVED. The comment claimed a value
      // error "never reaches here on the real path" -- but a `TypeError` thrown INSIDE a
      // repository does come out of a store call, and under that mutant it became a
      // connection outage: the tiered policy against a database that is up.
      expect(classifyStoreFailure(new TypeError("x.y is not a function"))).toBeNull();
    });
  });

  it("treats an unmapped sqlstate as a refusal when the server answered ABOUT THE QUERY", () => {
    // A SQLSTATE that describes the statement means the server is up and said what was
    // wrong with what it was asked. Calling that unavailable would run the tiered
    // policy on a database that is up.
    for (const code of ["42P01", "22P02", "23502", "P0001"]) {
      expect(classifyStoreFailure(driverError({ code })), code).toBeNull();
    }
  });

  describe("a sqlstate whose whole meaning is THE SERVER IS UNAVAILABLE", () => {
    // THE DEFECT THIS CLOSES, and a review measured it live: `pg_terminate_backend` on
    // a blocked backend gives `57P01`, which classified as a REFUSAL. The ledger's
    // justification -- "the server answered, which is the opposite of an outage" -- is
    // false for exactly these classes: **the server answered to say it is
    // unavailable**. The tiered policy would never have run on a database that was
    // restarting, full, shutting down, or dropping the connection.

    it.each([
      ["57P01 admin_shutdown, the terminated backend", "57P01"],
      ["57P02 crash_shutdown", "57P02"],
      ["57P03 cannot_connect_now, the canonical restart error", "57P03"],
      ["57P05 idle_session_timeout", "57P05"],
      ["08006 connection_failure", "08006"],
      ["08001 unable_to_establish", "08001"],
      ["08P01 protocol_violation", "08P01"],
      ["53300 too_many_connections", "53300"],
      ["53100 disk_full", "53100"],
      ["53200 out_of_memory", "53200"],
      ["XX000 internal_error", "XX000"],
    ])("%s is a connection outage", (_label, code) => {
      expect(classifyStoreFailure(driverError({ code }))).toBe("connection");
    });

    it("does not swallow the query-cancelled codes, which keep their own condition", () => {
      // 57014 is in class 57 too, and it is a CANCELLED statement rather than an outage.
      // A class-wide rule that took the whole 57 class would have lost that distinction.
      expect(classifyStoreFailure(driverError({ code: "57014" }))).toBe("cancelled");
      expect(classifyStoreFailure(driverError({ code: "55P03" }))).toBe("cancelled");
    });

    it("is not retried, because an outage is the tiered policy's business", () => {
      expect(isRetryable(driverError({ code: "57P01" }))).toBe(false);
      expect(isRetryable(driverError({ code: "53300" }))).toBe(false);
    });
  });

  describe("a libuv code that is five uppercase characters", () => {
    // The second defect the same review measured. `EPIPE` is what a write to a socket
    // the server already closed produces -- a dead connection -- and the shape regex
    // `/^[0-9A-Z]{5}$/` matched it, so it was read as a SQLSTATE and classified as a
    // refusal. The docstring claimed "a libuv error code is not five characters".
    //
    // The discriminator is a DIGIT: every real Postgres SQLSTATE contains one (the
    // subclass is three characters and always carries digits, `XX000` and `HV00L`
    // included) and no libuv code does.
    it.each(["EPIPE", "EBADF", "EBUSY", "EPERM", "EINTR", "ENXIO", "EROFS", "EXDEV", "EFBIG"])(
      "%s is a connection outage, not a sqlstate",
      (code) => {
        expect(classifyStoreFailure(driverError({ code }))).toBe("connection");
      },
    );

    it("still reads a real sqlstate that is mostly letters", () => {
      expect(classifyStoreFailure(driverError({ code: "XX000" }))).toBe("connection");
      expect(classifyStoreFailure(driverError({ code: "P0001" }))).toBeNull();
    });
  });

  describe("an exhausted retry is R7's FOURTH condition", () => {
    // G15's row is titled "the four unavailable conditions" and R7 says "only an
    // exhausted retry becomes unavailable". There were three, and `RetriesExhausted`
    // fell through to `connection` -- so an exhausted deadlock retry, against a server
    // that answered every single time, would have been written to stderr as a
    // connection outage.
    it("is named as itself and not as a connection", () => {
      expect(classifyStoreFailure(new RetriesExhausted("fold", 3, "obs-1"))).toBe(
        "retries_exhausted",
      );
    });

    it("is not retried again", () => {
      expect(isRetryable(new RetriesExhausted("fold", 3, "obs-1"))).toBe(false);
    });
  });

  describe("something that is not an Error at all", () => {
    // A thrown string, number or null is a programming fault, not an outage. Reporting
    // it as one would send the tiered policy after a healthy database because a
    // caller threw the wrong thing.
    it.each([["a string", "boom"], ["a number", 42], ["null", null], ["undefined", undefined]])(
      "%s is not classified as an outage",
      (_label, thrown) => {
        expect(classifyStoreFailure(thrown)).toBeNull();
      },
    );
  });

  it("holds the two sqlstate sets apart, names them, and USES them", () => {
    expect([...CANCELLED_SQLSTATES].sort()).toEqual(["55P03", "57014"]);
    // 23505 is NOT here. It used to be, and a review measured that the whole set was
    // read by nothing -- emptying it turned red only the row asserting its own
    // contents. It is retryable on ONE constraint, which a SQLSTATE cannot say.
    expect([...RETRYABLE_SQLSTATES].sort()).toEqual(["40001", "40P01"]);
    for (const code of CANCELLED_SQLSTATES) {
      expect(RETRYABLE_SQLSTATES.has(code), `${code} is in both sets`).toBe(false);
    }
    // Each set is read by the function that claims it, so emptying either changes an
    // ANSWER and not only this row.
    for (const code of RETRYABLE_SQLSTATES) {
      expect(isRetryable(driverError({ code })), `${code} must be retried`).toBe(true);
    }
    for (const code of CANCELLED_SQLSTATES) {
      expect(classifyStoreFailure(driverError({ code })), code).toBe("cancelled");
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

  it("does not retry a RAW 23505 either, which the mapped rule alone did not cover", () => {
    // The module's thesis is "every rule is matched on BOTH the mapped class and the
    // raw SQLSTATE", and for 23505 it was not: adding `|| sqlstate === "23505"` to the
    // raw branch SURVIVED. The constraint name is what makes a 23505 retryable and a
    // bare SQLSTATE cannot carry one, so the raw form is never retried.
    expect(isRetryable(driverError({ code: "23505" }))).toBe(false);
    expect(isRetryable(driverError({ code: "23505", constraint: "tag_one_live_per_pair" }))).toBe(
      false,
    );
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

describe("reportUnavailable (R7's structured stderr)", () => {
  const captured: string[] = [];
  const write = (line: string): void => void captured.push(line);
  const AT = new Date("2026-09-21T00:00:00.000Z");

  it("writes ONE structured line a machine can read", () => {
    captured.length = 0;
    const decision = tierUnderUnavailability("low", 1, POLICY);
    reportUnavailable("connection", "low", decision, AT, "obs-1", write);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.endsWith("\n"), "not newline-terminated").toBe(true);
    expect(JSON.parse(captured[0]!)).toEqual({
      event: "engine.store.unavailable",
      at: "2026-09-21T00:00:00.000Z",
      condition: "connection",
      decision: "proceed",
      code: "STORE_UNAVAILABLE_PROCEEDED",
      riskTier: "low",
      subject: "obs-1",
    });
  });

  it("is what makes 'low proceeds AND LOGS' a testable sentence", () => {
    // The plan's acceptance for Task 7 and G16's third planted violation both name a
    // log line that did not exist, so the plant could not be run at all.
    captured.length = 0;
    reportUnavailable("cancelled", "low", tierUnderUnavailability("low", 1, POLICY), AT, null, write);
    const line = JSON.parse(captured[0]!) as UnavailabilityReport;
    expect(line.riskTier).toBe("low");
    expect(line.decision).toBe("proceed");
  });

  it("records each of the four conditions by name", () => {
    for (const condition of ["connection", "cancelled", "engine_timeout", "retries_exhausted"] as const) {
      captured.length = 0;
      reportUnavailable(condition, "high", tierUnderUnavailability("high", 1, POLICY), AT, null, write);
      expect((JSON.parse(captured[0]!) as UnavailabilityReport).condition, condition).toBe(condition);
    }
  });

  it("carries NO message, because a message can carry an observed value (R21)", () => {
    captured.length = 0;
    reportUnavailable(
      "connection",
      "medium",
      tierUnderUnavailability("medium", 1, POLICY),
      AT,
      "obs-9",
      write,
    );
    const keys = Object.keys(JSON.parse(captured[0]!) as object).sort();
    expect(keys).toEqual(["at", "code", "condition", "decision", "event", "riskTier", "subject"]);
    for (const forbidden of ["message", "cause", "stack", "error", "detail"]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it("writes the refusal too, so an outage is never silent whichever way it went", () => {
    captured.length = 0;
    reportUnavailable("connection", "high", tierUnderUnavailability("high", 5, POLICY), AT, null, write);
    const line = JSON.parse(captured[0]!) as UnavailabilityReport;
    expect(line.decision).toBe("refuse");
    expect(line.code).toBe("STORE_UNAVAILABLE_REFUSED");
  });
});

describe("withStoreTimeout (the engine's own timeout, R7's third condition)", () => {
  it("returns the value when the call finishes in time", async () => {
    await expect(withStoreTimeout(() => Promise.resolve(7), 1000, "listLive")).resolves.toBe(7);
  });

  it("waits the WHOLE budget and not a fraction of it", async () => {
    // THE BUDGET VALUE WAS HELD BY NOTHING. A review replaced `budgetMs` with
    // `budgetMs / 2`, with `budgetMs / 10`, and with `0` -- all three SURVIVED the
    // entire suite. Every "times out" row used a promise that never resolves, so any
    // positive timer wins, and every "in time" row used an already-resolved promise or
    // a sub-millisecond localhost query, so any timer loses.
    //
    // The consequence is the one the module's own docstring says the pass-through
    // exists to prevent: a timer firing at a tenth of its budget classifies HEALTHY
    // store calls as `engine_timeout` under any real latency, and the tiered policy
    // then runs against a database that is up.
    //
    // Fake timers make the boundary observable: at one millisecond BEFORE the budget
    // nothing has rejected, and at the budget it has.
    vi.useFakeTimers();
    try {
      let settled: "pending" | "rejected" = "pending";
      const pending = withStoreTimeout(() => new Promise<number>(() => {}), 5_000, "listLive");
      const watched = pending.then(
        () => undefined,
        () => {
          settled = "rejected";
        },
      );

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled, "rejected before its budget was spent").toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      await watched;
      expect(settled, "did not reject when the budget ran out").toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire EARLY for a call that answers just inside the budget", async () => {
    // The other side of the same boundary, and the one a shortened timer breaks: a
    // store call that answers at 90% of its budget must succeed.
    vi.useFakeTimers();
    try {
      const call = (): Promise<string> =>
        new Promise((resolve) => setTimeout(() => resolve("answered"), 4_500));
      const raced = withStoreTimeout(call, 5_000, "listLive");
      await vi.advanceTimersByTimeAsync(4_500);
      await expect(raced).resolves.toBe("answered");
    } finally {
      vi.useRealTimers();
    }
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

  it("refuses a bound above the largest delay a timer honours", async () => {
    // Node's timer takes a 32-bit delay: above 2^31-1 it warns and fires after ONE
    // millisecond, so the largest budget behaves like the smallest. Measured at
    // 2_147_483_648, which raised its timeout after 2ms while claiming to wait 24 days.
    await expect(
      withStoreTimeout(() => Promise.resolve(1), 2_147_483_648, "listLive"),
    ).rejects.toThrow(/timeout budget must be at most 2147483647ms/);
    // And the largest honoured value is still accepted.
    await expect(withStoreTimeout(() => Promise.resolve(1), 2_147_483_647, "x")).resolves.toBe(1);
  });

  it("refuses a bound that is not a positive finite number", async () => {
    // `Infinity` is in the list because it was not, and a review replaced
    // `Number.isFinite` with `Number.isNaN` and SURVIVED. Node clamps any delay above
    // 2^31-1 to one millisecond, so an infinite budget is a one-millisecond timeout --
    // the shortened-timer defect in its worst form, reachable from a config value.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
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
