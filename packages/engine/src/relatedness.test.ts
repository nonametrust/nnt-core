import { describe, it, expect } from "vitest";
import { BRIEF_POLICY_V0, type BriefPolicy } from "./policy.js";
import { isReason, relatedness, relatednessCase, type RelatednessCase } from "./relatedness.js";

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
// the corpus produces anyway -- `price/quoted/USDC` against `price/quoted/XLM`.
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

describe("isReason", () => {
  const intent = tag("ns-provider", "price", "quoted/USDC");

  it("admits a term at the floor, because a reason clears it at equality", () => {
    const atFloor: BriefPolicy = { ...policy, relatednessFloor: policy.crossChannelAffinity };
    expect(isReason(intent, tag("ns-provider", "address_integrity", "transition"), atFloor)).toBe(true);
  });

  it("refuses a term below the floor", () => {
    const above: BriefPolicy = { ...policy, relatednessFloor: 0.5 };
    // 0.41 < 0.5: cross-channel evidence stops being a reason.
    expect(isReason(intent, tag("ns-provider", "address_integrity", "transition"), above)).toBe(false);
    // 0.68 >= 0.5: cross-aspect evidence still is.
    expect(isReason(intent, tag("ns-provider", "price", "quoted/XLM"), above)).toBe(true);
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
    expect([crossChannel, crossAspect, sameAspect].map((t) => isReason(intent, t, permissive)))
      .toEqual([true, true, true]);

    const aspectOnly: BriefPolicy = { ...policy, relatednessFloor: 0.5 };
    expect([crossChannel, crossAspect, sameAspect].map((t) => isReason(intent, t, aspectOnly)))
      .toEqual([false, true, true]);

    const exact: BriefPolicy = { ...policy, relatednessFloor: 1 };
    expect([crossChannel, crossAspect, sameAspect].map((t) => isReason(intent, t, exact)))
      .toEqual([false, false, true]);
  });

  it("never admits a different namespace, whatever the floor", () => {
    // Zero clears no floor, because every floor is positive. Held rather than
    // assumed: R11 is a scope exclusion and the one thing that must not leak is a
    // cross-namespace reason.
    const other = tag("ns-wallet", "price", "quoted/USDC");
    for (const floor of [0.01, 0.2, 1]) {
      expect(isReason(intent, other, { ...policy, relatednessFloor: floor }), `floor ${floor}`)
        .toBe(false);
    }
  });

  it("admits the acceptance scenario's own pair under the SHIPPED policy", () => {
    // Not a synthetic policy: the default that ships. Design §9 requires the
    // day-twelve address change to be a reason for the day-twenty-one price
    // intent, and this is that comparison, made with the numbers a release would
    // actually use.
    expect(isReason(intent, tag("ns-provider", "address_integrity", "transition"), BRIEF_POLICY_V0))
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
