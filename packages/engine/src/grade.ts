/**
 * The brief's answer, least concerned first.
 *
 * The ORDER is declared here once, so a caller comparing two grades and the
 * monotonicity tests beside this module read it from the same place rather than
 * each hard-coding a ranking.
 *
 * §7 of M3's plan rules this vocabulary PROVISIONALLY: the design's §6 names
 * `hold` and nothing else, and no document in this repository carries the output
 * shape the founder brief is said to fix. So this is the plan's provisional
 * ruling made real, and it is the thing to check first if that document turns up.
 */
export const GRADES = ["clear", "watch", "hold"] as const;

export type Grade = (typeof GRADES)[number];

/** What a grade is computed from. */
export interface GradeInput {
  /** The intent's amount, in the policy's `thresholdUnit`. */
  amount: number;
  /** The threshold for this counterparty at this instant, already lowered by any active tag. */
  threshold: number;
  /**
   * How many pieces of evidence are REASONS for this intent -- meaning they clear
   * BOTH floors: `relatednessFloor` and `activeFloor`.
   *
   * Both, because design §6:266 says so in as many words: "keep those whose
   * relatedness and decayed strength clear their thresholds". An earlier version
   * of this docstring named relatedness alone, and review measured what that
   * costs: the day-twelve address tag at three thousand six hundred and fifty days
   * has a decayed strength of 2.1e-79 and is still perfectly RELATED, so it would
   * have been a reason forever and every counterparty with any history would read
   * `watch` until the end of time. Under the shipped policy the two sets happen to
   * coincide on the corpus -- two active, two related, two reasons -- so nothing
   * there would have caught the wrong reading.
   */
  reasonCount: number;
}

/**
 * The grade for one intent.
 *
 * WHAT PRODUCES `watch`, which nothing anywhere said. §7 rules the vocabulary and
 * records that `hold` is the only value any document names; review called the
 * middle value the largest unruled number left in the plan. The rule:
 *
 * - **`hold`** -- the amount is at or above the threshold. Evidence has already
 *   done its work by then, because an active tag LOWERED that threshold (R4); once
 *   the amount clears it, no count of reasons can un-hold it.
 * - **`watch`** -- it is not, and at least one piece of evidence is a REASON,
 *   meaning it cleared BOTH floors (R39). "There is evidence about this
 *   counterparty and your amount is below the bar." An earlier version of this
 *   line said "cleared the relatedness floor", which `GradeInput.reasonCount`'s
 *   own docstring in this file already contradicted.
 * - **`clear`** -- it is not, and nothing did.
 *
 * IT NEEDS NO NUMBER, and that is why it was chosen over the alternative. A
 * fraction of the threshold -- `watch` above `threshold × watchFraction` -- would
 * have added an eleventh uncalibrated field with no measurement behind it, which §6
 * would then declare and R5 would have to defend. This rule reuses two things
 * already ruled: the threshold by R3, R4 and R27, and the reasons by R39, which is
 * both floors through `isReason`. It also says something a caller can act on, where a
 * fraction would only have said "your amount is largish", which the caller knew.
 *
 * MONOTONE IN BOTH INPUTS, held by tests rather than by this sentence: raising the
 * amount can move `clear` to `watch` to `hold` and never back, and adding a reason
 * can move `clear` to `watch` and never back. A grade that could soften as the
 * amount rose would be one a caller could game by asking for more.
 *
 * WHAT IT COSTS, stated rather than discovered: **`watch` says nothing about how
 * much evidence there is.** One weak reason and nine strong ones read the same
 * while the amount is under the bar. A graded watch needs a number and a
 * population to measure it against, and neither exists yet; that is the shadow
 * evaluation's, and M4's at the earliest.
 *
 * AND `clear` IS NOT A REASSURANCE -- but the sentence needs a qualifier the
 * first version of it did not have. R29 rules that a first-ever brief grades
 * `clear` on no evidence at all, and that is true only BELOW the base threshold:
 * measured, a pristine counterparty asking for the base amount or more grades
 * `hold` with zero reasons, because the threshold is what a threshold is. So
 * `clear` means "nothing crossed AND the amount is under the bar", never "nothing
 * happened".
 *
 * A second qualifier, also measured: for a counterparty whose producer emits any
 * standing STATE, `clear` is unreachable on any day at any amount below the bar. A
 * state is a categorical tag refreshed every morning, so it never decays out of
 * `activeFloor`, and it is related to everything in its own namespace. R29's
 * sentence holds for a counterparty with no state at all, which the corpus's
 * provider is not. Both qualifiers belong in the README beside R13's.
 *
 * Every input is refused unless it is a number the comparison can trust: a NaN
 * amount fails `>=` and would come back as the SOFTEST grade, produced by the
 * worst input. `holdsAt` in `@nonametrust/schema` refuses an invalid instant for
 * the same reason.
 */
export function gradeFor(input: GradeInput): Grade {
  const { amount, threshold, reasonCount } = input;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`grade amount must be a non-negative finite number, got ${amount}`);
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new RangeError(`grade threshold must be a positive finite number, got ${threshold}`);
  }
  if (!Number.isSafeInteger(reasonCount) || reasonCount < 0) {
    throw new RangeError(`grade reasonCount must be a non-negative integer, got ${reasonCount}`);
  }
  if (amount >= threshold) return "hold";
  return reasonCount > 0 ? "watch" : "clear";
}
