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
 * `g0 × 0.5^(elapsed / halfLife) = floor`, so `elapsed = halfLife × log2(g0/floor)`.
 * Derived rather than hard-coded, because a hard-coded 28 days is only right for
 * `g0 = 1`, `floor = 0.25` and this half-life, and a test that silently stops
 * straddling the floor when a number moves is the fixture-collision failure again.
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

    it("straddles the floor by about 2.4e-10, which is why one millisecond is enough", async () => {
      // The number the plan quotes, checked rather than trusted. If the half-life ever
      // moves far enough that a millisecond stops separating the two, this row says so
      // before the two rows above start passing for the wrong reason.
      const base = elapsedAtFloor(1, POLICY.activeFloor);
      const above = strengthAt(tag({ tagId: "x", taggedAt: new Date(AT.getTime() - (base - 1)) }), AT, HALF_LIFE);
      const below = strengthAt(tag({ tagId: "y", taggedAt: new Date(AT.getTime() - (base + 1)) }), AT, HALF_LIFE);
      const gap = above - below;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(1e-9);
      expect(gap).toBeGreaterThan(1e-11);
    });

    it("counts a tag AT the floor exactly, because the floor is declared 'at or above'", async () => {
      // A strength landing exactly on the floor is not reachable by choosing an
      // elapsed time -- the arithmetic gives a neighbouring double -- so this uses a
      // `g0` that IS the floor at zero elapsed. That is the `g0 == floor` fixture the
      // rows above deliberately avoid, used here for the one thing it is right for.
      const atFloor = tag({ tagId: "exact", g0: POLICY.activeFloor, taggedAt: AT });
      expect(strengthAt(atFloor, AT, HALF_LIFE)).toBe(POLICY.activeFloor);
      const out = await thresholdFor(query(), reads([atFloor]));
      expect(out.loweredBy).toEqual(["exact"]);
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
