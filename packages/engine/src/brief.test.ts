import { describe, it, expect } from "vitest";
import { CALIBRATION_V0, POLICY_V0 } from "@nonametrust/tagging";
import { RETENTION_V0, type ClearObservation, type StoredTag } from "@nonametrust/store";
import { BRIEF_POLICY_V0, type BriefPolicy } from "./policy.js";
import { gradeFor } from "./grade.js";
import { brief, NamespaceErased, type BriefInput, type BriefReads } from "./brief.js";

// Task 5's core: R1, R8, R13, R18, R19, R22, R25, R27, R29, R30, R39-R45.
//
// PURE IN THE TWO SENSES THAT MATTER. It reads no clock and mints no id -- `at`,
// `briefId` and `triggerId` are inputs, which is what R1's replay claim rests on
// -- and it cannot write, because the port it is handed has two read methods and
// nothing else. `brief-db.test.ts` measures the second claim against every table's
// `xmin` rather than trusting the type.

const NS = "11111111-0000-4000-8000-000000000001";
const INTENT_OBS = "22222222-0000-4000-8000-000000000001";
const AT = new Date("2026-09-21T00:00:00.000Z");

/**
 * Every number differs from every other, and none is shared with
 * `BRIEF_POLICY_V0`. The M2 collision map is why: three of its fields were all 3,
 * and that made a wrong-field read invisible.
 */
const POLICY: BriefPolicy = {
  version: "brief-policy-under-test",
  briefThreshold: 1000,
  thresholdUnit: "USDC",
  activeTagFactor: 0.5,
  activeFloor: 0.125,
  relatednessFloor: 0.375,
  crossChannelAffinity: 0.625,
  crossAspectAffinity: 0.875,
  mediumCeiling: 250,
  maxRetries: 7,
};

const tag = (over: Partial<StoredTag> & { tagId: string }): StoredTag => ({
  namespaceId: NS,
  observationId: `obs-${over.tagId}`,
  channel: "address_integrity",
  aspect: "transition",
  g0: 1,
  taggedAt: AT,
  refreshCount: 0,
  saturationState: "open",
  suppressionFactor: 1,
  retiredAt: null,
  ...over,
});

const clear = (over: Partial<ClearObservation> & { observationId: string }): ClearObservation => ({
  namespaceId: NS,
  channel: "price",
  kind: "quote",
  evidenceKind: "wire",
  datedAt: new Date("2026-09-12T00:00:00.000Z"),
  ingestedAt: AT,
  producer: "test",
  period: "2026-09-01",
  periodExpired: false,
  namespaceErased: false,
  ...over,
});

interface Stub extends BriefReads {
  readonly calls: string[];
}

/** A read port over fixed rows, recording the ORDER it was called in. */
function reads(tags: readonly StoredTag[], overrides: Record<string, ClearObservation> = {}): Stub {
  const calls: string[] = [];
  return {
    calls,
    readClear: async (observationId: string): Promise<ClearObservation> => {
      calls.push(`readClear:${observationId}`);
      return overrides[observationId] ?? clear({ observationId });
    },
    listLive: async (namespaceId: string): Promise<readonly StoredTag[]> => {
      calls.push(`listLive:${namespaceId}`);
      return tags;
    },
  };
}

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  at: AT,
  briefId: "33333333-0000-4000-8000-000000000001",
  triggerId: "44444444-0000-4000-8000-000000000001",
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
    brief: POLICY,
  },
  ...over,
});

describe("brief", () => {
  describe("refuses its input by name", () => {
    it("an amount below zero, while admitting zero (R8)", async () => {
      await expect(brief(input({ amount: -1 }), reads([]))).rejects.toThrow(
        /brief\.amount must be a non-negative finite number/,
      );
      await expect(brief(input({ amount: 0 }), reads([]))).resolves.toBeDefined();
    });

    it("an amount that is not a number the comparison can trust", async () => {
      await expect(brief(input({ amount: Number.NaN }), reads([]))).rejects.toThrow(
        /brief\.amount must be a non-negative finite number/,
      );
    });

    it("a unit that is not the policy's thresholdUnit (R27, R44)", async () => {
      // Without this the brief grades a raw number against a threshold denominated
      // in something else. The refusal names BOTH units, because a message naming
      // only one leaves the reader guessing which side to change.
      await expect(brief(input({ unit: "XLM" }), reads([]))).rejects.toThrow(
        /brief\.unit XLM is not the policy's thresholdUnit USDC/,
      );
    });

    it("a unit that differs only in padding, rather than trimming it", async () => {
      await expect(brief(input({ unit: " USDC" }), reads([]))).rejects.toThrow(
        /brief\.unit/,
      );
    });

    it("a risk tier outside the vocabulary, at RUNTIME and not only by the type (R45)", async () => {
      await expect(
        brief(input({ riskTier: "mid" as never }), reads([])),
      ).rejects.toThrow(/brief\.riskTier must be one of low, medium, high/);
    });

    it("an invalid instant", async () => {
      await expect(brief(input({ at: new Date("nonsense") }), reads([]))).rejects.toThrow(
        /brief\.at must be a valid instant/,
      );
    });

    it("a blank id, for each of the three it is handed", async () => {
      for (const field of ["briefId", "triggerId", "observationId"] as const) {
        await expect(brief(input({ [field]: " " }), reads([])), field).rejects.toThrow(
          new RegExp(`brief\\.${field} must not be blank`),
        );
      }
    });

    it("a policy the engine would otherwise discover as a NaN three functions deep", async () => {
      const bad = { ...POLICY, activeTagFactor: 1 };
      await expect(
        brief(input({ policies: { ...input().policies, brief: bad } }), reads([])),
      ).rejects.toThrow(/briefPolicy\.activeTagFactor must lie in/);
    });

    it("a surprise that is neither null nor a finite number", async () => {
      await expect(brief(input({ surprise: Number.NaN }), reads([]))).rejects.toThrow(
        /brief\.surprise must be null or a finite number/,
      );
    });

    it("a blank tag id inside ownTagIds, naming its index", async () => {
      // Deleting this check SURVIVED. A blank entry silently filters nothing, so the
      // intent's own tag would count -- R22's failure arriving through a typo.
      await expect(brief(input({ ownTagIds: ["ok", " "] }), reads([]))).rejects.toThrow(
        /brief\.ownTagIds\[1\] must not be blank/,
      );
    });

    it("an ownTagIds that is not an array at all", async () => {
      // Deleting this check SURVIVED too. `new Set("abc")` yields the CHARACTERS, so a
      // string would filter by letter and silently exclude nothing the caller meant.
      await expect(
        brief(input({ ownTagIds: "abc" as unknown as readonly string[] }), reads([])),
      ).rejects.toThrow(/brief\.ownTagIds must be an array/);
    });

    it("a blank channel or aspect on the intent, each by name", async () => {
      // Deleting these SURVIVED. A blank aspect makes every same-channel tag look like
      // a DIFFERENT aspect, which silently changes every relatedness score.
      for (const field of ["channel", "aspect"] as const) {
        await expect(
          brief(input({ intent: { ...input().intent, [field]: " " } }), reads([])),
          field,
        ).rejects.toThrow(new RegExp(`brief\\.intent\\.${field} must not be blank`));
      }
      await expect(
        brief(input({ intent: { ...input().intent, namespaceId: "" } }), reads([])),
      ).rejects.toThrow(/brief\.intent\.namespaceId must not be blank/);
    });

    it("an intent whose namespace is not the observation's own", async () => {
      // The caller hands both, and relatedness is computed against `intent`. If the
      // two disagree, every tag is compared against a counterparty the intent is not
      // about, and the brief is wrong in a way no output field shows.
      const other = "99999999-0000-4000-8000-000000000009";
      await expect(
        brief(input(), reads([], { [INTENT_OBS]: clear({ observationId: INTENT_OBS, namespaceId: other }) })),
      ).rejects.toThrow(/brief\.intent\.namespaceId .* is not the observation's namespace/);
    });
  });

  describe("R14: an erased namespace is refused WHOLE, before any tag is read", () => {
    it("names the namespace and refuses", async () => {
      const port = reads([tag({ tagId: "t1" })], {
        [INTENT_OBS]: clear({ observationId: INTENT_OBS, namespaceErased: true }),
      });
      await expect(brief(input(), port)).rejects.toThrow(
        new RegExp(`namespace ${NS} has been erased`),
      );
    });

    it("reads NO tag, which is what 'before any tag is read' means", async () => {
      // The observer R14 needs: "before any tag is read" cannot be seen from
      // outside, so the port counts its calls. Asserting only the refusal would
      // pass for an implementation that listed every tag first and checked after.
      const port = reads([tag({ tagId: "t1" })], {
        [INTENT_OBS]: clear({ observationId: INTENT_OBS, namespaceErased: true }),
      });
      await expect(brief(input(), port)).rejects.toThrow();
      expect(port.calls).toEqual([`readClear:${INTENT_OBS}`]);
    });

    it("is not served as SOURCE_UNREADABLE reasons instead", async () => {
      // Asserts the CLASS and that nothing came back, not merely that something threw
      // -- an earlier version used a bare `rejects.toThrow()`, which any error
      // satisfies and which made this row a duplicate of the one above it.
      const port = reads([tag({ tagId: "t1", aspect: "quoted/USDC" })], {
        [INTENT_OBS]: clear({ observationId: INTENT_OBS, namespaceErased: true }),
      });
      const result = await brief(input(), port).then(
        (out) => ({ threw: false as const, out }),
        (e: unknown) => ({ threw: true as const, e }),
      );
      expect(result.threw, "a brief on an erased namespace came back with reasons").toBe(true);
      expect(result.threw && result.e).toBeInstanceOf(NamespaceErased);
    });

    it("does NOT refuse for an expired month on the intent, which is R13's business", async () => {
      const port = reads([], {
        [INTENT_OBS]: clear({ observationId: INTENT_OBS, periodExpired: true }),
      });
      await expect(brief(input(), port)).resolves.toBeDefined();
    });

    it("reads the intent's clear row FIRST, before listing tags", async () => {
      const port = reads([tag({ tagId: "t1" })]);
      await brief(input(), port);
      expect(port.calls[0]).toBe(`readClear:${INTENT_OBS}`);
      expect(port.calls[1]).toBe(`listLive:${NS}`);
    });
  });

  describe("which tags count", () => {
    it("excludes a tag whose observation IS the intent's, even with an empty ownTagIds (R22)", async () => {
      // R22 as the plan's acceptance states it, in bold: "no reason's observation is
      // the intent's own". Two review lenses converged on this independently -- the
      // core filtered on `ownTagIds` alone, so a caller passing `[]` (which
      // `assertInput` accepts) reintroduced the exact failure R22 exists to prevent,
      // and a DB row asserted the wrong behaviour as correct.
      const opened = tag({ tagId: "opened", aspect: "quoted/USDC", observationId: INTENT_OBS });
      const other = tag({ tagId: "other", aspect: "quoted/USDC", observationId: "obs-other" });
      const out = await brief(input({ ownTagIds: [] }), reads([opened, other]));
      expect(out.reasons.map((r) => r.tagId)).toEqual(["other"]);
      expect(out.threshold.applied).toBe(500);
    });

    it("excludes a tag the intent itself opened OR refreshed (R41, R22)", async () => {
      // R22 excludes "any tag whose observation_id is the intent's", and a refresh
      // does NOT change observation_id -- it keeps the opening observation's. So a
      // tag the intent refreshed survives an observation-id filter and lowers the
      // intent's own threshold, which is exactly what R22 exists to prevent, one
      // verb over. The filter is on tag IDENTITY.
      // The REFRESHED case, which only the identity filter catches: this tag keeps
      // its opening observation's id, which is NOT the intent's, so R22's filter
      // cannot see it.
      const own = tag({ tagId: "own", aspect: "quoted/USDC", channel: "price", observationId: "obs-opened-elsewhere" });
      const other = tag({ tagId: "other", aspect: "quoted/USDC", channel: "price" });

      const without = await brief(input({ ownTagIds: [] }), reads([own, other]));
      expect(without.reasons.map((r) => r.tagId).sort()).toEqual(["other", "own"]);

      const withFilter = await brief(input({ ownTagIds: ["own"] }), reads([own, other]));
      expect(withFilter.reasons.map((r) => r.tagId)).toEqual(["other"]);
      expect(withFilter.threshold.applied).toBeGreaterThan(without.threshold.applied);
    });

    it("excludes a tag stamped AFTER the brief's instant (R43)", async () => {
      // `strengthAt` returns g0 for EVERY non-positive elapsed, so a tag stamped
      // after `at` reports its full strength: a past brief counting it would report
      // evidence that did not exist yet, at a strength it never had.
      const future = tag({
        tagId: "future",
        aspect: "quoted/USDC",
        taggedAt: new Date(AT.getTime() + 1),
      });
      const now = tag({ tagId: "now", aspect: "quoted/USDC" });

      const out = await brief(input(), reads([future, now]));
      expect(out.reasons.map((r) => r.tagId)).toEqual(["now"]);
    });

    it("includes a tag stamped at exactly the brief's instant", async () => {
      const exact = tag({ tagId: "exact", aspect: "quoted/USDC", taggedAt: AT });
      const out = await brief(input(), reads([exact]));
      expect(out.reasons.map((r) => r.tagId)).toEqual(["exact"]);
    });

    it("excludes a tag below the active floor even when it is perfectly related", async () => {
      // The direction R39 closes one way: at 3650 days the day-twelve address tag
      // has a decayed strength of 2.1e-79 and is still perfectly related, so a brief
      // counting reasons on relatedness alone would carry it forever.
      const decayed = tag({
        tagId: "decayed",
        aspect: "quoted/USDC",
        g0: 1,
        taggedAt: new Date(AT.getTime() - 3650 * 24 * 60 * 60 * 1000),
      });
      const out = await brief(input(), reads([decayed]));
      expect(out.reasons).toEqual([]);
    });

    it("excludes a tag above the active floor that is NOT related (R39, the other direction)", async () => {
      // The measured case: the day-twelve address tag scores 0.55 against a price
      // intent. Under a floor above that it is not a reason -- and it must then not
      // lower the threshold either, or the tag decides the grade and the brief
      // cannot cite it.
      const unrelated = tag({ tagId: "unrelated", channel: "address_integrity", aspect: "transition" });
      const strict = { ...POLICY, relatednessFloor: 0.875 };
      const out = await brief(
        input({ policies: { ...input().policies, brief: strict } }),
        reads([unrelated]),
      );
      expect(out.reasons).toEqual([]);
      expect(out.threshold.applied).toBe(out.threshold.base);
    });

    it("counts a tag in another namespace not at all, which is the one thing R11 must not leak", async () => {
      const foreign = tag({
        tagId: "foreign",
        namespaceId: "88888888-0000-4000-8000-000000000008",
        aspect: "quoted/USDC",
      });
      const out = await brief(input(), reads([foreign]));
      expect(out.reasons).toEqual([]);
    });
  });

  describe("R39: the set that lowers the threshold IS the set of reasons", () => {
    it("reports loweredBy equal to the reasons' own tag ids", async () => {
      // The two are the same set by construction, and a test asserts the equality
      // rather than letting them drift -- which is the whole content of R39.
      const out = await brief(
        input(),
        reads([
          tag({ tagId: "a", aspect: "quoted/USDC" }),
          tag({ tagId: "b", aspect: "quoted/USDC" }),
        ]),
      );
      expect([...out.threshold.loweredBy].sort()).toEqual(out.reasons.map((r) => r.tagId).sort());
      expect(out.threshold.loweredBy).toHaveLength(2);
    });

    it("lowers multiplicatively, once per reason", async () => {
      const one = await brief(input(), reads([tag({ tagId: "a", aspect: "quoted/USDC" })]));
      expect(one.threshold.base).toBe(1000);
      expect(one.threshold.applied).toBe(500);

      const two = await brief(
        input(),
        reads([tag({ tagId: "a", aspect: "quoted/USDC" }), tag({ tagId: "b", aspect: "quoted/USDC" })]),
      );
      expect(two.threshold.applied).toBe(250);
    });

    it("leaves the threshold at base when nothing is a reason", async () => {
      const out = await brief(input(), reads([]));
      expect(out.threshold.applied).toBe(1000);
      expect(out.threshold.loweredBy).toEqual([]);
    });

    it("never produces a hold no reason accounts for, below the base threshold", async () => {
      // R39's claim, checked rather than asserted.
      //
      // THE FIXTURE CONTAINS TAGS THAT ARE ACTIVE AND NOT REASONS, and that is the
      // whole point of it. An earlier version used four tags that all cleared
      // `relatednessFloor`, so the lowering set and the reason set were identical for
      // every mask **whether or not the code enforced it** -- and a review measured
      // exactly that: a mutant lowering by strength alone left this enumeration GREEN
      // and turned only one other test red. A test that cannot fail for the defect it
      // is named after is the failure this branch keeps paying for.
      //
      // `e` is in another namespace (relatedness 0, R11) and `f` is cross-channel
      // under a floor above `crossChannelAffinity`. Both are well above
      // `activeFloor`, so a brief that lowered by activity alone would drop the
      // threshold further than its citable reasons account for.
      const strict = { ...POLICY, relatednessFloor: 0.75 };
      const all = [
        tag({ tagId: "a", channel: "price", aspect: "quoted/USDC" }),
        tag({ tagId: "b", channel: "price", aspect: "quoted/USDC" }),
        tag({ tagId: "c", channel: "price", aspect: "quoted/XLM" }),
        tag({ tagId: "d", channel: "address_integrity", aspect: "transition" }),
        tag({ tagId: "e", namespaceId: "77777777-0000-4000-8000-000000000007", aspect: "quoted/USDC" }),
        tag({ tagId: "f", channel: "latency", aspect: "rtt" }),
      ];
      let sawActiveNonReason = false;
      for (let mask = 0; mask < 64; mask++) {
        const subset = all.filter((_, i) => (mask & (1 << i)) !== 0);
        for (const policy of [POLICY, strict]) {
          for (const amount of [0, 1, 100, 249, 250, 499, 500, 999, 1000, 2000]) {
            const out = await brief(
              input({ amount, policies: { ...input().policies, brief: policy } }),
              reads(subset),
            );
            // The two sets are the same set under R39, checked on EVERY mask rather
            // than in one two-tag row.
            expect(
              [...out.threshold.loweredBy].sort(),
              `mask ${mask} floor ${policy.relatednessFloor}: loweredBy drifted from reasons`,
            ).toEqual(out.reasons.map((r) => r.tagId).sort());
            // The threshold is lowered by the REASONS and by nothing else.
            expect(out.threshold.applied).toBeCloseTo(
              out.threshold.base * Math.pow(policy.activeTagFactor, out.reasons.length),
              12,
            );
            if (out.grade === "hold" && amount < out.threshold.base) {
              expect(
                out.reasons.length,
                `mask ${mask} amount ${amount}: held below base with nothing to cite`,
              ).toBeGreaterThan(0);
            }
            if (subset.length > out.reasons.length) sawActiveNonReason = true;
          }
        }
      }
      // The guard that keeps the enumeration honest: if every tag in every mask were
      // a reason, the three assertions above would hold vacuously.
      expect(
        sawActiveNonReason,
        "no mask contained a tag that was active and NOT a reason, so this enumeration is blind again",
      ).toBe(true);
    });
  });

  describe("a reason", () => {
    it("carries the tag's OPENING observation and its refresh count (R30)", async () => {
      const refreshed = tag({
        tagId: "refreshed",
        aspect: "quoted/USDC",
        observationId: "opening-obs",
        refreshCount: 4,
      });
      const out = await brief(input(), reads([refreshed]));
      expect(out.reasons[0]!.observationId).toBe("opening-obs");
      expect(out.reasons[0]!.refreshCount).toBe(4);
    });

    it("carries the decayed strength it was judged on, as a VALUE", async () => {
      // Asserted as a number and not as a type. A reading that returned February
      // for a March row passed `toBeInstanceOf(Date)` in four timezone runs.
      const halfLife = CALIBRATION_V0.halfLifeMs;
      const oneHalfLife = tag({
        tagId: "half",
        aspect: "quoted/USDC",
        g0: 1,
        taggedAt: new Date(AT.getTime() - halfLife),
      });
      const out = await brief(input(), reads([oneHalfLife]));
      expect(out.reasons[0]!.strength).toBeCloseTo(0.5, 12);
    });

    it("carries the relatedness VALUE and the case that produced it", async () => {
      const sameAspect = tag({ tagId: "same", channel: "price", aspect: "quoted/USDC" });
      const sameChannel = tag({ tagId: "chan", channel: "price", aspect: "quoted/XLM" });
      const sameNs = tag({ tagId: "ns", channel: "address_integrity", aspect: "transition" });

      const out = await brief(input(), reads([sameAspect, sameChannel, sameNs]));
      const by = new Map(out.reasons.map((r) => [r.tagId, r]));
      expect(by.get("same")!.relatedness).toBe(1);
      expect(by.get("same")!.relatednessCase).toBe("same_aspect");
      expect(by.get("chan")!.relatedness).toBe(0.875);
      expect(by.get("chan")!.relatednessCase).toBe("same_channel");
      expect(by.get("ns")!.relatedness).toBe(0.625);
      expect(by.get("ns")!.relatednessCase).toBe("same_namespace");
    });

    it("carries a dated instant, and null for a state (R19)", async () => {
      const dated = tag({ tagId: "dated", aspect: "quoted/USDC", observationId: "o-dated" });
      const state = tag({ tagId: "state", aspect: "quoted/USDC", observationId: "o-state" });
      const out = await brief(
        input(),
        reads([dated, state], {
          "o-dated": clear({ observationId: "o-dated", datedAt: new Date("2026-09-12T00:00:00.000Z") }),
          "o-state": clear({ observationId: "o-state", datedAt: null }),
        }),
      );
      const by = new Map(out.reasons.map((r) => [r.tagId, r]));
      expect(by.get("dated")!.datedAt?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
      expect(by.get("state")!.datedAt).toBeNull();
    });

    it("is coded SOURCE_PRESENT when its payload would open", async () => {
      const out = await brief(input(), reads([tag({ tagId: "a", aspect: "quoted/USDC" })]));
      expect(out.reasons[0]!.source).toEqual({ code: "SOURCE_PRESENT" });
    });

    it("is coded SOURCE_UNREADABLE with its flags when the month has expired (R13)", async () => {
      // KEPT and not omitted. A reason dropped when its source stops opening makes
      // the brief's answer change as retention runs, with nothing failing.
      const expired = tag({ tagId: "expired", aspect: "quoted/USDC", observationId: "o-exp" });
      const out = await brief(
        input(),
        reads([expired], {
          "o-exp": clear({ observationId: "o-exp", periodExpired: true }),
        }),
      );
      expect(out.reasons).toHaveLength(1);
      expect(out.reasons[0]!.source).toEqual({
        code: "SOURCE_UNREADABLE",
        periodExpired: true,
        namespaceErased: false,
      });
    });

    it("is SOURCE_UNREADABLE and not a refusal when its OWN namespace is erased mid-brief", async () => {
      // R14 refuses on the INTENT's flag; a reason's flag is R13's business.
      const erased = tag({ tagId: "erased", aspect: "quoted/USDC", observationId: "o-era" });
      const out = await brief(
        input(),
        reads([erased], {
          "o-era": clear({ observationId: "o-era", namespaceErased: true }),
        }),
      );
      expect(out.reasons[0]!.source).toEqual({
        code: "SOURCE_UNREADABLE",
        periodExpired: false,
        namespaceErased: true,
      });
    });

    it("still LOWERS the threshold when its source will not open", async () => {
      // R13's whole point: the reason is kept, so it keeps counting.
      const expired = tag({ tagId: "expired", aspect: "quoted/USDC", observationId: "o-exp" });
      const out = await brief(
        input(),
        reads([expired], { "o-exp": clear({ observationId: "o-exp", periodExpired: true }) }),
      );
      expect(out.threshold.applied).toBe(500);
    });

    it("carries the clear columns R13 names, evidence kind included", async () => {
      // `evidenceKind` was dropped from the requirements' `Reason` shape with nobody
      // recording the narrowing; R13 lists it among the columns that survive in the
      // clear. It comes from the observation, where the other three come from the tag
      // or are the tag's own.
      // The tag's channel and aspect come from the TAG; only `evidenceKind` and
      // `datedAt` come from the clear row. Set them to values that differ from the
      // clear row's, so a read from the wrong side is visible.
      const t = tag({ tagId: "a", channel: "price", aspect: "quoted/USDC", observationId: "o-a" });
      const out = await brief(
        input(),
        reads([t], {
          "o-a": clear({ observationId: "o-a", evidenceKind: "state", channel: "latency" }),
        }),
      );
      expect(out.reasons[0]!.evidenceKind).toBe("state");
      expect(out.reasons[0]!.channel).toBe("price");
      expect(out.reasons[0]!.aspect).toBe("quoted/USDC");
    });

    it("refuses an instant the store returned invalid on the TAG, by name", async () => {
      // `NaN > x` is false, so the R43 exclusion does not catch this and `strengthAt`
      // refuses it with a message that names no tag.
      //
      // The prefix is `threshold.tags` and not `brief.reasons` because Task 6 moved
      // the check into `countedTags`, which the threshold query calls too -- a message
      // naming a "reason" would be wrong when the caller asked for a threshold. What
      // the old assertion protected is unchanged and is what this still asserts: the
      // refusal NAMES the tag, where `strengthAt`'s own message does not.
      const bad = tag({ tagId: "bad-tagged-at", aspect: "quoted/USDC", taggedAt: new Date("nonsense") });
      await expect(brief(input(), reads([bad]))).rejects.toThrow(
        /threshold\.tags\[bad-tagged-at\]\.taggedAt from the store is not a valid instant/,
      );
    });

    it("carries no source reference, in any spelling (R47)", async () => {
      const out = await brief(input(), reads([tag({ tagId: "a", aspect: "quoted/USDC" })]));
      const keys = Object.keys(out.reasons[0]!);
      for (const forbidden of ["ref", "sourceRef", "evidence", "payload"]) {
        expect(keys, forbidden).not.toContain(forbidden);
      }
    });
  });

  describe("R1: the same inputs give the same output", () => {
    it("orders reasons deterministically, independent of the order tags arrive in", async () => {
      // `listLive` orders by `tagged_at desc`, and two tags stamped at one instant
      // have no order at all -- so a brief that passed the store's order through
      // would replay to a different BYTE-identical body depending on how the rows
      // came back. The order is (strength descending, tagId ascending), because a
      // total order needs a tiebreak on something unique.
      const a = tag({ tagId: "aaa", aspect: "quoted/USDC" });
      const b = tag({ tagId: "bbb", aspect: "quoted/USDC" });
      const c = tag({ tagId: "ccc", aspect: "quoted/USDC" });

      const forward = await brief(input(), reads([a, b, c]));
      const reversed = await brief(input(), reads([c, b, a]));
      expect(forward.reasons.map((r) => r.tagId)).toEqual(["aaa", "bbb", "ccc"]);
      expect(reversed.reasons.map((r) => r.tagId)).toEqual(["aaa", "bbb", "ccc"]);
    });

    it("puts the strongest reason first, with the id as the tiebreak", async () => {
      const strong = tag({ tagId: "zzz", aspect: "quoted/USDC", g0: 1 });
      const weak = tag({ tagId: "aaa", aspect: "quoted/USDC", g0: 0.5 });
      const out = await brief(input(), reads([weak, strong]));
      expect(out.reasons.map((r) => r.tagId)).toEqual(["zzz", "aaa"]);
    });

    it("breaks a tie on the TAG id, on tags that SHARE an observation", async () => {
      // The fixture used to hide this: `tag()` derives `observationId` from `tagId`,
      // so the two were a bijection and a tiebreak on the observation sorted
      // identically. A mutant doing exactly that SURVIVED.
      //
      // Two tags on ONE observation at equal strength is the case the docstring names
      // -- a total order needs a tiebreak on something UNIQUE, and an observation id
      // is not unique across tags. Reachable in the store: two tags on different
      // (channel, aspect) pairs may share an opening observation.
      const shared = "one-observation";
      const first = tag({ tagId: "aaa", aspect: "quoted/USDC", observationId: shared });
      const second = tag({ tagId: "bbb", aspect: "quoted/XLM", observationId: shared });
      const forward = await brief(input(), reads([first, second]));
      const reversed = await brief(input(), reads([second, first]));
      expect(forward.reasons[0]!.strength).toBe(forward.reasons[1]!.strength);
      expect(forward.reasons.map((r) => r.tagId)).toEqual(["aaa", "bbb"]);
      expect(reversed.reasons.map((r) => r.tagId)).toEqual(["aaa", "bbb"]);
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    });

    it("renders byte-identically on two runs with the same inputs", async () => {
      const port = () => reads([tag({ tagId: "a", aspect: "quoted/USDC" })]);
      const one = await brief(input(), port());
      const two = await brief(input(), port());
      expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    });
  });

  describe("the effects", () => {
    it("records a candidate trigger carrying the id and instant it was given", async () => {
      const out = await brief(input({ surprise: 2.5 }), reads([]));
      expect(out.effects.trigger).toEqual({
        triggerId: "44444444-0000-4000-8000-000000000001",
        at: AT,
        namespaceId: NS,
        observationId: INTENT_OBS,
        status: "candidate",
        surprise: 2.5,
      });
    });

    it("records NO trigger when the surprise is null (R18, R29)", async () => {
      // The one branch that is both R18 -- a categorical intent has no surprise --
      // and R29 -- a cold continuous intent has no baseline to be surprised
      // against. It still grades.
      const out = await brief(input({ surprise: null }), reads([]));
      expect(out.effects.trigger).toBeNull();
      expect(out.grade).toBe("clear");
    });

    it("always carries an audit body, whether or not there is a trigger", async () => {
      // R24 extends to the brief verbatim: a committed write with no chain entry is
      // a named inconsistency. The audit effect is not optional, which is why the
      // effects are a record and not a tuple whose elements are both optional.
      for (const surprise of [null, 2.5]) {
        const out = await brief(input({ surprise }), reads([]));
        expect(out.effects.audit.kind).toBe("brief");
        expect(out.effects.audit.body).toBeDefined();
      }
    });

    it("names the R26 composite of all four policy versions", async () => {
      const out = await brief(input(), reads([]));
      expect(out.effects.audit.policyVersion).toBe(
        `${RETENTION_V0.version}/${POLICY_V0.version}/${CALIBRATION_V0.version}/brief-policy-under-test`,
      );
    });

    it("refuses a policy version that would make the composite unsplittable", async () => {
      const bad = { ...POLICY, version: "brief/v1" };
      await expect(
        brief(input({ policies: { ...input().policies, brief: bad } }), reads([])),
      ).rejects.toThrow(/briefPolicy\.version must not contain the composite separator/);
    });

    it("puts the brief's own instant in the body, because the chain stamps its own", async () => {
      const out = await brief(input(), reads([]));
      expect((out.effects.audit.body as { at: string }).at).toBe("2026-09-21T00:00:00.000Z");
    });

    it("carries a body the whitelist admits, with the trigger id it recorded", async () => {
      const out = await brief(input({ surprise: 2.5 }), reads([]));
      const body = out.effects.audit.body as { triggerId: string | null; grade: string };
      expect(body.triggerId).toBe("44444444-0000-4000-8000-000000000001");
      expect(body.grade).toBe("clear");
    });

    it("carries a NULL trigger id in the body when it recorded none", async () => {
      const out = await brief(input({ surprise: null }), reads([]));
      expect((out.effects.audit.body as { triggerId: string | null }).triggerId).toBeNull();
    });

    it("carries the INPUT amount into the body, not the threshold or anything else", async () => {
      // A mutant writing `applied` instead of `input.amount` SURVIVED: nothing
      // asserted the body's amount at all. The two numbers are deliberately far apart
      // so a swap is visible, and the unit travels with it.
      const out = await brief(input({ amount: 137 }), reads([tag({ tagId: "a", aspect: "quoted/USDC" })]));
      const body = out.effects.audit.body as { amount: number; unit: string; threshold: { applied: number } };
      expect(body.amount).toBe(137);
      expect(body.unit).toBe("USDC");
      expect(body.threshold.applied).toBe(500);
    });

    it("carries the reason's strength into the body EXACTLY, not rounded", async () => {
      // A mutant rounding to three decimals SURVIVED, because the only body-strength
      // assertion used `g0: 1` at the brief's own instant -- a strength of exactly 1,
      // where rounding is the identity. A third of a half-life gives a long decimal.
      const third = CALIBRATION_V0.halfLifeMs / 3;
      const decayed = tag({
        tagId: "decayed",
        aspect: "quoted/USDC",
        g0: 1,
        taggedAt: new Date(AT.getTime() - third),
      });
      const out = await brief(input(), reads([decayed]));
      const body = out.effects.audit.body as { reasons: { strength: number }[] };
      expect(out.reasons[0]!.strength).toBeCloseTo(0.7937005259840998, 15);
      expect(body.reasons[0]!.strength).toBe(out.reasons[0]!.strength);
      // The digits the rounding mutant would have dropped.
      expect(String(body.reasons[0]!.strength).length).toBeGreaterThan(10);
    });

    it("names the INTENT's observation on the trigger, even when reasons exist", async () => {
      // A mutant using `reasons[0].observationId` SURVIVED, because the only
      // trigger-shape row ran with no reasons at all and the fallback hid it.
      const out = await brief(
        input({ surprise: 2.5 }),
        reads([tag({ tagId: "a", aspect: "quoted/USDC", observationId: "not-the-intent" })]),
      );
      expect(out.reasons).toHaveLength(1);
      expect(out.effects.trigger!.observationId).toBe(INTENT_OBS);
      expect((out.effects.audit.body as { observationId: string }).observationId).toBe(INTENT_OBS);
    });

    it("carries every reason into the body, with the strengths the grade used", async () => {
      const out = await brief(
        input(),
        reads([tag({ tagId: "a", aspect: "quoted/USDC" }), tag({ tagId: "b", aspect: "quoted/USDC" })]),
      );
      const body = out.effects.audit.body as {
        reasons: { tagId: string; strength: number }[];
        threshold: { base: number; applied: number };
      };
      expect(body.reasons.map((r) => r.tagId)).toEqual(["a", "b"]);
      expect(body.threshold).toEqual({ base: 1000, applied: 250 });
      expect(body.reasons[0]!.strength).toBe(out.reasons[0]!.strength);
    });
  });

  describe("a threshold the lowering has collapsed to zero", () => {
    // FOUND BY MEASUREMENT, not by reading. Timing the real brief at 200 reasons
    // showed a threshold of 2.5e-17, and following that to its end: the lowered
    // threshold is `base × factor^k`, so it UNDERFLOWS to exactly 0, and `gradeFor`
    // refuses a non-positive threshold. Measured counts, under a base of 600:
    // factor 0.8 underflows at 3340 reasons, 0.5 at 1075, and 0.01 -- which
    // `assertBriefPolicy` accepts -- at 162.
    //
    // 162 is reachable. The consequence was that **the counterparty with the most
    // evidence got no decision at all**: a RangeError out of the grade arithmetic,
    // which is not a grade, is not R7's unavailability, and is the worst possible
    // answer for the one case a brief matters most for.
    const collapsing = { ...POLICY, activeTagFactor: 0.01 };
    const manyTags = (n: number): StoredTag[] =>
      Array.from({ length: n }, (_, i) =>
        tag({ tagId: `t${String(i).padStart(4, "0")}`, aspect: "quoted/USDC", observationId: `o${i}` }),
      );
    const collapsingInput = (over: Partial<BriefInput> = {}): BriefInput =>
      input({ policies: { ...input().policies, brief: collapsing }, ...over });

    it("still grades one reason BEFORE the underflow, at the smallest positive threshold", async () => {
      const out = await brief(collapsingInput(), reads(manyTags(161)));
      expect(out.reasons).toHaveLength(161);
      expect(out.threshold.applied).toBeGreaterThan(0);
      expect(out.threshold.applied).toBeLessThan(1e-300);
      expect(out.grade).toBe("hold");
    });

    it("grades HOLD rather than throwing once it underflows", async () => {
      const out = await brief(collapsingInput(), reads(manyTags(162)));
      expect(out.threshold.applied).toBe(0);
      expect(out.grade).toBe("hold");
    });

    it("still cites every reason, so the collapsed threshold has an account of itself", async () => {
      const out = await brief(collapsingInput(), reads(manyTags(162)));
      expect(out.reasons).toHaveLength(162);
      expect(out.threshold.loweredBy).toHaveLength(162);
      expect(out.threshold.base).toBe(1000);
    });

    it("holds a ZERO amount there too, which is the same comparison at the limit", async () => {
      // `amount >= threshold` with a threshold of 0 is true for every admissible
      // amount, zero included. That is not a new rule for the collapsed case -- it is
      // the rule `gradeFor` already applies, at the limit of the arithmetic.
      const out = await brief(collapsingInput({ amount: 0 }), reads(manyTags(162)));
      expect(out.grade).toBe("hold");
    });

    it("is MONOTONE across the boundary, which is what makes hold the right answer", async () => {
      // A zero amount is `watch` one reason earlier and `hold` after, so adding a
      // reason moved the grade in the one direction `gradeFor` promises it can move.
      // A throw would have broken that promise exactly at the boundary.
      const before = await brief(collapsingInput({ amount: 0 }), reads(manyTags(161)));
      const after = await brief(collapsingInput({ amount: 0 }), reads(manyTags(162)));
      expect(before.grade).toBe("watch");
      expect(after.grade).toBe("hold");
    });

    it("writes the collapsed threshold into the audit body, not a substituted number", async () => {
      const out = await brief(collapsingInput(), reads(manyTags(162)));
      expect((out.effects.audit.body as { threshold: { applied: number } }).threshold.applied).toBe(0);
    });

    it("leaves gradeFor's own refusal intact for every other caller", async () => {
      // The fix is in the brief, which computed the number and therefore knows the
      // case, and NOT in `gradeFor`, whose refusal protects it from garbage handed in
      // by anyone. Weakening that would trade a named defect for an unnamed one.
      expect(() => gradeFor({ amount: 1, threshold: 0, reasonCount: 0 })).toThrow(
        /grade threshold must be a positive finite number/,
      );
      expect(() => gradeFor({ amount: 1, threshold: Number.NaN, reasonCount: 0 })).toThrow(
        /grade threshold must be a positive finite number/,
      );
    });
  });

  describe("the audit body is checked against what the STORE hands back", () => {
    // WHY THESE ROWS EXIST. Deleting `assertAuditBody(body)` from the core SURVIVED
    // the first mutation run: every field of the body came from an input
    // `assertInput` had already refused, so the call was unobservable and its rule
    // was held by nothing. The uncovered path is the other direction -- a value
    // arriving from the READS rather than from the caller -- and that is the
    // direction that matters, because the body is what becomes permanent.

    it("refuses a tag whose id the store returned blank, naming the body path", async () => {
      const blank = tag({ tagId: "  ", aspect: "quoted/USDC" });
      await expect(brief(input(), reads([blank]))).rejects.toThrow(
        /auditBody\.reasons\[\]\.tagId must not be blank/,
      );
    });

    it("refuses a reason whose dated instant the store returned invalid, by name", async () => {
      // `toISOString()` on an invalid Date throws a bare "Invalid time value" with
      // nothing in it to say which row, and this value comes from `dated_at`.
      const t = tag({ tagId: "bad-date", aspect: "quoted/USDC", observationId: "o-bad" });
      await expect(
        brief(
          input(),
          reads([t], { "o-bad": clear({ observationId: "o-bad", datedAt: new Date("nonsense") }) }),
        ),
      ).rejects.toThrow(/brief\.reasons\[bad-date\]\.datedAt from the store is not a valid instant/);
    });

    it("refuses an observation id the store returned blank", async () => {
      const t = tag({ tagId: "t", aspect: "quoted/USDC", observationId: "   " });
      await expect(brief(input(), reads([t]))).rejects.toThrow(
        /auditBody\.reasons\[\]\.observationId must not be blank/,
      );
    });
  });

  describe("the grade", () => {
    it("holds at or above the applied threshold", async () => {
      const out = await brief(input({ amount: 500 }), reads([tag({ tagId: "a", aspect: "quoted/USDC" })]));
      expect(out.threshold.applied).toBe(500);
      expect(out.grade).toBe("hold");
    });

    it("watches below the bar with evidence", async () => {
      const out = await brief(input({ amount: 499 }), reads([tag({ tagId: "a", aspect: "quoted/USDC" })]));
      expect(out.grade).toBe("watch");
    });

    it("clears below the bar with none", async () => {
      expect((await brief(input({ amount: 499 }), reads([]))).grade).toBe("clear");
    });

    it("holds a pristine counterparty asking for the base amount, with zero reasons", async () => {
      // R29's sentence holds only BELOW the base threshold, and the qualifier is
      // measured rather than argued: a threshold is what a threshold is.
      const out = await brief(input({ amount: 1000 }), reads([]));
      expect(out.grade).toBe("hold");
      expect(out.reasons).toEqual([]);
    });
  });

  describe("the core writes nothing, structurally", () => {
    it("touches only the two reads even when handed a port that also writes", async () => {
      // G9 is measured against every table's `xmin` in `brief-db.test.ts`; the
      // structural half is the `BriefReads` type and `tsc`. An earlier version of this
      // row asserted `Object.keys` of the TEST'S OWN STUB, which measured the fixture
      // and would have stayed green for any core at all.
      //
      // This hands the core a port that DOES carry writers, at runtime, past the type
      // -- the arrangement the plan's "reads through repositories" would really have
      // produced -- and records that none of them is called.
      const touched: string[] = [];
      const withWriters = {
        readClear: async (observationId: string): Promise<ClearObservation> => {
          touched.push("readClear");
          return clear({ observationId });
        },
        listLive: async (): Promise<readonly StoredTag[]> => {
          touched.push("listLive");
          return [tag({ tagId: "a", aspect: "quoted/USDC" })];
        },
        append: async (): Promise<void> => void touched.push("append"),
        open: async (): Promise<void> => void touched.push("open"),
        refresh: async (): Promise<void> => void touched.push("refresh"),
        suppress: async (): Promise<void> => void touched.push("suppress"),
        record: async (): Promise<void> => void touched.push("record"),
      };
      await brief(input(), withWriters as unknown as BriefReads);
      expect([...new Set(touched)].sort()).toEqual(["listLive", "readClear"]);
    });

    it("reads each reason's clear row once and no more", async () => {
      const port = reads([
        tag({ tagId: "a", aspect: "quoted/USDC", observationId: "o-a" }),
        tag({ tagId: "b", aspect: "quoted/USDC", observationId: "o-b" }),
      ]);
      await brief(input(), port);
      expect(port.calls).toEqual([
        `readClear:${INTENT_OBS}`,
        `listLive:${NS}`,
        "readClear:o-a",
        "readClear:o-b",
      ]);
    });

    it("reads no clear row for a tag that is not a reason", async () => {
      // One `readClear` per reason and none per candidate: the measurement that
      // dissolved §7's cap question counted round trips, and a brief that opened a
      // row for every live tag would be paying for evidence it discards.
      const port = reads([
        tag({ tagId: "reason", aspect: "quoted/USDC", observationId: "o-keep" }),
        tag({ tagId: "faint", aspect: "quoted/USDC", observationId: "o-drop", g0: 0.01 }),
      ]);
      await brief(input(), port);
      expect(port.calls).not.toContain("readClear:o-drop");
      expect(port.calls).toContain("readClear:o-keep");
    });
  });
});
