import { describe, it, expect } from "vitest";
import { CALIBRATION_V0, POLICY_V0 } from "@nonametrust/tagging";
import { RETENTION_V0, strengthAt, type ClearObservation, type StoredTag } from "@nonametrust/store";
import { BRIEF_POLICY_V0, type BriefPolicy } from "./policy.js";
import { brief, type BriefInput, type BriefReads } from "./brief.js";
import {
  loweredThreshold,
  thresholdFor,
  type ThresholdQuery,
  type ThresholdReads,
} from "./threshold.js";

// Task 6: R3, R4, R27. The threshold as a QUERY, and the brief's use of it.
//
// IT IS INTENT-SCOPED, and that is R39's cost rather than a design preference.
// Design §6 asks for "the current threshold as a query" and the plan wrote
// `thresholdFor(namespaceId, at)`. Once relatedness gates the lowering there is no
// intent-free threshold to return: the same counterparty at the same instant has a
// different threshold for a `price` intent than for an `address_integrity` one,
// because a different set of tags clears `relatednessFloor` against each.
//
// AND THE BRIEF SHARES ITS ARITHMETIC rather than repeating it. The plan's
// acceptance -- "the threshold query and the brief read one value at one instant" --
// is satisfiable two ways, and only one of them is worth having: two copies of
// `base × factor^k` that a test compares, or one function both call. A review
// pointed out that the brief had inlined the arithmetic, which would have made the
// consistency test a comparison between two things that can drift. It calls this
// module now.

const NS = "11111111-0000-4000-8000-000000000001";
const INTENT_OBS = "22222222-0000-4000-8000-000000000001";
const AT = new Date("2026-09-21T00:00:00.000Z");
const HALF_LIFE = CALIBRATION_V0.halfLifeMs;

/** Every number differs from every other, and none is shared with `BRIEF_POLICY_V0`. */
const POLICY: BriefPolicy = {
  version: "threshold-policy-under-test",
  briefThreshold: 1000,
  thresholdUnit: "USDC",
  activeTagFactor: 0.5,
  activeFloor: 0.25,
  relatednessFloor: 0.375,
  crossChannelAffinity: 0.625,
  crossAspectAffinity: 0.875,
  mediumCeiling: 250,
  maxRetries: 7,
};

const tag = (over: Partial<StoredTag> & { tagId: string }): StoredTag => ({
  namespaceId: NS,
  observationId: `obs-${over.tagId}`,
  channel: "price",
  aspect: "quoted/USDC",
  g0: 1,
  taggedAt: AT,
  refreshCount: 0,
  saturationState: "open",
  suppressionFactor: 1,
  retiredAt: null,
  ...over,
});

const reads = (tags: readonly StoredTag[]): ThresholdReads => ({
  listLive: async (): Promise<readonly StoredTag[]> => tags,
});

const query = (over: Partial<ThresholdQuery> = {}): ThresholdQuery => ({
  at: AT,
  intent: { namespaceId: NS, channel: "price", aspect: "quoted/USDC" },
  observationId: INTENT_OBS,
  ownTagIds: [],
  policy: POLICY,
  halfLifeMs: HALF_LIFE,
  ...over,
});

/**
 * The instant at which a tag's decayed strength is EXACTLY the active floor.
 *
 * `strengthAt` is `g0 × 0.5^(elapsed × suppressionFactor / halfLife)`, so at a factor
 * of 1 the floor is reached at `elapsed = halfLife × log2(g0/floor)`. **The factor is
 * omitted here and every caller of this helper must pass an unsuppressed tag** -- the
 * suppression rows below build their own instants, because suppression multiplies
 * elapsed time and would move this boundary.
 *
 * Derived rather than hard-coded, because 28 days is only right for `g0 = 1`,
 * `floor = 0.25` and this half-life. A review confirmed the straddle survives from a
 * one-second to a hundred-year half-life, so it cannot silently stop; what announces
 * a move is the value pin in the gap row.
 */
const elapsedAtFloor = (g0: number, floor: number): number =>
  HALF_LIFE * Math.log2(g0 / floor);

describe("loweredThreshold", () => {
  it("multiplies once per reason (R4), and is not subtractive", () => {
    expect(loweredThreshold(POLICY, 0)).toBe(1000);
    expect(loweredThreshold(POLICY, 1)).toBe(500);
    expect(loweredThreshold(POLICY, 2)).toBe(250);
    expect(loweredThreshold(POLICY, 3)).toBe(125);
    // Subtractive would give 999.5, 999, 998.5 -- and would have to name a currency,
    // which is the argument the policy's own docstring makes.
    expect(loweredThreshold(POLICY, 2)).not.toBeCloseTo(1000 - 2 * POLICY.activeTagFactor, 6);
  });

  it("composes so that two tags are the square of one, not twice one", () => {
    const one = loweredThreshold(POLICY, 1);
    expect(loweredThreshold(POLICY, 2)).toBeCloseTo((one * one) / POLICY.briefThreshold, 12);
  });

  it("returns the base itself at zero, so a pristine counterparty is not lowered", () => {
    expect(loweredThreshold(BRIEF_POLICY_V0, 0)).toBe(BRIEF_POLICY_V0.briefThreshold);
  });

  it("carries R60's underflow rather than hiding it", () => {
    // The lowering reaches exactly zero and the brief grades `hold` there. Asserted
    // here too, because this is the function that produces the zero and a clamp added
    // later would be invisible from the brief's side.
    const collapsing = { ...POLICY, activeTagFactor: 0.01 };
    expect(loweredThreshold(collapsing, 161)).toBeGreaterThan(0);
    expect(loweredThreshold(collapsing, 162)).toBe(0);
  });

  it("refuses a reason count that is not a count", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => loweredThreshold(POLICY, bad), String(bad)).toThrow(
        /threshold reasonCount must be a non-negative integer/,
      );
    }
  });
});

describe("thresholdFor", () => {
  it("returns the base when nothing is a reason", async () => {
    const out = await thresholdFor(query(), reads([]));
    expect(out).toEqual({ base: 1000, applied: 1000, loweredBy: [] });
  });

  it("lowers once per reason and names which tags did it", async () => {
    const out = await thresholdFor(
      query(),
      reads([tag({ tagId: "a" }), tag({ tagId: "b", aspect: "quoted/XLM" })]),
    );
    expect(out.base).toBe(1000);
    expect(out.applied).toBe(250);
    expect([...out.loweredBy].sort()).toEqual(["a", "b"]);
  });

  describe("the active floor, on REAL decay rather than on g0 == floor", () => {
    // The plan's acceptance in as many words. A fixture whose `g0` equals the floor
    // tests the comparison and not the decay, and the two are different rules: the
    // storage card lost four rules to fixture values that coincided.

    it("counts a tag ONE MILLISECOND of decay above the floor", async () => {
      const elapsed = elapsedAtFloor(1, POLICY.activeFloor) - 1;
      const justAbove = tag({ tagId: "above", taggedAt: new Date(AT.getTime() - elapsed) });
      const strength = strengthAt(justAbove, AT, HALF_LIFE);
      expect(strength, "the fixture does not straddle the floor").toBeGreaterThan(
        POLICY.activeFloor,
      );

      const out = await thresholdFor(query(), reads([justAbove]));
      expect(out.loweredBy).toEqual(["above"]);
      expect(out.applied).toBe(500);
    });

    it("does NOT count a tag one millisecond of decay below it", async () => {
      const elapsed = elapsedAtFloor(1, POLICY.activeFloor) + 1;
      const justBelow = tag({ tagId: "below", taggedAt: new Date(AT.getTime() - elapsed) });
      const strength = strengthAt(justBelow, AT, HALF_LIFE);
      expect(strength).toBeLessThan(POLICY.activeFloor);

      const out = await thresholdFor(query(), reads([justBelow]));
      expect(out.loweredBy).toEqual([]);
      expect(out.applied).toBe(1000);
    });

    it("straddles the floor by 2.865e-10, and the PLAN's 2.4e-10 is wrong", async () => {
      // MEASURED, not quoted. The plan says "about 2.4e-10" and an earlier version of
      // this row repeated it while asserting only `1e-11 < gap < 1e-9` -- a window two
      // orders of magnitude wide, which passes 2.4e-10, 2.87e-10 and anything from a
      // 1.4-day to a 400-day half-life. It checked nothing it claimed to check.
      //
      // The real value follows from the derivative: one millisecond of decay at the
      // floor moves the strength by `floor × ln2 / halfLife` = 1.4326e-10, so two
      // milliseconds apart differ by 2.8652e-10. 2.4e-10 would need a 16.7-day
      // half-life; this one is 14 days.
      const base = elapsedAtFloor(1, POLICY.activeFloor);
      const above = strengthAt(tag({ tagId: "x", taggedAt: new Date(AT.getTime() - (base - 1)) }), AT, HALF_LIFE);
      const below = strengthAt(tag({ tagId: "y", taggedAt: new Date(AT.getTime() - (base + 1)) }), AT, HALF_LIFE);

      expect(above).toBe(0.25000000014325957);
      expect(below).toBe(0.2499999998567404);
      const gap = above - below;
      expect(gap).toBe(2.8651916950117595e-10);
      // Pinned against the analytic form too, so a change to the half-life or the floor
      // announces itself as a disagreement between the two rather than as a number
      // drifting inside a wide window.
      //
      // RELATIVE, to seven significant figures, because the derivative is a FIRST-ORDER
      // approximation: the true difference carries second-order terms and the two
      // disagree at the eighteenth decimal. An exact comparison failed, which is how
      // that was learned rather than assumed.
      const analytic = (2 * POLICY.activeFloor * Math.LN2) / HALF_LIFE;
      expect(Math.abs(gap - analytic) / analytic).toBeLessThan(1e-7);
    });

    it("counts a tag AT the floor exactly, reached by real decay", async () => {
      // An earlier version of this row said a strength landing exactly on the floor
      // "is not reachable by choosing an elapsed time -- the arithmetic gives a
      // neighbouring double", and used a `g0` equal to the floor instead. That
      // sentence is FALSE and a review measured it: at `g0 = 1` and floor 0.25 the
      // elapsed time is exactly two half-lives, 2,419,200,000 ms, so the exponent is
      // exactly 2 and `Math.pow(0.5, 2)` is exactly 0.25.
      //
      // So the row now does what it claims: real decay landing exactly on the floor,
      // which counts, because the floor is declared "at or above".
      const exactElapsed = elapsedAtFloor(1, POLICY.activeFloor);
      expect(Number.isInteger(exactElapsed), "the elapsed time is not a whole millisecond").toBe(true);
      const atFloor = tag({ tagId: "exact", g0: 1, taggedAt: new Date(AT.getTime() - exactElapsed) });
      expect(strengthAt(atFloor, AT, HALF_LIFE)).toBe(POLICY.activeFloor);

      const out = await thresholdFor(query(), reads([atFloor]));
      expect(out.loweredBy).toEqual(["exact"]);
    });

    it("counts one at the floor reached with no decay at all, which is the other way there", async () => {
      // The `g0 == floor` fixture, kept for the one thing it is right for: `strengthAt`
      // returns `g0` for a non-positive elapsed, so this exercises the comparison
      // rather than the decay. Both paths to the floor count.
      const atFloor = tag({ tagId: "fresh", g0: POLICY.activeFloor, taggedAt: AT });
      expect(strengthAt(atFloor, AT, HALF_LIFE)).toBe(POLICY.activeFloor);
      expect((await thresholdFor(query(), reads([atFloor]))).loweredBy).toEqual(["fresh"]);
    });
  });

  it("is not moved by a LIVE tag below the floor", async () => {
    // The plan's third acceptance clause. `listLive` returns every tag ever opened,
    // so "live" and "active" are different things and the floor is what separates
    // them.
    const faint = tag({ tagId: "faint", g0: 0.01 });
    const out = await thresholdFor(query(), reads([faint]));
    expect(out.applied).toBe(1000);
    expect(out.loweredBy).toEqual([]);
  });

  describe("is INTENT-SCOPED, which is R39's cost", () => {
    it("gives one counterparty two different thresholds for two intents at one instant", async () => {
      // The sentence design §6 will have to lose: there is no intent-free threshold.
      // Same namespace, same instant, same tags -- two answers.
      const tags = [
        tag({ tagId: "price", channel: "price", aspect: "quoted/USDC" }),
        tag({ tagId: "addr", channel: "address_integrity", aspect: "transition" }),
      ];
      const strict = { ...POLICY, relatednessFloor: 0.875 };

      const forPrice = await thresholdFor(
        query({ policy: strict, intent: { namespaceId: NS, channel: "price", aspect: "quoted/USDC" } }),
        reads(tags),
      );
      const forAddress = await thresholdFor(
        query({
          policy: strict,
          intent: { namespaceId: NS, channel: "address_integrity", aspect: "transition" },
        }),
        reads(tags),
      );

      expect(forPrice.loweredBy).toEqual(["price"]);
      expect(forAddress.loweredBy).toEqual(["addr"]);
      expect(forPrice.applied).toBe(500);
      expect(forAddress.applied).toBe(500);
      // And under the same floor they are lowered by DIFFERENT tags, which is the
      // whole point: an intent-free query could not say which.
      expect(forPrice.loweredBy).not.toEqual(forAddress.loweredBy);
    });

    it("counts nothing from another namespace, which R11 must not leak", async () => {
      const foreign = tag({ tagId: "foreign", namespaceId: "88888888-0000-4000-8000-000000000008" });
      const out = await thresholdFor(query(), reads([foreign]));
      expect(out.applied).toBe(1000);
    });
  });

  describe("applies the SAME exclusions the brief does", () => {
    it("excludes the intent's own observation (R22)", async () => {
      const own = tag({ tagId: "own", observationId: INTENT_OBS });
      expect((await thresholdFor(query(), reads([own]))).applied).toBe(1000);
    });

    it("excludes a tag the caller names as its own (R41)", async () => {
      const t = tag({ tagId: "mine" });
      expect((await thresholdFor(query({ ownTagIds: ["mine"] }), reads([t]))).applied).toBe(1000);
    });

    it("excludes a tag stamped after the instant (R43)", async () => {
      const future = tag({ tagId: "future", taggedAt: new Date(AT.getTime() + 1) });
      expect((await thresholdFor(query(), reads([future]))).applied).toBe(1000);
    });

    it("refuses an invalid instant from the store by name", async () => {
      const bad = tag({ tagId: "bad", taggedAt: new Date("nonsense") });
      await expect(thresholdFor(query(), reads([bad]))).rejects.toThrow(
        /threshold\.tags\[bad\]\.taggedAt from the store is not a valid instant/,
      );
    });

    it("refuses its policy up front rather than three functions deep", async () => {
      await expect(
        thresholdFor(query({ policy: { ...POLICY, activeTagFactor: 1 } }), reads([])),
      ).rejects.toThrow(/briefPolicy\.activeTagFactor must lie in/);
    });

    it("refuses a half-life that is not positive", async () => {
      await expect(thresholdFor(query({ halfLifeMs: 0 }), reads([]))).rejects.toThrow(
        /threshold\.halfLifeMs must be a positive finite number/,
      );
    });

    it("refuses an invalid instant", async () => {
      // Deleting this check SURVIVED a review's mutation run: no row asked the QUERY
      // for an invalid `at`, and the brief's row is killed by `assertInput` instead.
      await expect(thresholdFor(query({ at: new Date("nonsense") }), reads([]))).rejects.toThrow(
        /threshold\.at must be a valid instant/,
      );
    });

    it("refuses a blank observationId, because a blank one turns R22 OFF", async () => {
      // The finding that made all of these rows exist. With `observationId: ""` the
      // R22 comparison matches nothing, so the intent's own tag lowers the intent's own
      // threshold -- measured at 250 where the brief throws. And `""` is exactly what a
      // caller reaches for when asking Task 9's "a counterparty with no active tag".
      const own = tag({ tagId: "own", observationId: INTENT_OBS });
      await expect(thresholdFor(query({ observationId: "" }), reads([own]))).rejects.toThrow(
        /threshold\.observationId must not be blank/,
      );
      for (const bad of [undefined, null, 42]) {
        await expect(
          thresholdFor(query({ observationId: bad as unknown as string }), reads([own])),
          String(bad),
        ).rejects.toThrow(/threshold\.observationId must be a string/);
      }
    });

    it("refuses an ownTagIds that is a STRING, which would filter by character", async () => {
      // `new Set("own")` is `{o, w, n}`, so a string silently filters by letter and the
      // tag actually named `own` counts.
      const own = tag({ tagId: "own" });
      await expect(
        thresholdFor(query({ ownTagIds: "own" as unknown as readonly string[] }), reads([own])),
      ).rejects.toThrow(/threshold\.ownTagIds must be an array/);
    });

    it("refuses a blank entry inside ownTagIds, naming its index", async () => {
      await expect(thresholdFor(query({ ownTagIds: ["ok", " "] }), reads([]))).rejects.toThrow(
        /threshold\.ownTagIds\[1\] must not be blank/,
      );
    });

    it("refuses a blank namespace, channel or aspect on the intent, each by name", async () => {
      for (const field of ["namespaceId", "channel", "aspect"] as const) {
        await expect(
          thresholdFor(query({ intent: { ...query().intent, [field]: " " } }), reads([])),
          field,
        ).rejects.toThrow(new RegExp(`threshold\\.intent\\.${field} must not be blank`));
      }
    });

    it("breaks a tie on the TAG id, on tags that SHARE an observation", async () => {
      // Two review lenses converged on this independently: the fixture above derives
      // `observationId` from `tagId`, so a tiebreak on the observation sorts
      // identically and a mutant using one SURVIVED every row in this file. That is
      // the collision `countedTags`'s own docstring describes, reintroduced one file
      // over -- and the commit claimed the tiebreak was held "through both entry
      // points" when it was held only through the brief.
      const shared = "one-observation";
      const first = tag({ tagId: "aaa", observationId: shared });
      const second = tag({ tagId: "bbb", aspect: "quoted/XLM", observationId: shared });
      const forward = await thresholdFor(query(), reads([first, second]));
      const reversed = await thresholdFor(query(), reads([second, first]));
      expect(forward.loweredBy).toEqual(["aaa", "bbb"]);
      expect(reversed.loweredBy).toEqual(["aaa", "bbb"]);
    });

    it("counts a SUPPRESSED tag on its suppressed decay, and reports that strength", async () => {
      // Every fixture in the engine suite used `suppressionFactor: 1`, so two mutants
      // survived: dropping suppression from the decay, and multiplying the REPORTED
      // strength by it after the decision. A suppressed tag is the reason that column
      // exists. Suppression multiplies ELAPSED time rather than reducing g0, so a
      // doubly-suppressed tag at half a half-life has decayed a full one.
      const half = HALF_LIFE / 2;
      const suppressed = tag({
        tagId: "suppressed",
        g0: 1,
        suppressionFactor: 2,
        taggedAt: new Date(AT.getTime() - half),
      });
      const plain = tag({
        tagId: "plain",
        aspect: "quoted/XLM",
        g0: 1,
        suppressionFactor: 1,
        taggedAt: new Date(AT.getTime() - half),
      });
      expect(strengthAt(suppressed, AT, HALF_LIFE)).toBeCloseTo(0.5, 12);
      expect(strengthAt(plain, AT, HALF_LIFE)).toBeCloseTo(Math.SQRT1_2, 12);

      const out = await thresholdFor(query(), reads([suppressed, plain]));
      // The plain tag is stronger, so R53 puts it first -- which a strength that
      // ignored suppression would reverse.
      expect(out.loweredBy).toEqual(["plain", "suppressed"]);
    });

    it("drops a suppressed tag below the floor that its unsuppressed twin clears", async () => {
      // The direction that matters: suppression is accelerated decay, so it can move a
      // tag across `activeFloor`. Under a factor of 4 this tag has decayed four
      // half-lives where the clock shows one.
      const elapsed = HALF_LIFE;
      const hard = tag({ tagId: "hard", suppressionFactor: 4, taggedAt: new Date(AT.getTime() - elapsed) });
      expect(strengthAt(hard, AT, HALF_LIFE)).toBeCloseTo(0.0625, 12);
      expect(strengthAt(hard, AT, HALF_LIFE)).toBeLessThan(POLICY.activeFloor);
      expect((await thresholdFor(query(), reads([hard]))).loweredBy).toEqual([]);

      const soft = tag({ tagId: "soft", suppressionFactor: 1, taggedAt: new Date(AT.getTime() - elapsed) });
      expect(strengthAt(soft, AT, HALF_LIFE)).toBeGreaterThan(POLICY.activeFloor);
      expect((await thresholdFor(query(), reads([soft]))).loweredBy).toEqual(["soft"]);
    });

    it("orders loweredBy the way the brief orders its reasons (R53)", async () => {
      const strong = tag({ tagId: "zzz", g0: 1 });
      const weak = tag({ tagId: "aaa", g0: 0.5, aspect: "quoted/XLM" });
      const forward = await thresholdFor(query(), reads([weak, strong]));
      const reversed = await thresholdFor(query(), reads([strong, weak]));
      expect(forward.loweredBy).toEqual(["zzz", "aaa"]);
      expect(reversed.loweredBy).toEqual(["zzz", "aaa"]);
    });
  });
});

describe("the query and the brief read ONE value at ONE instant", () => {
  // The plan's last acceptance clause for Task 6, and the review's finding about it:
  // satisfying it by comparing two copies of the arithmetic would be satisfying the
  // letter. The brief calls this module, so there is one value by construction, and
  // these rows are what would catch the day that stops being true.

  const clear = (over: Partial<ClearObservation> & { observationId: string }): ClearObservation => ({
    namespaceId: NS,
    channel: "price",
    kind: "quote",
    evidenceKind: "wire",
    datedAt: null,
    ingestedAt: AT,
    producer: "test",
    period: "2026-09-01",
    periodExpired: false,
    namespaceErased: false,
    ...over,
  });

  const briefReads = (tags: readonly StoredTag[]): BriefReads => ({
    readClear: async (observationId: string): Promise<ClearObservation> => clear({ observationId }),
    listLive: async (): Promise<readonly StoredTag[]> => tags,
  });

  const briefInput = (over: Partial<BriefInput> = {}): BriefInput => ({
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

  /** Every fixture below runs through both entry points at one `at`. */
  const both = async (
    tags: readonly StoredTag[],
    over: Partial<BriefInput> = {},
  ): Promise<{ fromBrief: number; fromQuery: number; briefBy: readonly string[]; queryBy: readonly string[] }> => {
    const input = briefInput(over);
    const out = await brief(input, briefReads(tags));
    const q = await thresholdFor(
      {
        at: input.at,
        intent: input.intent,
        observationId: input.observationId,
        ownTagIds: input.ownTagIds,
        policy: input.policies.brief,
        halfLifeMs: input.policies.calibration.halfLifeMs,
      },
      reads(tags),
    );
    return {
      fromBrief: out.threshold.applied,
      fromQuery: q.applied,
      briefBy: out.threshold.loweredBy,
      queryBy: q.loweredBy,
    };
  };

  it("agree on an empty counterparty", async () => {
    const r = await both([]);
    expect(r.fromQuery).toBe(r.fromBrief);
    expect(r.queryBy).toEqual(r.briefBy);
  });

  it("agree across a table of fixtures, on the VALUE and on which tags lowered it", async () => {
    const floorElapsed = elapsedAtFloor(1, POLICY.activeFloor);
    const fixtures: [string, StoredTag[]][] = [
      ["one same-aspect tag", [tag({ tagId: "a" })]],
      ["two tags", [tag({ tagId: "a" }), tag({ tagId: "b", aspect: "quoted/XLM" })]],
      ["a faint live tag", [tag({ tagId: "faint", g0: 0.01 })]],
      ["one active and one faint", [tag({ tagId: "a" }), tag({ tagId: "faint", g0: 0.01, aspect: "quoted/XLM" })]],
      ["a tag just above the floor", [tag({ tagId: "above", taggedAt: new Date(AT.getTime() - (floorElapsed - 1)) })]],
      ["a tag just below the floor", [tag({ tagId: "below", taggedAt: new Date(AT.getTime() - (floorElapsed + 1)) })]],
      ["a cross-channel tag", [tag({ tagId: "addr", channel: "address_integrity", aspect: "transition" })]],
      ["a foreign-namespace tag", [tag({ tagId: "foreign", namespaceId: "88888888-0000-4000-8000-000000000008" })]],
      ["the intent's own tag", [tag({ tagId: "own", observationId: INTENT_OBS })]],
      ["a future tag", [tag({ tagId: "future", taggedAt: new Date(AT.getTime() + 1) })]],
    ];
    for (const [label, tags] of fixtures) {
      const r = await both(tags);
      expect(r.fromQuery, label).toBe(r.fromBrief);
      expect(r.queryBy, label).toEqual(r.briefBy);
    }
  });

  it("agree across every riskTier, amount band and reason count a fixture had missed", async () => {
    // FIVE MUTANTS SURVIVED here. Every fixture in the engine suite used
    // `riskTier: "high"`, an amount under 2000, `ownTagIds` of length 0 or 1, and
    // reason counts of 0-3 (or 161/162). So a brief that dropped a reason only for a
    // low or medium tier, or only above 5000, and a `thresholdFor` that disagreed only
    // between 5 and 99 reasons or only when `ownTagIds` had two entries, all passed the
    // whole suite.
    //
    // The consistency rows cannot be "one value by construction" if anything can run
    // AFTER the shared call, and something always can. This sweeps the dimensions the
    // survivors used.
    const many = (n: number): StoredTag[] =>
      Array.from({ length: n }, (_, i) =>
        tag({ tagId: `t${String(i).padStart(3, "0")}`, aspect: `quoted/A${i}`, observationId: `o${i}` }),
      );
    for (const riskTier of ["low", "medium", "high"] as const) {
      for (const amount of [0, 100, 5001, 100000]) {
        for (const count of [0, 1, 5, 7, 40]) {
          for (const ownTagIds of [[], ["t000"], ["t000", "t001"]]) {
            const tags = many(count);
            const r = await both(tags, { riskTier, amount, ownTagIds });
            const label = `${riskTier} amount ${amount} count ${count} own ${ownTagIds.length}`;
            expect(r.fromQuery, label).toBe(r.fromBrief);
            expect(r.queryBy, label).toEqual(r.briefBy);
          }
        }
      }
    }
  });

  it("agree when the caller filters a tag out", async () => {
    const tags = [tag({ tagId: "a" }), tag({ tagId: "b", aspect: "quoted/XLM" })];
    const r = await both(tags, { ownTagIds: ["a"] });
    expect(r.fromQuery).toBe(r.fromBrief);
    expect(r.queryBy).toEqual(["b"]);
  });

  it("agree under a floor that admits only the same aspect", async () => {
    const tags = [
      tag({ tagId: "same" }),
      tag({ tagId: "chan", aspect: "quoted/XLM" }),
      tag({ tagId: "addr", channel: "address_integrity", aspect: "transition" }),
    ];
    const strict = { ...POLICY, relatednessFloor: 1 };
    const r = await both(tags, {
      policies: { ...briefInput().policies, brief: strict },
    });
    expect(r.fromQuery).toBe(r.fromBrief);
    expect(r.queryBy).toEqual(["same"]);
  });

  it("agree at a PAST instant, where R43 changes which tags exist", async () => {
    const tags = [
      tag({ tagId: "old", taggedAt: new Date(AT.getTime() - 3 * 86400000) }),
      tag({ tagId: "new", aspect: "quoted/XLM", taggedAt: AT }),
    ];
    const past = new Date(AT.getTime() - 86400000);
    const r = await both(tags, { at: past });
    expect(r.fromQuery).toBe(r.fromBrief);
    expect(r.queryBy).toEqual(["old"]);
  });

  it("agree when the lowering has collapsed the threshold to zero (R60)", async () => {
    const many = Array.from({ length: 162 }, (_, i) =>
      tag({ tagId: `t${String(i).padStart(4, "0")}`, observationId: `o${i}` }),
    );
    const collapsing = { ...POLICY, activeTagFactor: 0.01 };
    const r = await both(many, { policies: { ...briefInput().policies, brief: collapsing } });
    expect(r.fromBrief).toBe(0);
    expect(r.fromQuery).toBe(0);
  });

  it("does not need the unit, because it has no amount to compare (R27, R44)", async () => {
    // The unit refusal is the BRIEF's, since R44: it exists because an amount is
    // graded against a threshold, and a query returning a threshold has no amount.
    // A `thresholdFor` that demanded a unit would be refusing a question nobody asked.
    const q = await thresholdFor(query(), reads([tag({ tagId: "a" })]));
    expect(q.applied).toBe(500);
    // And the brief still refuses it, which is the half Task 6 must not lose.
    await expect(brief(briefInput({ unit: "XLM" }), briefReads([]))).rejects.toThrow(
      /brief\.unit XLM is not the policy's thresholdUnit USDC/,
    );
  });
});
