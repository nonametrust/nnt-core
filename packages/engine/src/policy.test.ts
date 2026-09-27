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
    it.each([
      ["version", "" as const, /briefPolicy\.version/],
      ["version", "   " as const, /briefPolicy\.version/],
      // R26 joins four versions as `retention/tagging/calibration/brief` and
      // says no component may contain the separator. Nothing held that.
      ["version", "brief/v0" as const, /briefPolicy\.version.*separator|separator.*briefPolicy\.version/],
      ["thresholdUnit", "" as const, /briefPolicy\.thresholdUnit/],
      ["thresholdUnit", "  " as const, /briefPolicy\.thresholdUnit/],
      ["briefThreshold", 0, /briefPolicy\.briefThreshold/],
      ["briefThreshold", -1, /briefPolicy\.briefThreshold/],
      ["briefThreshold", Number.POSITIVE_INFINITY, /briefPolicy\.briefThreshold/],
      ["briefThreshold", Number.NaN, /briefPolicy\.briefThreshold/],
      ["activeTagFactor", 0, /briefPolicy\.activeTagFactor/],
      // A factor of exactly 1 multiplies the threshold by itself: an active
      // tag that lowers nothing. Task 9's acceptance turns on this -- "lower
      // than it was" is satisfiable with a factor of 1 -- so 1 is refused
      // here rather than caught by a comparison nine tasks later.
      ["activeTagFactor", 1, /briefPolicy\.activeTagFactor/],
      ["activeTagFactor", 1.5, /briefPolicy\.activeTagFactor/],
      ["activeFloor", 0, /briefPolicy\.activeFloor/],
      ["activeFloor", 1.01, /briefPolicy\.activeFloor/],
      ["relatednessFloor", 0, /briefPolicy\.relatednessFloor/],
      ["relatednessFloor", 1.01, /briefPolicy\.relatednessFloor/],
      // R12: the same-namespace-different-channel term is NOT zero, because
      // the acceptance scenario's own case is same namespace, different
      // channel, and a zero there makes the address change not a reason.
      ["crossChannelAffinity", 0, /briefPolicy\.crossChannelAffinity/],
      // Nor is it 1: at 1 a different channel is worth exactly as much as the
      // same one and the term it exists to express is gone.
      ["crossChannelAffinity", 1, /briefPolicy\.crossChannelAffinity/],
      ["mediumCeiling", 0, /briefPolicy\.mediumCeiling/],
      ["mediumCeiling", -5, /briefPolicy\.mediumCeiling/],
      ["maxRetries", 0, /briefPolicy\.maxRetries/],
      ["maxRetries", -1, /briefPolicy\.maxRetries/],
      // A bound of 2.5 retries is a bound nothing can honour exactly.
      ["maxRetries", 2.5, /briefPolicy\.maxRetries/],
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
