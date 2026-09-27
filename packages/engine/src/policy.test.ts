import { describe, it, expect } from "vitest";
import { BRIEF_POLICY_V0, assertBriefPolicy, type BriefPolicy } from "./policy.js";

// Every field refused by a message that names it, and the shipped default
// proven to hold its own rules.
//
// Why the refusals are tested one field at a time rather than "a bad policy is
// refused": the M2 collision map. `thresholdBase`, `surpriseScale` and
// `winsorMadMultiple` are all 3 in the tagging policy, so a computation
// reading the WRONG field of a default policy returned the right number and
// no test could see it. Three fields sharing a value is a whole class of bug
// that a test suite cannot reach, so this file holds the shipped default's
// numbers to being pairwise distinct as a rule of its own.

/** A policy with one field replaced, for the refusal table below. */
function withField<K extends keyof BriefPolicy>(field: K, value: BriefPolicy[K]): BriefPolicy {
  return { ...BRIEF_POLICY_V0, [field]: value };
}

/** Every numeric field of the policy, which is every field but the two strings. */
const NUMERIC_FIELDS = [
  "briefThreshold",
  "activeTagFactor",
  "activeFloor",
  "relatednessFloor",
  "crossChannelAffinity",
  "mediumCeiling",
  "maxRetries",
] as const satisfies ReadonlyArray<keyof BriefPolicy>;

describe("BriefPolicy", () => {
  it("ships a default that holds its own rules", () => {
    expect(() => assertBriefPolicy(BRIEF_POLICY_V0)).not.toThrow();
  });

  it("declares exactly the fields this milestone rules, and no more", () => {
    // Pinned lexically. The plan said "seven fields" in two places and named
    // two different sevens -- R27's list leaves out `maxRetries`, which R28
    // puts here, and neither carries the `version` that R26's composite reads.
    // Nine is what the rulings together require, and a field arriving or
    // leaving quietly is what this holds.
    expect(Object.keys(BRIEF_POLICY_V0).sort()).toEqual([
      "activeFloor",
      "activeTagFactor",
      "briefThreshold",
      "crossChannelAffinity",
      "maxRetries",
      "mediumCeiling",
      "relatednessFloor",
      "thresholdUnit",
      "version",
    ]);
  });

  describe("refuses each field by name", () => {
    // The value in each row is bad for that field and for no other reason, so
    // a refusal naming a different field is a wrong-field read and not a pass.
    //
    // AND EACH ROW DEMANDS ITS OWN BOUND'S PHRASING, not merely the field's
    // name. Review measured what the looser pattern cost: deleting
    // `relatednessFloor`'s interval check left its `1.01` row GREEN, and deleting
    // `crossChannelAffinity`'s lower bound left its `0` row green, because in
    // both cases the CROSS-FIELD rule then fired and its message also names the
    // field. A row satisfied by a different rule's refusal is not that row's
    // bound being held -- it is the same wrong-killer mistake this repository
    // once wrote into a commit message as "measured", one layer down.
    it.each([
      ["version", "" as const, /briefPolicy\.version must not be blank/],
      ["version", "   " as const, /briefPolicy\.version must not be blank/],
      // R26 joins four versions as `retention/tagging/calibration/brief` and
      // says no component may contain the separator. Nothing held that.
      ["version", "brief/v0" as const, /briefPolicy\.version.*separator|separator.*briefPolicy\.version/],
      ["thresholdUnit", "" as const, /briefPolicy\.thresholdUnit must not be blank/],
      ["thresholdUnit", "  " as const, /briefPolicy\.thresholdUnit must not be blank/],
      // Refused rather than trimmed on read. R27 makes an intent whose unit
      // differs a NAMED REFUSAL and not a coercion, and Task 6 compares the
      // two units; against a padded policy that comparison refuses a correct
      // intent, which is the coercion problem arriving as a false refusal
      // instead. So the padding is refused where it is declared.
      ["thresholdUnit", " USDC " as const, /briefPolicy\.thresholdUnit must not be padded/],
      ["briefThreshold", 0, /briefPolicy\.briefThreshold must be a positive finite/],
      ["briefThreshold", -1, /briefPolicy\.briefThreshold must be a positive finite/],
      ["briefThreshold", Number.POSITIVE_INFINITY, /briefPolicy\.briefThreshold must be a positive finite/],
      ["briefThreshold", Number.NaN, /briefPolicy\.briefThreshold must be a positive finite/],
      ["activeTagFactor", 0, /briefPolicy\.activeTagFactor must lie in/],
      // A factor of exactly 1 multiplies the threshold by itself: an active
      // tag that lowers nothing. Task 9's acceptance turns on this -- "lower
      // than it was" is satisfiable with a factor of 1 -- so 1 is refused
      // here rather than caught by a comparison nine tasks later.
      ["activeTagFactor", 1, /briefPolicy\.activeTagFactor must lie in/],
      ["activeTagFactor", 1.5, /briefPolicy\.activeTagFactor must lie in/],
      ["activeFloor", 0, /briefPolicy\.activeFloor must lie in/],
      ["activeFloor", 1.01, /briefPolicy\.activeFloor must lie in/],
      ["relatednessFloor", 0, /briefPolicy\.relatednessFloor must lie in/],
      ["relatednessFloor", 1.01, /briefPolicy\.relatednessFloor must lie in/],
      // Open at 1, and the reason is a correction. The first version declared
      // (0, 1] and documented a floor of 1 as the way to express
      // "only same-channel evidence counts" -- which the cross-field rule
      // below makes UNREACHABLE under any affinity, since an affinity must be
      // at least the floor and is itself capped below 1. Measured: refused at
      // affinity 0.55, at 0.999, and at 1. So the effective range was already
      // (0, 1) and the declared bound said otherwise; it is declared open now
      // so the refusal names THIS field instead of arriving from the pair.
      // The regex demands the FIELD's own phrasing ("must lie in"), not merely
      // the field's name: the cross-field rule further down also names
      // `relatednessFloor` in its message, so a looser pattern here was green
      // while the field's bound admitted 1. A refusal arriving from the pair is
      // not this row's rule being held.
      ["relatednessFloor", 1, /relatednessFloor must lie in/],
      // R12: the same-namespace-different-channel term is NOT zero, because
      // the acceptance scenario's own case is same namespace, different
      // channel, and a zero there makes the address change not a reason.
      ["crossChannelAffinity", 0, /briefPolicy\.crossChannelAffinity must lie in/],
      // Nor is it 1: at 1 a different channel is worth exactly as much as the
      // same one and the term it exists to express is gone.
      ["crossChannelAffinity", 1, /briefPolicy\.crossChannelAffinity must lie in/],
      ["mediumCeiling", 0, /briefPolicy\.mediumCeiling must be a positive finite/],
      ["mediumCeiling", -5, /briefPolicy\.mediumCeiling must be a positive finite/],
      ["maxRetries", 0, /briefPolicy\.maxRetries must be a positive integer/],
      ["maxRetries", -1, /briefPolicy\.maxRetries must be a positive integer/],
      // A bound of 2.5 retries is a bound nothing can honour exactly.
      ["maxRetries", 2.5, /briefPolicy\.maxRetries must be a positive integer/],
    ] as const)("%s = %s", (field, value, message) => {
      expect(() => assertBriefPolicy(withField(field, value as never))).toThrow(message);
    });
  });

  it("refuses a cross-channel affinity that cannot clear the relatedness floor", () => {
    // Not a per-field bound: each of the two is in range and the PAIR is
    // inverted. Below the floor, the term R12 exists to make non-zero can
    // never produce a reason, so relatedness silently becomes
    // same-channel-only and the acceptance scenario's address change stops
    // being a reason -- the exact failure R12 was written to prevent, wearing
    // a valid-looking policy.
    //
    // The cost, stated: this policy cannot express "only same-channel
    // evidence counts". That configuration is reachable by raising the floor
    // to 1, which admits the same-(channel, aspect) term alone.
    const inverted = { ...BRIEF_POLICY_V0, crossChannelAffinity: 0.2, relatednessFloor: 0.9 };
    expect(() => assertBriefPolicy(inverted)).toThrow(/crossChannelAffinity.*relatednessFloor/);
    // At the floor exactly it clears, because the comparison a reason makes is
    // `>=` and a term equal to the floor is a reason.
    const atTheFloor = { ...BRIEF_POLICY_V0, crossChannelAffinity: 0.4, relatednessFloor: 0.4 };
    expect(() => assertBriefPolicy(atTheFloor)).not.toThrow();
  });

  it("ACCEPTS the ends that are meant to be admissible, which no refusal row can show", () => {
    // A refusal table holds only one side of a bound. Review measured what that
    // costs: flipping `activeFloor`'s interval from closed-at-1 to open
    // SURVIVED every test, because nothing asserted that 1 is accepted. A bound
    // is two claims and a suite that tests one of them holds half a rule.
    //
    // `activeFloor` of 1 is the OFF setting -- a saturated tag at the instant of
    // its own refresh and nothing else -- so it must be admissible, and Task 6
    // builds the threshold on exactly this.
    expect(() => assertBriefPolicy({ ...BRIEF_POLICY_V0, activeFloor: 1 })).not.toThrow();
    // And just inside each open end, so flipping those to closed is visible too.
    expect(() =>
      assertBriefPolicy({ ...BRIEF_POLICY_V0, activeTagFactor: 0.999999 }),
    ).not.toThrow();
    expect(() =>
      assertBriefPolicy({ ...BRIEF_POLICY_V0, relatednessFloor: 0.999, crossChannelAffinity: 0.9995 }),
    ).not.toThrow();
    expect(() =>
      assertBriefPolicy({ ...BRIEF_POLICY_V0, crossChannelAffinity: 0.999999 }),
    ).not.toThrow();
    expect(() => assertBriefPolicy({ ...BRIEF_POLICY_V0, maxRetries: 1 })).not.toThrow();
  });

  it("refuses a medium ceiling at or above the threshold it is meant to sit under", () => {
    // R27 moved this ceiling OFF the brief's input and onto the policy for one
    // reason: design §6:281 says degrading availability is not a way to bypass
    // the layer, and a caller supplying its own ceiling is a caller raising it.
    // The same argument reaches the ceiling's VALUE, which nothing held.
    //
    // Measured: with the shipped threshold of 3000, ceilings of 5000, 3000 and
    // 2900 were all accepted. At a ceiling of 5000 a medium-risk intent of 4000
    // PROCEEDS while a store is unreachable and is HELD when it is reachable --
    // the layer bypassed by making it unavailable, wearing a valid-looking
    // policy.
    expect(() => assertBriefPolicy({ ...BRIEF_POLICY_V0, mediumCeiling: 5000 })).toThrow(
      /mediumCeiling.*briefThreshold/,
    );
    expect(() => assertBriefPolicy({ ...BRIEF_POLICY_V0, mediumCeiling: 3000 })).toThrow(
      /mediumCeiling.*briefThreshold/,
    );
    // Strictly below, and the argument for strictness is WEAKER than an earlier
    // version of this comment claimed. It said "at equality an intent AT the
    // threshold is held when reachable and proceeds when not" -- which is false:
    // under the declared semantics an intent equal to both is held when
    // reachable and is NOT below the ceiling when unreachable, so equality is
    // coherent and `<=` would have served. `<` is kept because it is one point
    // stricter in the direction §6:281 cares about and costs nothing, but the
    // equality case is Task 7's to rule, and it is unruled there today.
    expect(() =>
      assertBriefPolicy({ ...BRIEF_POLICY_V0, mediumCeiling: 2999, briefThreshold: 3000 }),
    ).not.toThrow();
  });

  it("does not claim that ceiling rule is sufficient, because it is not", () => {
    // NECESSARY AND NOT SUFFICIENT, stated as a test so the limit is not just
    // a sentence. An active tag multiplies the threshold down, so a
    // counterparty with enough active tags has a LOWERED threshold below the
    // ceiling, and the unavailable path is more permissive than the available
    // one again. Measured: 3000 × 0.8^7 = 629.15, under the shipped ceiling of
    // 750. Nothing in M3 bounds the number of active tags, so this cannot be
    // closed by a policy rule; it is closed, if ever, by a floor under the
    // lowered threshold, which is a number nobody has measured.
    const { briefThreshold, activeTagFactor, mediumCeiling } = BRIEF_POLICY_V0;
    let lowered = briefThreshold;
    let tags = 0;
    while (lowered >= mediumCeiling) {
      lowered *= activeTagFactor;
      tags += 1;
    }
    expect(tags).toBe(7);
    expect(lowered).toBeLessThan(mediumCeiling);
    // And the policy accepts that configuration, which is the point of the test.
    expect(() => assertBriefPolicy(BRIEF_POLICY_V0)).not.toThrow();
  });

  it("ships no two numbers the same, so a wrong-field read cannot return the right answer", () => {
    // The M2 collision map is why this is a rule and not a coincidence.
    const values = NUMERIC_FIELDS.map((f) => BRIEF_POLICY_V0[f]);
    expect(new Set(values).size, `two of ${NUMERIC_FIELDS.join(", ")} share a value: ${values.join(", ")}`)
      .toBe(NUMERIC_FIELDS.length);
  });

  it("keeps activeFloor away from the band where the scenario's two tags coincide", () => {
    // Measured during the review of this plan: at the calibrated half-life the
    // day-twelve address tag decays to 0.4165 by day twenty-one and the price
    // tag the day-twenty-one quote opens sits at 0.4151 -- 0.0014 apart. A
    // floor chosen in that band flips which tag is active between two
    // scenarios that differ in nothing else. Held as a test because §6 records
    // the hazard and nothing else refuses a value inside it.
    const [low, high] = [0.41, 0.42];
    expect(
      BRIEF_POLICY_V0.activeFloor < low || BRIEF_POLICY_V0.activeFloor > high,
      `activeFloor ${BRIEF_POLICY_V0.activeFloor} lies in the coincidence band [${low}, ${high}]`,
    ).toBe(true);
  });

  it("names the unit its two amounts are in", () => {
    // R27: `briefThreshold` and `mediumCeiling` are amounts in ONE declared
    // unit, and an intent whose unit differs is refused rather than coerced.
    // The refusal is Task 6's; that the unit is declared at all is this
    // task's, and a blank one is refused above.
    expect(BRIEF_POLICY_V0.thresholdUnit.trim()).not.toBe("");
  });
});
