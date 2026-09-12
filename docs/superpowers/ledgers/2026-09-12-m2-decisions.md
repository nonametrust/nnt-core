# M2 decision ledger

**Milestone:** M2, the tagging arithmetic. Branch `m2-tagging`, 28 commits from
`bc49359`, in the worktree `.worktrees/m2-tagging`, awaiting merge after the
whole-branch review and its fix wave.
**Spec:** `docs/superpowers/specs/2026-09-08-m2-tagging-design.md`
**Plan:** `docs/superpowers/plans/2026-09-08-m2-tagging.md`
**Code:** `packages/tagging`, one new root gate under `gates/`.

The commit messages carry the outcomes. This file carries the reasoning, and
what each ruling costs if it turns out wrong. Several rulings here overrode the
plan's own text, and those are marked as overrides rather than folded in. Where
a reviewer or an implementer corrected the controller, that is recorded as a
correction. Where a ruling was mine and could be overturned, it says so.

M3's board card says its plan is to be written against M2's actual code rather
than its design, with this ledger named as the thing to read for every ruling
and every deferred finding. That is the audience.

---

## How the milestone was set up, and two rulings made before Task 1

**The worktree was created with `git worktree add` rather than the harness's
own tool.** The controller session was coordinating three repositories at
once, and the harness's worktree tool moves the whole session into the
worktree it creates. Cost if wrong: the harness does not know the worktree
exists, so it has to be removed by hand, and at the end of the milestone it was
deliberately not removed (see the last ruling in this file).

**Every subagent ran on `fable`, including the final whole-branch review.** The
subagent-driven-development skill puts that one review on the most capable
available model. It ran on `fable` because that is the project owner's standing
instruction, and a standing instruction overrides the skill's preference. It is
written down, as it was for M1, so that anyone weighing the final review's
verdict knows what produced it. Cost if wrong: the final review is weaker than
the process intends, and the weekly budget rather than the overall one is the
binding limit. For calibration, what that review actually did: it triaged all
twenty-six deferred minors, found two things only the whole branch shows,
neither of them in the deferred list, and confirmed by diff that the plan file
had been ticked and not retrofitted to the code.

**The preflight scan was clean.** Every pair of tasks sharing a file was in
producer-before-consumer order, and the one cross-package claim, that the
store's `BaselineState` interface carries the same twelve fields the plan has
Task 4 declare, was checked against the store's code rather than its design and
held. That check also noticed that the store's `baseline` table has an `aspect`
column while its `tag` table does not, which is where the second carried
finding below comes from.

The baseline before Task 1: schema 105 tests, root gates 4, build green. The
store suite needs Postgres and the worktree had none, which the plan names as a
constraint; what that constraint cost, and how it was paid at the end, has its
own section.

---

## The rulings, in the order they were made

**The clock gate's regex was widened past the one the plan gave** (Task 1,
overrides the plan). The plan's boundary test refused `Date.now(` and
`new Date()`, verbatim. The spec's constraint is that no no-argument `new Date`
appears in the package, and JavaScript admits `new Date` with no parentheses at
all, which reads the same instant. A gate with a hole in it is worse than
either a working gate or no gate, because the confidence it produces is
unearned, so the regex now refuses `Date.now` as a bare word and `new Date`
unless an opening parenthesis is followed by an argument. The implementer went
one step past the ruling and refused a bare `Date.now` reference too, which the
same reasoning covers. Cost if wrong: a badly written lookahead refuses a
legitimate `new Date(x)`; the gate's own planted-line tests hold that it does
not, and the reviewer probed the committed regex directly on both protected
cases. Known limits are listed under carried findings: forms nobody writes by
habit still pass.

**The volume aspect stays keyed on an asset code, and M2 does not change the
schema** (Task 2, mine, and it could be overturned). The aspect for a payment
is `amount/{assetCode}/{direction}`, and an asset code alone does not fix a unit
on Stellar: two assets both named USDC from different issuers pool into one
baseline. The reviewer was right that this is the defect class the aspect
vocabulary exists to prevent, one layer down, and it is worse than academic,
because a lookalike asset is exactly the attack the `address_integrity` channel
exists because of, so an attacker can issue a fake USDC and move a
counterparty's volume baseline. I still did not fix it here. The fix is a field
on the volume payload, which is a schema tightening, and the indexer developer
was told on 8 September that there would be no second tightening before his
16 September delivery. Breaking that unilaterally costs a collaborator his
delivery and costs the promise its meaning. What M2 does instead is name the
limit in the code where the aspect is built, so nobody reads `amount/USDC/in`
as a unit it is not. Cost if wrong: until the schema carries the issuer, a
volume baseline can be moved by an asset that merely shares a code, and no test
in this repository sees it.

**The cluster-proximity aspect stays `amount`, with no asset field at all**
(Task 2, same reasoning, same exposure). Its payload carries no asset, so dust
amounts pool across every asset. The spec's section 3 table assigns it no unit
field and section 16 does not list it as carried, which means it was not
noticed rather than decided. Cost if wrong: of the two, this is the more
exposed, because dust is small in every asset and a pooled scale across assets
means nothing. Both aspects go to the schema card that follows the 16 September
delivery, and not to a later milestone's rediscovery.

**The uncalibrated weight's equality to the weakest measured weight is a
deliberate coupling and it stays** (Task 3). `unmeasuredChannelWeight` in the
policy equals content's measured weight in the calibration. A future
calibration that moves content below it forces a policy version bump as well,
and that is correct rather than a defect, because the policy value's entire
justification is that it is the weakest measured weight. Cost if wrong: the two
versions cannot move independently, so a calibration-only release becomes a
two-file release.

A consequence ruled at the same time and carried to Task 9: a result must let a
reader tell a policy-sourced weight from a calibrated one. Latency and price
carry the same digits as content's measured weight beside `calibration-v0`, and
nothing in the result distinguished them. Task 7's implementer then showed the
identity is not merely undocumented but undetectable at the `g0` layer, because
`calibrateG0` takes a bare weight, and pinned that with a test. The closure is
a `weightSource` field on every decision, set only from a single
`channelWeightWithSource` export in `calibration.ts` whose one membership
ternary picks the number and its source together; `channelWeight` is defined
through it rather than beside it, so there is no second predicate to drift.
Cost if wrong: none that I can see; the alternative was naming the calibration
version beside a number the calibration never produced, which is worse than
naming nothing.

**The location estimator equals the mean by construction, and the baseline
refuses a state whose two locations differ** (Task 4, two rulings, the second
tightening the first; overrides nothing in the plan but settles something the
plan left implicit). The implementer noticed that `medianEst` is bit-identical
to `mean` under this design, because spec section 5 clips the observation
before it updates the baseline, not before it updates the robust estimators
alone, and both then run the same recursion over the same clipped input from
the same start. I kept that. The alternative, feeding `mean` the raw value so
the columns differ, contradicts the spec's explicit ordering, breaks acceptance
criterion 3 for half the state since an extreme observation would then move
`mean` without bound, and leaves a stored number nothing reads and an adversary
can move: authoritative-looking and unconsumed, the worst kind of column.

What follows, and M3 must not misread it: **the robustness of this design lives
entirely in the clip, not in the location estimator differing from the mean.**
`median_est` holds the winsorized running mean and `mad_est` the winsorized
running mean absolute deviation, which are what constant space allows and which
have the bounded-influence property the names were chosen for. They are not the
sample median and MAD, and nobody should later "fix" them into estimators that
need the history the store does not keep.

The tightening came from the review, which showed that criterion 3 holds for
`mean` only through its identity with `medianEst`, because the band is computed
around one and the delta measured from the other. A stored row where they
diverge moves the mean by 106/21 against a bound of 6/21. So `assertBaseline`
now refuses a state whose `mean` and `medianEst` differ, by strict equality,
which is safe because both fields are produced by the same operations on the
same operands and survive a double-precision round trip unchanged; the
re-reviewer checked the null short-circuit and signed zero and the store's
column types before agreeing. The alternative was to keep the row admitted and
pin the identity with a test, which leaves a real unbounded move in place to
buy mutant coverage, the wrong trade. One consequence inverts a complaint into
a proof: once the invariant is enforced, the mutants that read `mean` where the
code reads `medianEst` become provably equivalent, since no admitted state
distinguishes them, and an equivalent mutant is not a coverage gap. Cost if
wrong: if the two locations are ever meant to differ, the refusal blocks the
change until someone states why, which is the outcome I want. The store-side
consequence is the third carried finding below.

**A surprise refusal must not be swallowed** (Task 5, carried to Tasks 7 and 9
and held). The quotient-overflow refusal in `surpriseOf` is reachable in
principle through the shipped policy, because a decimal string admits any
finite double, so a price near 9e306 against the price floor is refused rather
than tagged. Absurd for a price, impossible for an amount, and refusal is the
design's chosen behaviour, but a consumer turning that `RangeError` into a
silent absence of a tag would be the same hole in another form. The Task 7
reviewer confirmed no `try` or `catch` exists in `packages/tagging/src` outside
tests, so the ruling holds by construction. Cost if wrong: an observation that
should stop the pipeline produces no tag and no trace. M3's engine inherits
this: it must let the refusal propagate.

**A reviewer's own execution was accepted as evidence in place of a third
review round** (Task 5, mine, and a process shortcut). The re-reviewer's one
residual was a zero floor never sent through `surpriseOf`. It was taken as one
added assertion; the re-reviewer had already run that line and reported the
exact failure message it produces under the mutant. A third round would have
cost more than the evidence it added. Cost if wrong: one assertion in the scale
suite rests on a reviewer's run rather than an implementer's, and the report
says so.

**The module cycle was broken by direction rather than accepted** (Task 6,
overrides the plan's own claim that no cycle would exist). `baseline.ts`
imports the value `timescaleStep` from `timescales.ts`, and the implementer had
`timescales.ts` import the value `assertBaseline` back, a real runtime cycle;
the type import the plan mentions is erased and was never the problem. The
implementer proved the cycle safe in both entry orders and documented it, and I
refused it anyway. The reason is the failure mode rather than today's
behaviour: a cycle survives until someone adds a top-level constant or reorders
an export, then fails at import time with an undefined value, in a package
whose entire justification is a clean dependency boundary, and no test catches
it because tests import in one order. The fix took the better half of the
ruling: one shared predicate, `assertTimescales`, lives in `timescales.ts` and
is imported by `baseline.ts` in the direction that was already acyclic, and an
agreement test holds the divergence's refusals to the exact messages
`assertBaseline` throws. The reviewer then confirmed the cycle is gone in the
emitted JavaScript, not only in the source. Cost if wrong: one predicate with
two callers, which is no cost at all; the fallback would have been two
validators held equal by a test.

The agreement test earned its place beyond the cycle it was written for: three
of the second sweep's mutants are pinned by it alone, because the baseline
suite had never had a negative-variance case on either exponential pair.

**Three minors went to the final review's triage rather than a fix round**
(Task 7, mine). Two were wording and the third duplicated coverage that exists
at another point in the pipeline; none changed what the shipped code does. Cost
if wrong: three more rows for the final review, which it triaged.

**`refreshTag` refuses a live strength above the ceiling rather than clamping
it** (Task 9, from the review's one Important). A saturated tag at seven came
back at seven, twice, and the store's own constraint has no upper bound either,
so this function is the only place that could refuse. A clamp would quietly
change a value whose provenance is a different policy version and then report
it under the version that did not produce it, the same provenance dishonesty
`weightSource` had just closed one layer up. The cost is written in the
docstring beside the refusal rather than left here: **lowering the ceiling in a
later policy version requires migrating saturated tags, because the engine
refuses them until someone does.** Lowering a ceiling is a rare deliberate act,
and the refusal names what is owed. Cost if wrong: a policy change becomes a
data migration, loudly rather than silently.

**The shape gate's one green-over-disagreement was closed although the
typecheck already refused it** (Task 10, mine). A file declaring `BaselineState`
twice is merged by TypeScript into one interface, and the gate compared the
first block only. The repository's typecheck refuses that edit in both packages
so it is unreachable through CI, and nobody adds a field by declaring an
interface twice, which is why the review classed it minor. It is one line and
it is the difference between a gate with a known hole and a gate without one.
Cost if wrong: one extra failure mode to explain if a file ever legitimately
declares the interface twice, which nothing here does.

**A state merely continuing to hold is not a repeated deviation** (fix wave,
the largest ruling of the milestone, mine, and the one most worth re-examining
in M3). Spec section 10 says a refresh is the maximum of the decayed and the
fresh strength plus a bounded increment that saturates, and section 4 says a
state is refreshed while it holds. Read together and literally, every morning a
trustline stands is a refresh with an increment, and the increment is bounded
only by the ceiling. The whole-branch review's corpus showed what that does: a
standing trustline passed its own calibrated channel weight on the sixth
morning and sat at the ceiling from the fifty-fifth, never decaying while it
held. The channel weight is section 11's whole defence against the two broad
channels, whose innocent base rate is what the study's failed third criterion
was about, and a per-morning increment defeats it. Every standing condition
would then sit in front of every future decision at maximum strength forever,
and a brief that shows everything is a brief nobody reads.

So a state refresh takes the maximum, moves the instant and the count, and does
not add the increment; an event refresh keeps the increment. The split is on
the schema's own `evidenceKind` discriminant rather than a correlate, so the
instant rule and the increment rule cannot diverge. The opposite error is on
record too: M1's refresh was called defective because a standing condition
faded while it still held, which is what the maximum preserves, and the
re-reviewer walked the built package thirty mornings to confirm it still does.
One corpus number moved, and it is the right one: the trustline's strength on
mornings two to twenty-two was a walk from 0.56968 to 0.86219, past the 0.6496
weight on morning six, and is now constant at 0.51968, asserted exactly per
morning with the decayed operand asserted strictly below it. No assertion was
weakened, and the re-reviewer judged the changed assertions tighter than the
ones they replaced. Cost if wrong: a genuinely repeated standing deviation
accumulates more slowly than the design intended, and the corpus's trustline
walk is flat where it used to climb. If M3 finds a standing condition that
should climb, this is the ruling to reopen, and the increment on a state is the
one line to change.

**Stale events keep their increments** (fix wave, ruled when the implementer
correctly refused to change it without asking). A stale event is a real
deviation, and a backfill should reach the state live observation would have
reached, which is the deterministic replay the design wants. The level is
bounded by the ceiling; the count is not, and eight events from an open tag
reach the ceiling within a day of its instant. The exposure is that an
unauthenticated producer can manufacture events, and that is the
signature-enforcement gap already in the project's open gaps rather than a
defect in this arithmetic. Cost if wrong: a hostile producer with no signature
check can drive one pair's strength to the ceiling in eight forged events.

**The worktree is not deleted**, which the process would otherwise do once the
final review is clean. The branch is not merged, and merging is not mine. And
the gitignored process ledger that this file is written from lived only there
until this file existed. Cost if wrong: scratch survives in the worktree until
the merge.

---

## Where the plan was wrong, and an implementer or a reviewer was right

This section is about the plan, not the code, and it is the finding M3's plan
should be written knowing.

**The plan's own test code held a test that proved nothing in seven of the
eleven tasks.** Each was found by an implementer deleting the line the test
claimed to protect and watching the suite stay green, and each was replaced or
joined by a test the mutant fails.

- Task 2: the "not a decimal" case passed with the validator deleted; a
  `direction: "sideways"` case was what actually bit.
- Task 3: the add-one smoothing test used the function under test as its own
  oracle, so add-two smoothing with regenerated constants passed; and the
  `channelWeight` test exercised one measured channel, so a predicate that
  treated only volume as measured passed every test while four measured
  channels silently took the policy's weight under a result naming the
  calibration.
- Task 4: the "not a property of the raw arithmetic" test called nothing under
  test and was a tautology over its own constants; and the whole suite could
  not tell `winsorMadMultiple` from `thresholdBase`, which is where the second
  habit below came from.
- Task 5: two of the plan's refusal tests stayed green with the line they
  protected deleted, each shadowed by a later check that refused the same input
  for a different reason.
- Task 6: the floor refusal was shadowed the same way, and both literal-alpha
  mutants passed the plan's twelve tests; the one policy-override test killed
  them.
- Task 9: three of the plan's thirty tests catch no mutant at all.
- Task 10: the most on the nose. The plan's gate extractor filtered lines
  beginning with a comment marker, so a store field commented out with a bare
  block comment, whose middle line begins with the field name, was still
  reported present. The gate written to catch shape drift reported green over
  shape drift. The reviewer verified it two independent ways, including by
  putting the plan's filter back into the committed gate.

Task 1 belongs beside these though it is a gate rather than a test: the plan's
clock regex had the hole the first ruling closed. Task 7 was the first task
whose plan tests each caught at least one mutant, and Task 11's eighteen passed
verbatim on the shipped code, which is what an acceptance task should do.

**The plan's code twice lost a guard an earlier task had added.** The plan's
Task 4 body never carried an exit check on the state it returns; the Task 4
implementer added `assertBaseline(next)` in its first commit, and the plan did
not know. The plan's Task 5 scale then read `madEst` without passing the state
through Task 4's predicate, so a negative spread, which the predicate refuses,
was hidden by the maximum against the floor; the implementer had `robustScale`
call the predicate instead and closed the hole. The plan's Task 6 replacement
body for `updateBaseline` ended in a bare return and would have removed the
exit check outright; the implementer kept it. The lesson the milestone ran on
from Task 6: the plan's code is a specification of intent and not a safe
transcription source, and an implementer that follows a replacement block
literally loses a guard silently. M3's plan should be executed the same way.

**Two habits caught what mutation alone could not.**

The first: assert a refusal's message, not only its class. Five tasks had
refusals shadowed by a later check that threw the same class for a different
reason, so `toThrow(RangeError)` was green over the deleted line. Asserting the
cause separates "some check ran" from "the check this test is about ran".

The second: override a policy value in at least one test of anything that
reads policy, and override it with a number no other shipped field shares. A
mutation sweep over the implementation does not catch a constant read from the
wrong field of the right object when the shipped values collide. This habit
caught the wrong-field floor reads in Task 5 on its first use, both literal
alphas in Task 6, the ceiling in Task 9, and the multiple in Task 4 that
prompted it. Overriding a field to a value another field also holds proves
nothing, which is why the collision map matters.

**The measured collision map of the shipped policy.** Where a wrong-field read
is invisible to a default-policy test:

- `thresholdBase` = `surpriseScale` = `winsorMadMultiple` = 3
- `noiseCoefficient` = `g0Ceiling` = two channel floors = 1
- three of the four fleet priors = 0.5; the fourth = `fastAlpha` = 0.2
- `refreshIncrement` = both aspect floors = 0.05
- `minObservations` = 10, shared by nothing

Task 8's implementer built the first four rows; Task 9 found the fifth and the
`fastAlpha` collision. Any later task reading policy needs this list, and a
change to a policy value needs the list re-derived.

**The plan's sweep yields, for calibration.** Against the plan's own tests,
surviving mutants ran from six of eighteen in Task 5 to thirteen of thirty-three
in Task 6, twenty-one of thirty-five in Task 8 and thirty-two of seventy-two in
Task 9. Against the final suites, none survives except the equivalent mutants
the Task 4 identity ruling creates and three in Task 7 that the report listed
after the fact, none a defect in shipped code.

---

## Corrections to the controller's own record

Recorded because a ledger that corrects only other people is not a record.

**Task 4.** I told the implementer that the interval test also kills a
particular unaveraged-spread mutant. It re-ran and disagreed, with the number:
the last-deviation form passes the interval test with a spread of 1.11 inside
the bounds and dies on the hand-arithmetic test and criterion 3 instead. The
re-reviewer settled it in the implementer's favour: the two accounts describe
two different readings of an unaveraged spread, and both are true of different
mutants. The implementer recorded the run rather than my correction, which was
the right call.

**Task 8.** The implementer's prose said 19 of 34 mutants survived the plan's
tests and its own table said 21 of 35. I propagated the prose into the process
ledger and into a report to the founder. The table was the honest record and
both were corrected.

**Task 9.** I wrote that a guard the plan specified had been removed. The plan
specifies no such guard; the implementer added one and then removed it on the
reviewer's showing that the read it guarded is dominated by the policy
assertion on every path. The removal is right.

**Task 11.** The implementer's report gave a measured-verdict count of 49; the
corpus holds 37. It recounted before changing it and left a note that an
earlier draft said 49.

---

## What is enforced where, stated plainly

The package enforces: the aspect is derived from the observation and no caller
supplies it, held by the per-reading function being private after Fix A; every
reading on a continuous channel is finite, held on every numeric field for
Infinity and NaN both; clip before update, and no single observation moves a
location past its bound; the two locations equal; the fast and slow pairs
judged by one predicate; no wall-clock read and no second dependency, by the
boundary test; every result naming its policy and calibration versions and
every decision naming its weight's source; a refresh being the maximum rather
than a sum; and the six acceptance criteria together on one corpus.

The repository enforces: the tagging and store baseline shapes agree field for
field, lexically, by the third root gate; no date field is read outside the
schema's two permitted readers, with the scan extended to the new package; no
shape-valid account identifier in any tracked file.

Stated and **not** enforced, deliberately and said so in the code: that an
asset code fixes a unit for volume, and that any unit at all applies to
cluster-proximity amounts; that the two baseline declarations agree in type as
well as in text, since the gate is lexical and every field today is a
primitive; that the clock gate holds against intent rather than habit.

---

## The one thing eleven task reviews could not check, and how it was closed

The store suite never ran during the milestone. The worktree had no Postgres,
the plan names that as a constraint, and every task review resolved "cannot
verify from diff" on the root suite the same way: CI settles it on push. So the
claim that M2 does not disturb M1's tables was written in the spec, repeated in
eleven reports, and unchecked.

At the end I brought up the repository's own dev cluster, which belongs to the
repository rather than the machine and listens on loopback only, and ran the
whole root suite. At `fd19e5a`, the end of Task 11: build and typecheck green,
schema 105, tagging 306, store 243, root gates 7, 661 tests, nothing skipped,
including the store's lock and audit-chain suites. At `f6d0c0b`, the end of the
fix wave: schema 105, tagging 322, store 243, root gates 7, **677 tests, exit
0, nothing skipped.** The branch is green end to end, and the claim is now
checked rather than stated. M3 writes to the database and cannot carry the
same constraint; its worktree needs the cluster from Task 1.

---

## Carried into M3 and the schema card, not fixed here

The first five are the ones M3's plan cannot be written without. The rest are
the residual minors the final review triaged as able to stand, grouped so they
can be found.

- **The store's refresh method cannot store what this package returns.**
  `TagRepository.refresh(tagId, g0)` takes `greatest` over the stored `g0`
  rather than the decayed strength, does not move `tagged_at`, and does not
  touch `saturation_state`. `refreshTag` returns `g0`, `taggedAt`,
  `refreshCount` and `saturationState`, all of which must be stored as
  returned, because together with a moved instant, `greatest` over the stored
  value revives a tag to full at every repeat. M3's engine writes a new
  refresh; the M1 method is not to be reused.
- **The `tag` table has no `aspect` column.** The live tag is keyed on
  `(namespace, channel, aspect)` and `TagDecision` carries the aspect; the
  store's `StoredTag` carries the channel only. Without the column a deviation
  on one asset and direction refreshes a tag created by another, which is the
  pooling the aspect exists to prevent, at the tag layer. This is a migration,
  and it breaks the promise `0006` made that M2 and M3 add code and not
  migrations; the promise predates the aspect. The shape gate covers the
  baseline and says nothing about the tag.
- **The store's `baseline` table admits two row shapes this arithmetic now
  refuses.** Migration `0006` has no check tying `median_est`'s nullness to
  `n`, and the store's own volatility-window test upserts a row with a positive
  count and a null pair; nor does it check that `median_est` equals `mean`.
  Store does not import tagging, so nothing fails today, but M3's read path
  will throw on either row. The table needs both checks, and the store test
  that writes the first shape needs changing when they land.
- **A refresh count on a state counts mornings, not repeats.** After the state
  ruling, `refreshCount` still increments on every state refresh while the
  ruling says a morning is not a repeat. That is consistent with section 10 as
  written, and M3 must not read `refresh_count` as a count of repeated
  deviations for a state. If that column is to mean repeats, the state path
  stops incrementing it, and that is a one-line decision M3 should make on
  purpose.
- **Two aspects wait on a schema tightening that cannot happen before the
  indexer's delivery.** The volume payload needs an issuer beside the asset
  code, and the cluster-proximity payload needs an asset at all. Both are on
  the schema card that follows 16 September, beside `salienceHints.latencyMs`,
  which admits Infinity for the same reason the reading guard exists and is
  outside this milestone only because nothing in tagging reads a hint.

Consequences of the design that M3 should choose around rather than
rediscover:

- **The fleet prior is four numbers, not seven, and the categorical base is
  one.** A prior for a channel with no baseline is a number nothing reads, so
  the prior is declared for the four continuous channels and the three
  categorical channels take `categoricalBase` times their weight. The spec has
  no rule for a categorical `g0`; this is the one chosen, in the policy file,
  uncalibrated.
- **The instant of an event's tag is the event's, and the caller's `at` may be
  later.** The decayed strength is computed at `at`; the refreshed instant is
  the event's or the tag's, whichever is later. Minutes apart on a synchronous
  path; days apart on a backfill, where the maximum compares a strength
  decayed to `at` against a `g0` stamped earlier. Held conservative. M3
  chooses its `at` knowing this.
- **The saturated remnant is narrower than before the state ruling but still
  reachable.** A protocol event and a protocol state derive the same aspect,
  so ten event refreshes saturate the pair and a state then holds it at the
  ceiling with a fresh instant indefinitely. Bounded, and it is section 10's
  own sentence. Before the fix a state alone reached the ceiling in fifty-five
  mornings; now it takes events to get there.
- **A saturated live tag below a later policy's ceiling is handed back at its
  own strength rather than raised.** Bounded, and the mirror of the refusal
  above the ceiling.
- **The divergence between the two timescales carries how often a stream
  leaves the band, not by how far**, because the pairs see the clipped value.
  Nothing decides on it in M2, and `tag.test.ts` holds that; what M3 does with
  it is M3's.
- **A `channel` argument and a baseline's own channel are checked against each
  other at the composition seam only.** The threshold function trusts its
  caller; `tagObservation` refuses a baseline belonging to another channel
  before the verdict is reached. Any new caller of the threshold function
  inherits the seam's job.

Residual minors that can stand, by class:

- Gate limits, all stated in the gates' own comments: the clock gate can be
  defeated by forms nobody writes by habit (`new Date(undefined)`, `Date()`
  without `new`, `new globalThis.Date()`, a construction split across lines)
  and it refuses `typeof Date.now` in a type position, so an injected clock is
  typed `() => number`; the specifier regex errs conservatively on prose
  containing "import" near a quoted phrase and misses a string-named import
  binding; the boundary test does not see a package pulled in through
  `createRequire` under a name carrying no database token; the shape gate is
  lexical.
- Arithmetic edges: a zero-spread surprise of negative zero returns negative
  zero; a refresh count at the safe-integer maximum increments past it; a new
  tag can open above a ceiling below one, since the spec bounds only a
  refreshed strength; the `madEst` docstring's per-observation bound
  over-claims in a case Task 5's floor makes impossible.
- Test wording: an identity test in the `g0` suite pins a present-day equality
  the provenance suite already pins as an inequality, and should say so; a
  cross-channel ordering test holds volume as the maximum where the property
  is that an unmeasured channel never outscores a measured one; one comment in
  the tag test still says the per-reading step repeats three entry checks that
  Fix A moved to the single caller, which is false and one line.
- The trustline tag in the acceptance corpus never saturates within its
  twenty-two days under the shipped increment; nothing in the scenario depends
  on it.

Four of the twenty-six deferred minors were closed by later work rather than
carried: the unprotected public surface, closed by Task 11's entry-point test
over thirty runtime names and twenty-five types; the observation-minimum guard
written in three places, consolidated by Task 11; the version guards refusing
an empty string but not a whitespace-only one, and the dead `medianEst`
finiteness check, both closed in Fix C.
