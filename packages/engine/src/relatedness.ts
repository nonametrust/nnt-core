import type { BriefPolicy } from "./policy.js";

/**
 * One side of a relatedness comparison: which counterparty the evidence is
 * about, and which quantity it measures.
 *
 * Deliberately NOT a `Reading` from `@nonametrust/tagging` and not a tag row
 * from the store. Relatedness needs three strings and nothing else, and a
 * function that took either of those richer types would be a function a caller
 * could only use by having one -- so the brief can compare a tag against an
 * intent without either being converted into the other's shape.
 */
export interface Related {
  namespaceId: string;
  channel: string;
  aspect: string;
}

/**
 * Which of the four cases a comparison fell into, so a brief can say WHY a
 * piece of evidence was admitted rather than only that it was. A grade with no
 * account of itself is what design §6 exists to avoid.
 */
export type RelatednessCase = "same_aspect" | "same_channel" | "same_namespace" | "unrelated";

/**
 * Which case these two fall into. Separate from the score because the case is
 * what a reason reports and the score is what the floor compares; deriving one
 * from the other by matching on a float would be a comparison nobody should have
 * to write twice.
 */
export function relatednessCase(a: Related, b: Related): RelatednessCase {
  if (a.namespaceId !== b.namespaceId) return "unrelated";
  if (a.channel !== b.channel) return "same_namespace";
  return a.aspect === b.aspect ? "same_aspect" : "same_channel";
}

/**
 * How related two pieces of evidence about a counterparty are, in [0, 1].
 *
 * R12, WITH THE CASE R12 DOES NOT NAME. Four values, ordered by specificity:
 *
 * - **1** -- same namespace, same channel, same aspect. The same quantity about
 *   the same counterparty.
 * - **`crossAspectAffinity`** -- same namespace, same channel, DIFFERENT aspect.
 *   `volume/amount/USDC/in` against `volume/amount/XLM/in`, which the corpus
 *   really does produce: measured, the five aspects it reads into are
 *   `address_integrity/transition`, `price/quoted/USDC`,
 *   `protocol/event/trustline_open`, `volume/amount/USDC/in` and
 *   `volume/amount/XLM/in`. R12 names three terms and the data model has four;
 *   this is the missing one. An earlier version of this comment also claimed
 *   `price/quoted/XLM`, which the corpus does NOT contain -- a claim about what
 *   the corpus holds is a claim that gets replayed. Design §1 puts aspect matching inside `rel()`
 *   rather than outside it, so it was never out of scope -- only unruled, which
 *   meant it would have been decided on the day Task 4 met a second aspect, by
 *   whichever branch happened to catch it.
 * - **`crossChannelAffinity`** -- same namespace, different channel. This is the
 *   term design §9 turns on: the day-twelve tag is
 *   `address_integrity/transition` and the day-twenty-one intent is `price`, so a
 *   zero here makes the address change not a reason while §9 and Task 9 both
 *   require it to be one. The first version of M3's plan made this term zero by
 *   implication and would have discovered the contradiction on its last task.
 * - **0** -- different namespace. **A SCOPE EXCLUSION AND NOT A MEASUREMENT**
 *   (R11). A wallet and the endpoint whose payment address it is are linked by a
 *   continuity assertion, and `continuityAssertionSchema` is
 *   `{assertedBy, assertedAt, reason}` -- there is no target namespace in it, so
 *   no wire observation can express the link and a table for it would be
 *   populated by nothing but a test. M4 needs a versioned wire change first.
 *
 * THE ORDER OF THE TWO MIDDLE TERMS IS THE SHIPPED DEFAULT'S ASSUMPTION, not a
 * property of relatedness. `BRIEF_POLICY_V0` puts `crossAspectAffinity` above
 * `crossChannelAffinity` on the argument that evidence about another quantity on
 * the same channel is closer than evidence on another channel -- and nobody has
 * measured that. Under those numbers a payment address CHANGING scores 0.55
 * against a price intent while a quote in another currency scores 0.75, so
 * identity evidence ranks lower, which is at least arguable. `assertBriefPolicy`
 * therefore does NOT impose the order: a challenger may invert it, and that is an
 * experiment the version composite exists to run. This function returns whatever
 * the policy says.
 *
 * SYMMETRIC, because relatedness is a comparison and not a direction: evidence
 * A bearing on intent B is as related as B bearing on A. The brief always asks
 * it one way round, and a function that quietly depended on the order would be a
 * trap for whoever asks it the other way.
 *
 * The namespace comparison comes FIRST, so a different counterparty scores zero
 * even when its channel and aspect match exactly. That ordering is R11, not an
 * optimisation.
 */
export function relatedness(a: Related, b: Related, policy: BriefPolicy): number {
  switch (relatednessCase(a, b)) {
    case "same_aspect":
      return 1;
    case "same_channel":
      return policy.crossAspectAffinity;
    case "same_namespace":
      return policy.crossChannelAffinity;
    case "unrelated":
      return 0;
  }
}

/**
 * Whether this evidence clears the RELATEDNESS floor for this intent.
 *
 * NAMED FOR THE ONE FLOOR IT CHECKS, and its name is the smaller half of a
 * two-part history. It was once called `isReason`, which claimed more than it
 * held: design §6:266 says a reason is evidence "whose relatedness AND decayed
 * strength clear their thresholds", so relatedness is one of two conditions. It was
 * renamed to what it checks.
 *
 * R39 then brought `isReason` back, forty lines below and in this same file, as the
 * CONJUNCTION -- so the `activeFloor` comparison lives here too and not with the
 * brief, which an earlier version of this paragraph said. It could not live with the
 * brief now even by choice: `no-floor-outside-relatedness.test.ts` refuses either
 * floor to be named in any module but this one and `policy.ts`.
 *
 * Measured consequence of getting it wrong, from review: the day-twelve address
 * tag at three thousand six hundred and fifty days has a decayed strength of
 * 2.1e-79 and is still perfectly related, so a brief counting reasons on
 * relatedness alone would carry it forever.
 *
 * `>=`, so a term equal to the floor is a reason -- the floor is declared as "the
 * relatedness at or above which a tag is a reason", and the comparison has to
 * match the words.
 *
 * WHAT THE FLOOR NOW DECIDES, and it decided nothing before
 * `crossAspectAffinity` existed. With three values the floor had exactly one
 * admissible position, because a retired rule required it to sit at or below the
 * smallest non-zero term -- so every admissible policy partitioned those values
 * identically and two policies differing only in the floor returned byte-identical
 * briefs, which review measured. With four values it has three positions and each
 * is a different brief:
 *
 * - at or below `crossChannelAffinity`: every same-namespace term counts
 * - above it but at or below `crossAspectAffinity`: cross-channel evidence is
 *   excluded, evidence on the same channel still counts
 * - above `crossAspectAffinity`: only the same aspect counts
 *
 * Those are configuration choices a challenger policy should be able to make,
 * which is why the rule that forbade two of them is gone. What the SHIPPED
 * default must do -- admit cross-channel evidence, because §9 needs it -- is
 * asserted on `BRIEF_POLICY_V0` itself rather than imposed on every policy.
 *
 * A different namespace never clears any floor, because zero clears nothing and
 * every floor is positive. That is the one thing R11 must not leak.
 */
export function clearsRelatednessFloor(a: Related, b: Related, policy: BriefPolicy): boolean {
  return relatedness(a, b, policy) >= policy.relatednessFloor;
}

/**
 * A tag as the brief compares it: which counterparty and quantity it is about,
 * its identity, and its DECAYED STRENGTH at the brief's instant.
 *
 * The strength is an input rather than something computed here, for the reason
 * `@nonametrust/tagging` gives: `strengthAt` lives in the store, so a live tag's
 * decayed strength is handed to the arithmetic and never derived inside it.
 */
export interface TagFacts extends Related {
  tagId: string;
  /** `strengthAt(tag, at)` from the store, at the brief's own instant. */
  strength: number;
}

/**
 * Whether this tag is a REASON for this intent — and therefore also whether it
 * LOWERS this intent's threshold. **One predicate for both jobs (R39).**
 *
 * DESIGN §6:263 IS A CONJUNCTION and the code did not implement it: "keep those
 * whose relatedness AND decayed strength clear their thresholds". R3 made
 * "active" a strength comparison, R12 made "reason" a relatedness comparison,
 * and nothing tied them — so the two sets could diverge, and two review lenses
 * converged independently on the same finding.
 *
 * MEASURED, with a policy `assertBriefPolicy` accepts (`relatednessFloor: 0.9`):
 * the day-twelve address tag scores 0.55 and is therefore NOT a reason, while at
 * its real strength of 0.4165 it IS active — so it lowered 600 to 480 and a
 * 500-unit intent graded `hold` where the unlowered bar gave `clear`. **The tag
 * decided the grade and the brief could not cite it**, which `grade.ts` calls the
 * thing design §6 exists to avoid. The other direction was reachable under the
 * SHIPPED policy: a same-aspect tag decayed to 0.01 is not active and was still a
 * reason, so `watch` on evidence that had decayed below the active floor.
 *
 * With one predicate the divergence cannot occur: a tag that fails this does not
 * lower anything either, so a hold caused by a tag always has that tag among its
 * reasons and the only zero-reason hold is a hold on the amount alone.
 *
 * WHAT IT COSTS, recorded where the rule lives: there is no intent-free threshold
 * once relatedness gates the lowering, so `thresholdFor(namespaceId, at)` cannot
 * be Task 6's signature — it has to take the intent. Design §6's "the engine
 * exposes the current threshold as a query" either goes or becomes a second query
 * no brief uses.
 *
 * Both comparisons are `>=`, matching how both floors are declared: "at or
 * above". A strength that is not a number the comparison can trust is REFUSED
 * rather than reported as "not a reason" — the softest answer from the worst
 * input is what `holdsAt` and `gradeFor` both refuse.
 */
export function isReason(tag: TagFacts, intent: Related, policy: BriefPolicy): boolean {
  if (!Number.isFinite(tag.strength) || tag.strength < 0) {
    throw new RangeError(
      `tag ${tag.tagId} has a strength that is not a non-negative finite number: ${tag.strength}`,
    );
  }
  if (tag.strength < policy.activeFloor) return false;
  return clearsRelatednessFloor(intent, tag, policy);
}
