import { describe, it, expect } from "vitest";
import { CALIBRATION_V0, POLICY_V0 } from "@nonametrust/tagging";
import { RETENTION_V0, type ClearObservation, type StoredTag } from "@nonametrust/store";
import { BRIEF_POLICY_V0, type BriefPolicy } from "./policy.js";
import { brief, type BriefInput, type BriefReads } from "./brief.js";

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
      const port = reads([tag({ tagId: "t1" })], {
        [INTENT_OBS]: clear({ observationId: INTENT_OBS, namespaceErased: true }),
      });
      await expect(brief(input(), port)).rejects.toThrow();
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
    it("excludes a tag the intent itself opened OR refreshed (R41, R22)", async () => {
      // R22 excludes "any tag whose observation_id is the intent's", and a refresh
      // does NOT change observation_id -- it keeps the opening observation's. So a
      // tag the intent refreshed survives an observation-id filter and lowers the
      // intent's own threshold, which is exactly what R22 exists to prevent, one
      // verb over. The filter is on tag IDENTITY.
      const own = tag({ tagId: "own", aspect: "quoted/USDC", channel: "price" });
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
      // R39's claim, checked rather than asserted: enumerate every subset of four
      // tags against a range of amounts and confirm that a hold below base always
      // has a reason to point at.
      const all = [
        tag({ tagId: "a", aspect: "quoted/USDC" }),
        tag({ tagId: "b", aspect: "quoted/USDC" }),
        tag({ tagId: "c", channel: "price", aspect: "quoted/XLM" }),
        tag({ tagId: "d", channel: "address_integrity", aspect: "transition" }),
      ];
      for (let mask = 0; mask < 16; mask++) {
        const subset = all.filter((_, i) => (mask & (1 << i)) !== 0);
        for (const amount of [0, 1, 100, 249, 250, 499, 500, 999, 1000, 2000]) {
          const out = await brief(input({ amount }), reads(subset));
          if (out.grade === "hold" && amount < out.threshold.base) {
            expect(
              out.reasons.length,
              `mask ${mask} amount ${amount}: held below base with nothing to cite`,
            ).toBeGreaterThan(0);
          }
        }
      }
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
    it("is handed a port with exactly two read methods and no writer", async () => {
      // G9 is measured against every table's `xmin` in `brief-db.test.ts`. This is
      // the other half: the core cannot write because it was never given anything
      // that writes. Handing it whole repositories would have handed it `append`,
      // `open`, `refresh` and `suppress`, and "the core writes nothing" would rest
      // on it not calling methods it holds.
      const port = reads([]);
      await brief(input(), port);
      const surface = Object.keys(port).filter((k) => k !== "calls").sort();
      expect(surface).toEqual(["listLive", "readClear"]);
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
