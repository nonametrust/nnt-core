import { describe, it, expect } from "vitest";
import { BRIEF_POLICY_V0, type BriefPolicy } from "./policy.js";
import {
  clearsRelatednessFloor,
  isReason,
  relatedness,
  relatednessCase,
  type RelatednessCase,
} from "./relatedness.js";

// R12: how related a piece of evidence is to the intent being briefed.
//
// FOUR CASES, ordered by specificity, and R12 names three of them:
//
//   same namespace, same (channel, aspect)   1
//   same namespace, same channel, other aspect   crossAspectAffinity
//   same namespace, other channel                crossChannelAffinity
//   different namespace                          0
//
// The third case is the one design §9 turns on: the day-twelve tag is
// `address_integrity/transition` and the day-twenty-one intent is `price`, so a
// zero there makes the address change not a reason while §9 and Task 9 both
// require it to be one. The SECOND case is the one R12 leaves out entirely and
// the corpus produces anyway -- `volume/amount/USDC/in` against
// `volume/amount/XLM/in`. The `price/quoted/XLM` fixtures below are SYNTHETIC and
// deliberately so: the function takes three strings and does not care whether the
// corpus ever produced them, and review found an earlier comment here claiming it
// did. A fixture may be invented; a claim about the corpus may not.
//
// The fourth is zero in M3 by R11, and that is a scope exclusion rather than a
// measurement: `continuityAssertionSchema` carries no target namespace, so no
// wire observation can express a link between two counterparties. M4 needs a
// schema change before it can be anything else.

/** A tag's side of the comparison, as the brief will have it. */
const tag = (namespaceId: string, channel: string, aspect: string) => ({ namespaceId, channel, aspect });

// Every number distinct from every other, so a swapped term is visible. The M2
// collision map is why: three fields of the tagging policy were all 3, and a
// wrong-field read returned the right answer.
const policy: BriefPolicy = {
  ...BRIEF_POLICY_V0,
  relatednessFloor: 0.2,
  crossChannelAffinity: 0.41,
  crossAspectAffinity: 0.68,
};

describe("relatedness", () => {
  const intent = tag("ns-provider", "price", "quoted/USDC");

  it("scores the same namespace and the same channel and aspect at 1", () => {
    expect(relatedness(intent, tag("ns-provider", "price", "quoted/USDC"), policy)).toBe(1);
  });

  it("scores the same channel and a DIFFERENT aspect at crossAspectAffinity", () => {
    // The case R12 does not name. Two prices about one counterparty in two
    // currencies are evidence about different quantities and related all the same.
    expect(relatedness(intent, tag("ns-provider", "price", "quoted/XLM"), policy))
      .toBe(policy.crossAspectAffinity);
    // And on a continuous channel with a compound aspect, the same way.
    const volumeIntent = tag("ns-provider", "volume", "amount/USDC/in");
    expect(relatedness(volumeIntent, tag("ns-provider", "volume", "amount/XLM/in"), policy))
      .toBe(policy.crossAspectAffinity);
  });

  it("scores a DIFFERENT channel in the same namespace at crossChannelAffinity", () => {
    // Design §9's own case: an address change bearing on a price intent.
    expect(relatedness(intent, tag("ns-provider", "address_integrity", "transition"), policy))
      .toBe(policy.crossChannelAffinity);
  });

  it("scores a DIFFERENT namespace at zero, which is R11's scope exclusion", () => {
    // Not "unrelated" as a measurement -- unreachable as a data model. A wallet
    // and the endpoint whose payment address it is are linked by a continuity
    // assertion, and that assertion carries no target namespace, so nothing on the
    // wire can say so. M4 gets the schema change; M3 gets the zero.
    expect(relatedness(intent, tag("ns-wallet", "price", "quoted/USDC"), policy)).toBe(0);
    // Zero even when the channel AND aspect match exactly, which is the point: the
    // namespace comparison comes first.
    expect(relatedness(intent, tag("ns-wallet", "address_integrity", "transition"), policy)).toBe(0);
  });

  it("orders the four cases by specificity, with every value distinct", () => {
    // The ordering IS the ruling, so it is asserted as an ordering and not as four
    // separate numbers. A policy that inverted the middle pair is refused by
    // `assertBriefPolicy`; this holds that the function honours the order it
    // declares.
    const same = relatedness(intent, tag("ns-provider", "price", "quoted/USDC"), policy);
    const aspect = relatedness(intent, tag("ns-provider", "price", "quoted/XLM"), policy);
    const channel = relatedness(intent, tag("ns-provider", "address_integrity", "transition"), policy);
    const other = relatedness(intent, tag("ns-wallet", "price", "quoted/USDC"), policy);
    expect(same).toBeGreaterThan(aspect);
    expect(aspect).toBeGreaterThan(channel);
    expect(channel).toBeGreaterThan(other);
    expect(new Set([same, aspect, channel, other]).size).toBe(4);
  });

  it("is symmetric, because relatedness is a comparison and not a direction", () => {
    const a = tag("ns-provider", "price", "quoted/USDC");
    const b = tag("ns-provider", "address_integrity", "transition");
    expect(relatedness(a, b, policy)).toBe(relatedness(b, a, policy));
  });

  it("reads its three numbers from the policy and not from constants", () => {
    // Every term comes from the value, so a champion-challenger run that varies
    // them varies the answer. Held by a second policy whose numbers share nothing
    // with the first.
    const other: BriefPolicy = {
      ...policy, crossChannelAffinity: 0.11, crossAspectAffinity: 0.93, relatednessFloor: 0.05,
    };
    expect(relatedness(intent, tag("ns-provider", "price", "quoted/XLM"), other)).toBe(0.93);
    expect(relatedness(intent, tag("ns-provider", "address_integrity", "transition"), other)).toBe(0.11);
  });
});

describe("clearsRelatednessFloor", () => {
  const intent = tag("ns-provider", "price", "quoted/USDC");

  it("admits a term at the floor, because a reason clears it at equality", () => {
    const atFloor: BriefPolicy = { ...policy, relatednessFloor: policy.crossChannelAffinity };
    expect(clearsRelatednessFloor(intent, tag("ns-provider", "address_integrity", "transition"), atFloor)).toBe(true);
  });

  it("refuses a term below the floor", () => {
    const above: BriefPolicy = { ...policy, relatednessFloor: 0.5 };
    // 0.41 < 0.5: cross-channel evidence stops being a reason.
    expect(clearsRelatednessFloor(intent, tag("ns-provider", "address_integrity", "transition"), above)).toBe(false);
    // 0.68 >= 0.5: cross-aspect evidence still is.
    expect(clearsRelatednessFloor(intent, tag("ns-provider", "price", "quoted/XLM"), above)).toBe(true);
  });

  it("lets the floor pick each of its three meaningful positions", () => {
    // THE POINT OF THE FOURTH TERM. With three relatedness values the floor had one
    // admissible position and every policy partitioned them identically -- measured
    // by review, and the reason the rule that pinned it there was retired. With
    // four, the floor selects which kinds of evidence count, and each selection is
    // a different brief.
    const crossChannel = tag("ns-provider", "address_integrity", "transition");
    const crossAspect = tag("ns-provider", "price", "quoted/XLM");
    const sameAspect = tag("ns-provider", "price", "quoted/USDC");

    const permissive: BriefPolicy = { ...policy, relatednessFloor: 0.1 };
    expect([crossChannel, crossAspect, sameAspect].map((t) => clearsRelatednessFloor(intent, t, permissive)))
      .toEqual([true, true, true]);

    const aspectOnly: BriefPolicy = { ...policy, relatednessFloor: 0.5 };
    expect([crossChannel, crossAspect, sameAspect].map((t) => clearsRelatednessFloor(intent, t, aspectOnly)))
      .toEqual([false, true, true]);

    const exact: BriefPolicy = { ...policy, relatednessFloor: 1 };
    expect([crossChannel, crossAspect, sameAspect].map((t) => clearsRelatednessFloor(intent, t, exact)))
      .toEqual([false, false, true]);
  });

  it("never admits a different namespace, whatever the floor", () => {
    // Zero clears no floor, because every floor is positive. Held rather than
    // assumed: R11 is a scope exclusion and the one thing that must not leak is a
    // cross-namespace reason.
    const other = tag("ns-wallet", "price", "quoted/USDC");
    for (const floor of [0.01, 0.2, 1]) {
      expect(clearsRelatednessFloor(intent, other, { ...policy, relatednessFloor: floor }), `floor ${floor}`)
        .toBe(false);
    }
  });

  it("admits the acceptance scenario's own pair under the SHIPPED policy", () => {
    // Not a synthetic policy: the default that ships. Design §9 requires the
    // day-twelve address change to be a reason for the day-twenty-one price
    // intent, and this is that comparison, made with the numbers a release would
    // actually use.
    expect(clearsRelatednessFloor(intent, tag("ns-provider", "address_integrity", "transition"), BRIEF_POLICY_V0))
      .toBe(true);
  });

  it("names which case it took, so a brief can say why a reason counted", () => {
    // The shape a reason carries. A grade with no account of WHY a piece of
    // evidence was admitted is the thing design §6 exists to avoid.
    const named: RelatednessCase[] = ["same_aspect", "same_channel", "same_namespace", "unrelated"];
    expect(new Set(named).size).toBe(4);
    expect(relatednessCase(intent, tag("ns-provider", "price", "quoted/USDC"))).toBe("same_aspect");
    expect(relatednessCase(intent, tag("ns-provider", "price", "quoted/XLM"))).toBe("same_channel");
    expect(relatednessCase(intent, tag("ns-provider", "address_integrity", "transition")))
      .toBe("same_namespace");
    expect(relatednessCase(intent, tag("ns-wallet", "price", "quoted/USDC"))).toBe("unrelated");
  });
});

// R39: the predicate that decides BOTH what lowers the threshold and what the
// brief may cite. Two review lenses converged on this independently.
describe("isReason", () => {
  const intent = tag("ns-provider", "price", "quoted/USDC");
  const withStrength = (t: ReturnType<typeof tag>, strength: number) => ({
    ...t, tagId: `tag-${strength}`, strength,
  });

  it("wants BOTH floors, which is design §6:263's conjunction", () => {
    // "keep those whose relatedness AND decayed strength clear their thresholds".
    // Related and active: a reason.
    expect(isReason(withStrength(intent, 0.9), intent, policy)).toBe(true);
    // Related and NOT active.
    expect(isReason(withStrength(intent, 0.01), intent, policy)).toBe(false);
    // Active and NOT related: a different namespace scores zero, which clears no
    // floor.
    expect(isReason(withStrength(tag("ns-other", "price", "quoted/USDC"), 0.9), intent, policy))
      .toBe(false);
    // Neither.
    expect(isReason(withStrength(tag("ns-other", "price", "quoted/USDC"), 0.01), intent, policy))
      .toBe(false);
  });

  it("closes the unaccounted hold that the two halves apart allowed", () => {
    // MEASURED BEFORE THIS EXISTED, with a policy `assertBriefPolicy` accepts: at
    // `relatednessFloor` 0.9 the day-twelve address tag scores 0.55 -- not a reason
    // -- and is active at its real strength 0.4165, so it lowered 600 to 480 and
    // `gradeFor(500, 480, 0)` returned `hold` while the unlowered bar gave `clear`.
    // The tag decided the grade and the brief could not cite it, which `grade.ts`
    // calls the thing design §6 exists to avoid.
    //
    // With one predicate for both jobs the case cannot arise: a tag that does not
    // clear this test does not lower anything either.
    const strict: BriefPolicy = { ...BRIEF_POLICY_V0, relatednessFloor: 0.9 };
    const address = withStrength(tag("ns-provider", "address_integrity", "transition"), 0.4165);
    expect(isReason(address, intent, strict)).toBe(false);
    // And under the shipped policy the same tag counts, which is what §9 needs.
    expect(isReason(address, intent, BRIEF_POLICY_V0)).toBe(true);
  });

  it("admits a tag exactly AT each floor, because both comparisons are >=", () => {
    const atActive = withStrength(intent, policy.activeFloor);
    expect(isReason(atActive, intent, policy)).toBe(true);
    // A STRENGTH BETWEEN THE TWO FLOORS, which is what makes a swap visible. The
    // fixture sets `relatednessFloor: 0.2` and inherits `activeFloor: 0.25`, and no
    // other case sat between them -- so comparing the strength against the WRONG
    // floor passed every test in the engine. Measured by review, and it is the M2
    // collision map again: this fixture's own comment claims every number is
    // distinct "so a swapped term is visible", which was false for this pair.
    expect(policy.relatednessFloor).toBeLessThan(policy.activeFloor);
    expect(isReason(withStrength(intent, 0.22), intent, policy)).toBe(false);
    // And a strength of exactly ZERO is admissible as an input and is not a reason.
    // `strengthAt` really returns 0 for a live row at about 1100 half-lives, so a
    // guard that refused 0 would crash a brief on a legitimate tag.
    expect(isReason(withStrength(intent, 0), intent, policy)).toBe(false);
    const atRelated: BriefPolicy = { ...policy, relatednessFloor: policy.crossChannelAffinity };
    const crossChannel = withStrength(tag("ns-provider", "address_integrity", "transition"), 0.9);
    expect(isReason(crossChannel, intent, atRelated)).toBe(true);
  });

  it("refuses a strength that is not a number the comparison can trust", () => {
    // A NaN strength fails `>=` and would report "not a reason" -- the SOFTEST
    // answer from the worst input, which is what `holdsAt` and `gradeFor` both
    // refuse instead.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      expect(() => isReason(withStrength(intent, bad), intent, policy), `strength ${bad}`)
        .toThrow(RangeError);
    }
  });

  it("is the LOWERING set as well as the citing set, and says so", () => {
    // R39's whole point. Held as a documented identity rather than as two
    // functions that might drift: `loweringTags` is `reasons`, so the count that
    // lowers the threshold is the count `gradeFor` receives.
    const tags = [
      withStrength(tag("ns-provider", "price", "quoted/USDC"), 0.9),
      withStrength(tag("ns-provider", "address_integrity", "transition"), 0.4165),
      withStrength(tag("ns-provider", "price", "quoted/XLM"), 0.01),
      withStrength(tag("ns-other", "price", "quoted/USDC"), 0.9),
    ];
    const reasons = tags.filter((t) => isReason(t, intent, BRIEF_POLICY_V0));
    expect(reasons.map((r) => r.strength)).toEqual([0.9, 0.4165]);
  });
});
