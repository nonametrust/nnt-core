import { describe, it, expect } from "vitest";
import { CALIBRATION_V0, POLICY_V0 } from "@nonametrust/tagging";
import {
  ConstraintViolation,
  Deadlocked,
  fixedClock,
  RETENTION_V0,
  type AuditEntryInput,
  type ClearObservation,
  type RecordTriggerEvent,
  type StoredTag,
} from "@nonametrust/store";
import { BRIEF_POLICY_V0 } from "./policy.js";
import type { BriefReads } from "./brief.js";
import {
  AuditEntryMissing,
  runBrief,
  type BriefDeps,
  type BriefRequest,
  type BriefWrites,
} from "./run-brief.js";
import type { IdSource } from "./ids.js";

// The supported entry point: it reads `at` from the clock, mints the ids, and
// performs the effects the core returned. The core does none of those things.
//
// WHY THE `at === clock.now()` RULE IS HERE AND NOT IN THE CORE. `at` is an input
// to the core, which is what makes replay possible, and it is therefore PLANTABLE:
// measured with `at = now - 3d`, `TriggerEventRepository.record` bounds only the
// FUTURE (R34) and `AuditChain.append` stamps its own `occurredAt`, so the trigger
// landed at day 8 and the audit row at day 11 with no error at all. The rule that
// closes it is structural rather than a comparison: the replay entry point is the
// CORE, which is handed a read-only port and cannot write, and this wrapper never
// takes an `at` from its caller.

const NS = "11111111-0000-4000-8000-000000000001";
const INTENT_OBS = "22222222-0000-4000-8000-000000000001";
const START = new Date("2026-09-21T00:00:00.000Z");

const clear = (over: Partial<ClearObservation> & { observationId: string }): ClearObservation => ({
  namespaceId: NS,
  channel: "price",
  kind: "quote",
  evidenceKind: "wire",
  datedAt: null,
  ingestedAt: START,
  producer: "test",
  period: "2026-09-01",
  periodExpired: false,
  namespaceErased: false,
  ...over,
});

const request = (over: Partial<BriefRequest> = {}): BriefRequest => ({
  intent: { namespaceId: NS, channel: "price", aspect: "quoted/USDC" },
  observationId: INTENT_OBS,
  amount: 100,
  unit: "USDC",
  riskTier: "high",
  ownTagIds: [],
  surprise: null,
  policies: {
    retention: RETENTION_V0,
    tagging: POLICY_V0,
    calibration: CALIBRATION_V0,
    brief: BRIEF_POLICY_V0,
  },
  ...over,
});

interface Recorder extends BriefWrites {
  readonly calls: string[];
  readonly recorded: RecordTriggerEvent[];
  readonly appended: AuditEntryInput[];
}

function writes(
  fail: { record?: unknown; append?: unknown } = {},
): Recorder {
  const calls: string[] = [];
  const recorded: RecordTriggerEvent[] = [];
  const appended: AuditEntryInput[] = [];
  return {
    calls,
    recorded,
    appended,
    record: async (input: RecordTriggerEvent): Promise<void> => {
      calls.push("record");
      if (fail.record !== undefined) throw fail.record;
      recorded.push(input);
    },
    append: async (input: AuditEntryInput): Promise<void> => {
      calls.push("append");
      if (fail.append !== undefined) throw fail.append;
      appended.push(input);
    },
  };
}

function reads(tags: readonly StoredTag[] = []): BriefReads {
  return {
    readClear: async (observationId: string): Promise<ClearObservation> => clear({ observationId }),
    listLive: async (): Promise<readonly StoredTag[]> => tags,
  };
}

/** Ids in a known order, so a test can say which id went where. */
function idSource(): IdSource {
  let n = 0;
  return { next: (): string => `00000000-0000-4000-8000-00000000000${++n}` };
}

const deps = (over: Partial<BriefDeps> = {}): BriefDeps => ({
  reads: reads(),
  writes: writes(),
  clock: fixedClock(START),
  ids: idSource(),
  ...over,
});

/** The body of the entry the wrapper appended. */
const bodyOf = (w: Recorder): { at: string; briefId: string; triggerId: string | null } =>
  w.appended[0]!.body as { at: string; briefId: string; triggerId: string | null };

describe("runBrief", () => {
  describe("the instant", () => {
    it("comes from the clock", async () => {
      const w = writes();
      await runBrief(deps({ writes: w }), request());
      expect(bodyOf(w).at).toBe("2026-09-21T00:00:00.000Z");
    });

    it("IGNORES an `at` a caller plants in the request", async () => {
      // The measured plant, and the reason this rule exists. With `at = now - 3d`
      // the trigger landed at day 8 and the audit row at day 11, no error: `record`
      // bounds only the future and the chain stamps its own `occurredAt`. The
      // wrapper's signature has no `at`, and a caller who adds one is not
      // half-obeyed.
      const threeDaysEarlier = new Date(START.getTime() - 3 * 24 * 60 * 60 * 1000);
      const w = writes();
      await runBrief(
        deps({ writes: w }),
        { ...request(), at: threeDaysEarlier } as unknown as BriefRequest,
      );
      expect(bodyOf(w).at).toBe("2026-09-21T00:00:00.000Z");
      expect(w.recorded).toEqual([]);
    });

    it("is read once per brief, so the trigger and the body carry ONE instant", async () => {
      const w = writes();
      await runBrief(deps({ writes: w }), request({ surprise: 2.5 }));
      expect(w.recorded[0]!.at.toISOString()).toBe(bodyOf(w).at);
    });

    it("is read AGAIN on the next brief, not captured once", async () => {
      // A wrapper that read the clock at construction would replay the same instant
      // forever -- which is exactly the plant G10's frozen-clock version would have
      // missed.
      const clock = fixedClock(START);
      const w = writes();
      const d = deps({ writes: w, clock });
      await runBrief(d, request());
      clock.advance(60_000);
      await runBrief(d, request());
      expect(bodyOf(w).at).toBe("2026-09-21T00:00:00.000Z");
      expect((w.appended[1]!.body as { at: string }).at).toBe("2026-09-21T00:01:00.000Z");
    });
  });

  describe("the identifiers", () => {
    it("are minted by the wrapper, two per brief", async () => {
      const w = writes();
      await runBrief(deps({ writes: w }), request({ surprise: 2.5 }));
      expect(bodyOf(w).briefId).toBe("00000000-0000-4000-8000-000000000001");
      expect(w.recorded[0]!.triggerId).toBe("00000000-0000-4000-8000-000000000002");
    });

    it("mints the same two whether or not a trigger is recorded", async () => {
      // Minted unconditionally so the sequence does not depend on the outcome. An
      // id sequence that skipped when a brief found no surprise would make two runs
      // over different corpora impossible to line up.
      const w = writes();
      await runBrief(deps({ writes: w }), request({ surprise: null }));
      expect(bodyOf(w).briefId).toBe("00000000-0000-4000-8000-000000000001");
      expect(bodyOf(w).triggerId).toBeNull();
    });

    it("names the trigger the body names, or null", async () => {
      const w = writes();
      await runBrief(deps({ writes: w }), request({ surprise: 2.5 }));
      expect(bodyOf(w).triggerId).toBe(w.recorded[0]!.triggerId);
    });
  });

  describe("the effects, in order", () => {
    it("records the trigger BEFORE appending the chain entry (R1)", async () => {
      const w = writes();
      await runBrief(deps({ writes: w }), request({ surprise: 2.5 }));
      expect(w.calls).toEqual(["record", "append"]);
    });

    it("appends the chain entry and records nothing when the surprise is null", async () => {
      const w = writes();
      await runBrief(deps({ writes: w }), request({ surprise: null }));
      expect(w.calls).toEqual(["append"]);
    });

    it("always appends, so no brief is a decision with no chain entry (R24)", async () => {
      for (const surprise of [null, 2.5]) {
        const w = writes();
        await runBrief(deps({ writes: w }), request({ surprise }));
        expect(w.calls, String(surprise)).toContain("append");
      }
    });

    it("returns the grade the core computed, with the effects it performed", async () => {
      const w = writes();
      const out = await runBrief(deps({ writes: w }), request({ amount: 0 }));
      expect(out.grade).toBe("clear");
      expect(out.effects.audit).toBe(w.appended[0]);
    });
  });

  describe("a retried record whose first attempt actually landed", () => {
    const collision = (constraint: string): ConstraintViolation =>
      new ConstraintViolation("duplicate key value violates unique constraint", "23505", constraint);

    it("is read as LANDED on the primary key, and the chain entry still goes", async () => {
      const w = writes({ record: collision("trigger_event_pkey") });
      const out = await runBrief(deps({ writes: w }), request({ surprise: 2.5 }));
      expect(w.calls).toEqual(["record", "append"]);
      expect(out.grade).toBeDefined();
    });

    it("is read as landed on the namespace-scoped unique key too", async () => {
      // Both constraints cover `trigger_id`, and which one Postgres reports first is
      // not something this code should depend on.
      const w = writes({ record: collision("trigger_event_in_namespace") });
      await runBrief(deps({ writes: w }), request({ surprise: 2.5 }));
      expect(w.calls).toEqual(["record", "append"]);
    });

    it("is NOT read as landed for a 23505 on another constraint", async () => {
      const w = writes({ record: collision("tag_one_live_per_pair") });
      await expect(runBrief(deps({ writes: w }), request({ surprise: 2.5 }))).rejects.toThrow(
        ConstraintViolation,
      );
      expect(w.calls).toEqual(["record"]);
    });

    it("is NOT read as landed for a foreign-key or check violation on the same table", async () => {
      for (const sqlstate of ["23503", "23514"]) {
        const w = writes({
          record: new ConstraintViolation("violates", sqlstate, "trigger_event_pkey"),
        });
        await expect(
          runBrief(deps({ writes: w }), request({ surprise: 2.5 })),
          sqlstate,
        ).rejects.toThrow(ConstraintViolation);
        expect(w.calls, sqlstate).toEqual(["record"]);
      }
    });

    it("lets a retryable refusal through untouched, rather than swallowing it", async () => {
      // A `Deadlocked` retries under R7 and `maxRetries`. Reading it as "landed"
      // would turn a retryable refusal into a brief that silently recorded nothing.
      const w = writes({ record: new Deadlocked("deadlock detected") });
      await expect(runBrief(deps({ writes: w }), request({ surprise: 2.5 }))).rejects.toThrow(
        Deadlocked,
      );
      expect(w.calls).toEqual(["record"]);
    });
  });

  describe("an append that fails after the trigger landed", () => {
    it("is a NAMED inconsistency and not a rollback (R24)", async () => {
      // R24 rules this for ingest and the ledger extends it to the brief verbatim:
      // a committed write with no chain entry is named, not undone. The trigger is
      // already committed and there is no transaction to roll back -- `record` and
      // `append` are separate statements and `append` refuses a transaction.
      const w = writes({ append: new Deadlocked("deadlock detected") });
      await expect(runBrief(deps({ writes: w }), request({ surprise: 2.5 }))).rejects.toThrow(
        AuditEntryMissing,
      );
    });

    it("names both ids, so the row that exists without a chain entry can be found", async () => {
      const w = writes({ append: new Deadlocked("deadlock detected") });
      await expect(runBrief(deps({ writes: w }), request({ surprise: 2.5 }))).rejects.toThrow(
        /trigger 00000000-0000-4000-8000-000000000002 .* brief 00000000-0000-4000-8000-000000000001/,
      );
    });

    it("keeps the original failure as the cause", async () => {
      const cause = new Deadlocked("deadlock detected");
      const w = writes({ append: cause });
      await runBrief(deps({ writes: w }), request({ surprise: 2.5 })).catch((e: unknown) => {
        expect((e as Error).cause).toBe(cause);
      });
      expect.assertions(1);
    });

    it("is NOT named an inconsistency when there was no trigger to be inconsistent with", async () => {
      // With no trigger recorded, a failed append leaves nothing behind, so the
      // original error is the honest one to raise.
      const w = writes({ append: new Deadlocked("deadlock detected") });
      await expect(runBrief(deps({ writes: w }), request({ surprise: null }))).rejects.toThrow(
        Deadlocked,
      );
    });

    it("is NOT named an inconsistency when the record was read as landed but nothing was written", async () => {
      // A 23505 means the row IS there -- written by the attempt this one is a retry
      // of -- so a failed append after it is still an inconsistency.
      const w = writes({
        record: new ConstraintViolation("duplicate", "23505", "trigger_event_pkey"),
        append: new Deadlocked("deadlock detected"),
      });
      await expect(runBrief(deps({ writes: w }), request({ surprise: 2.5 }))).rejects.toThrow(
        AuditEntryMissing,
      );
    });
  });

  describe("the refusals the core makes are not softened", () => {
    it("passes a unit mismatch through, and writes nothing", async () => {
      const w = writes();
      await expect(runBrief(deps({ writes: w }), request({ unit: "XLM" }))).rejects.toThrow(
        /brief\.unit XLM is not the policy's thresholdUnit/,
      );
      expect(w.calls).toEqual([]);
    });

    it("writes nothing when the namespace is erased (R14)", async () => {
      const w = writes();
      const erasedReads: BriefReads = {
        readClear: async (observationId: string): Promise<ClearObservation> =>
          clear({ observationId, namespaceErased: true }),
        listLive: async (): Promise<readonly StoredTag[]> => [],
      };
      await expect(
        runBrief(deps({ writes: w, reads: erasedReads }), request({ surprise: 2.5 })),
      ).rejects.toThrow(/has been erased/);
      expect(w.calls).toEqual([]);
    });
  });
});
