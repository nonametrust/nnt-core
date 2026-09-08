# M2 — Tagging: design

**Milestone:** M2, card date 11-15 September 2026; started 8 September, because
M1 merged and nothing else holds it.
**Parent spec:** `docs/superpowers/specs/2026-09-05-mvp-v0-core-engine-design.md`,
sections 4 and 5.
**Carried from:** `docs/superpowers/ledgers/2026-09-06-m1-decisions.md`, the four
notes on the M1 board card, and the questions `0003_tag.sql` and
`0006_baseline_trigger_volatility_window.sql` leave open by name.

M0 produced the vocabulary. M1 produced the place observations live and the four
tables whose arithmetic it deliberately did not write. M2 writes that arithmetic:
what a baseline is, what counts as a surprise against it, and what a tag is worth
when it is created.

---

## 1. What M2 is, and what it is not

**In scope.**

- `packages/tagging`, a new workspace package depending only on
  `@nonametrust/schema`.
- The aspect vocabulary, which does not exist anywhere today.
- The baseline update: Welford state, winsorization, robust scale, two timescales.
- Surprise, and the calibrated map from surprise to `g0`.
- The noise-adaptive tag threshold.
- Cold start, and what a channel may tag before it has history.
- Refresh under saturation.
- Channel weights, derived from the study rather than invented.
- Two files, policy and calibration, with different provenance rules.

**Out of scope, and where each goes.**

- Writing anything to the database. M2 returns values; `engine` in M3 stores them.
- `trigger_event`, including the `surprise` column. The synchronous path builds
  the candidate trigger, so that row is M3's. M2's result *carries* the signed
  surprise so M3 has something to store.
- Decay itself. `strengthAt` shipped in M1 and M2 does not reimplement it. M2
  owns the half-life it takes as an argument.
- `volatility`, `hot_window`, promotion, and the nightly pass. M3 and M4.
- Learning any weight or half-life from traffic. v0 does not learn. D1.4 does.

---

## 2. The boundary, and the seam that keeps it honest

The parent spec's dependency table gives `tagging` one dependency, `schema`, and
that is right for a reason bigger than tidiness: the whole milestone becomes
testable without a database. M1's store suite needs Postgres and fails rather
than skips without one, which is correct for a store. It would be wrong here.
Tagging is arithmetic, and arithmetic whose determinism has to be provable over a
fixed corpus should not need a cluster to prove it.

So the shape is a pure function. In: an observation, the current baseline state
for its `(namespace, channel, aspect)`, the live tag for that pair if one exists
**together with its strength at this instant**, and the policy and calibration in
force. Out: the next baseline state, and either no tag or a tag decision carrying
`g0`, the channel, the signed surprise, and whether this is a new tag or a refresh
of the one passed in.

The decayed strength is an input rather than something `tagging` computes, and
that is the boundary paying for itself rather than leaking. `strengthAt` shipped in
M1 and lives in `store`; a `tagging` that called it would depend on `store`, and a
`tagging` that reimplemented it would be the second definition of the same
function. The caller has the tag and the instant already, so it passes one number.

**The crack this opens, and the gate that closes it.** The baseline state's type
lives in `packages/store` today, and its own comment says it is the shape "M2's
arithmetic will produce". If `tagging` cannot import `store`, the shape is
declared twice and the two drift.

The type does not move to `schema`. `schema` is the indexer's contract and the
engine's internal state has no business in it; that is the same rule section 6 of
the observation contract now states about Horizon field names.

The ruling: **`tagging` owns the shape, `store` keeps its own storage shape, and a
repository-root gate asserts the two agree field for field.** A field added to one
and not the other fails the gate on the day it is added. This is the third gate in
`gates/`, and it exists for the same reason as the other two: the property is true
today and nothing would notice when it stopped being.

---

## 3. The aspect vocabulary

`baseline` is keyed on `(namespace_id, channel, aspect)` and no aspect vocabulary
exists in this repository. Defining it is M2's first real decision, and it is the
one most likely to be wrong quietly.

**What an aspect is for.** A baseline is a scale. Two quantities that share a
channel but not a scale must not share a baseline, because a z-score computed
across pooled scales measures nothing. The channel payloads make this concrete:

| Channel | Continuous quantity | What the aspect must separate |
|---|---|---|
| `volume` | `amount` | `assetCode` **and** `direction`. 200 XLM in and 200 USDC out are three different scales, not one. |
| `price` | `quoted` | `unit`. A quote in USDC and a quote in XLM are not comparable. |
| `latency` | `latencyMs` | nothing; one scale per counterparty. |
| `cluster_proximity` | `hops`, and `amount` when present | the two are different quantities in one payload and need one aspect each. |
| `address_integrity` | none | categorical. |
| `protocol` | none | categorical, keyed by `event`. |
| `content` | none | categorical, keyed by `field`. |

**The rule, stated once:** an aspect names the quantity being measured, when the
payload carries more than one, together with the payload fields that fix that
quantity's unit. It never carries the quantity's value. It is derived from the
observation, never supplied by a caller, so an indexer cannot split or merge a
counterparty's history by choosing a string.

**What is held.** The derivation is total over the seven channels and its output
is a bounded, enumerable set per channel. The aspect string is derived by one
function, and a test asserts that every channel's fixture yields an aspect and
that two observations differing only in the quantity yield the same one.

---

## 4. Event and state

`packages/schema/src/channel.ts` records what is not yet enforced: "that an event
decays from its instant, and that a state is refreshed while it holds. Both belong
to a later milestone." That milestone is this one.

This is not a detail. The single-date-reader gate exists because the study
credited a standing condition to every window including the seven-day one, while
controls could not measure it at all, and that inflated the headline by three
points in one direction. Repeating the defect inside the engine is the specific
failure this milestone is positioned to prevent.

**The rule.** An `event` observation creates a tag stamped at the event's instant,
and it decays from there. A `state` observation creates a tag the first time it is
seen, and after that it does not create a second one while the first still holds:
it refreshes the existing one, and the refresh is what carries the state forward. A state therefore never contributes two tags to one
window, which is exactly the arithmetic the study got wrong.

`datedAt` is the only reader of a date off an observation and returns null for a
state. M2 does not add a second reader; it branches on `evidenceKind` and uses the
tag's own `taggedAt` for the state path.

---

## 5. The baseline update

Welford for mean and `m2`, in the standard streaming form, so a baseline is
updated in constant space and never recomputed from history the store does not
keep.

**Winsorization comes first.** The parent spec's bounded-influence protection says
an observation is clipped at a multiple of MAD before it updates the baseline. The
order matters and is stated here so it cannot be reordered later: clip, then
update. An update that used the raw value and clipped afterwards would already
have moved the mean.

**Two timescales.** `fast_*` and `slow_*` are exponentially weighted mean and
variance under two different weights, not Welford's equal weighting. Welford's
recursion has no window: every observation counts the same forever, which is what
`mean` and `m2` are for and exactly why a second pair of columns exists. The fast estimator is read against the slow one, and
their divergence is what an adversary inflating variance cannot hide. M2 computes
the divergence and exposes it; what a consumer does with it is M3's.

**The open question M1 left.** `0006` says whether `m2` is zero when `n` is zero,
and whether `median_est` and `mad_est` arrive together, are M2's to settle. They
are: `m2` is zero at `n = 0` because a sum of no squared deviations is zero, and
the two robust estimates arrive together and are null together, because a MAD is a
deviation from a median and one without the other has no meaning.

---

## 6. The robust scale, and the zero-spread bound

Surprise is a robust z-score, `(x − median) / scale`. When MAD is zero the
expression is undefined, and `0006` names this as the arithmetic's case to bound
before it reaches the row.

**Three candidates, and why the third wins.**

Refusing to tag when MAD is zero is wrong: a counterparty with a perfectly regular
history could then never be tagged, which is a hole an adversary can sit in
deliberately.

Falling back to the Welford standard deviation is wrong: it reintroduces the
non-robust estimator at precisely the point where the robust one was chosen.

**The scale is `max(madEst, floor)`**, with the floor a parameter per
`(channel, aspect)`. Surprise is then always finite, and no infinity is ever
constructed to be caught later.

**Where the floor's value comes from, honestly.** Not from the quantity's
granularity. A floor at the granularity would make a counterparty who always sends
exactly the same amount produce a maximal surprise on the first trivial deviation,
which is a false-positive machine. The floor is one of the mechanism parameters the
backtest does not speak to, so it is treated as the parent spec treats all of them:
it lives in the policy file, its v0 default is the value that makes the section 9
scenario behave as the whitepaper describes, and the fact that it is not calibrated
is written next to it.

---

## 7. Surprise to `g0`

`g0` is a calibrated function of the surprise carrying an uncertainty, so the same
deviation scores more cautiously for a counterparty with little history.

Two properties are load-bearing and are held by the function's shape rather than by
a clamp afterwards. It is **bounded**, so the `tag` table's finiteness check is a
backstop and never the thing that first notices a problem. And it is **monotone in
|surprise| and decreasing in uncertainty**, so more evidence never scores lower and
less history never scores higher.

The gate reads `|surprise|`. The signed value is carried out of the function
untouched, because direction is information M3 and M4 may want and discarding it
here cannot be undone. The study's own catalogue argues both directions matter: an
unexpectedly large payment is a signal, and so is the small test payment that
precedes a loss.

---

## 8. The noise-adaptive threshold

Where a namespace's observed noise is high, `θ_tag` rises automatically. The input
is the baseline state already in hand, so this is a function of state and policy
and needs nothing else.

The property worth stating is what it protects against: an adversary who cannot
lower their own surprise can try to raise everyone's noise. A fixed threshold makes
that pay. An adaptive one does not.

---

## 9. Cold start, and the fleet prior v0 does not have

Below a minimum observation count, a continuous channel produces no tag. The
categorical channels are independent of any baseline and tag from day one; that is
what makes `address_integrity`, `protocol` and `content` useful on the first
observation about a counterparty nobody has seen.

The parent spec also says namespace statistics shrink toward a fleet-wide prior
beneath that count. **v0 has no fleet.** There is no live traffic to aggregate, and
aggregating would require a store read that the section 2 boundary forbids.

The ruling: shrinkage stays, and the prior is a constant per channel in the policy
file. Seven numbers, declared uncalibrated, with the same note the half-lives
carry. A real fleet prior is D1.4's work alongside per-channel decay learning.
Seven declared constants is a bounded admission; a prior per
`(kind, channel, aspect)` would be several hundred invented numbers, which is the
kind of unenforced claim this project has repeatedly found to be false.

---

## 10. Refresh under saturation

A repeated deviation on an already-tagged pair refreshes rather than stacks. The
new strength is the maximum of the decayed current strength and the newly
calibrated `g0`, plus a bounded increment that saturates.

**The sentence that must not be left out:** a refresh moves `taggedAt` forward. If
it did not, the new `g0` would be immediately discounted by the whole elapsed time
and the tag would collapse rather than refresh. Because the clock resets, the thing
that stops an attacker pumping one tag is not the clock. It is the maximum, which
makes identical repeats idempotent, and the increment, which saturates. A later
writer who replaces the maximum with a sum opens the pump; that is why it is
written here and asserted in a test rather than left to be inferred.

`refresh_count` increments on every refresh. `saturation_state` moves from `open`
to `saturated` when the increment can no longer raise the strength, and a saturated
tag refreshes its instant and its count but not its `g0`.

---

## 11. Channel weights, and why OR-ing is closed

Channel weights live in M2 and v0 does not learn them. The starting weight derives
from the study's per-signal table **by precision, not by raw difference.**

The reason is criterion 3's failure and the audit's diagnosis of it. The control
base rate reached 47.5%, and nearly all of it came from the two broad channels,
while the narrow ones fired in a small minority of victims. A rule that ORs
channels together therefore inherits the broad channels' base rate and measures
mostly noise. Weighting by raw difference would reproduce the same error one step
later.

So: weights are derived from the study, the derivation is written down next to
them, and OR-ing across channels is not implemented in v0.

---

## 12. Two files, policy and calibration

They are separate, and the separation is about provenance, not tidiness.

**Calibration** holds what the study measured: channel weights, the pooled
half-life. Each entry names the result it comes from. Changing one is a claim about
the measurement and needs evidence.

**Policy** holds what the study does not speak to: the scale floor, the minimum
observation count, the fleet prior, the threshold's noise coefficient, the
saturation increment. Each entry says its v0 default was chosen to make the
section 9 scenario behave as described, and that it is uncalibrated.

Both are versioned. Every result M2 returns names the two versions that produced
it, so the audit entry M3 writes can carry them and the champion-challenger
arrangement the protocol brief describes has something to key on.

---

## 13. Errors

Two refusal shapes exist after M1 and M2 uses the first. Arithmetic that cannot
produce a meaningful number raises a `RangeError` inside `tagging`, before anything
reaches the store. The database check constraints stay what `0003` calls them: the
rule the next writer cannot go around, not the thing that first notices.

`strengthAt` already sets this precedent, refusing a non-positive half-life and a
NaN elapsed rather than returning a number a threshold comparison would silently
read as "not above". M2 refuses on the same principle and for the same reason.

---

## 14. Acceptance criteria

From the board card, and they pass together on one corpus rather than only in
isolation. That is M1's lesson: a component that no longer composes with its
neighbours does not satisfy a criterion it satisfies alone.

1. No tag is produced below the minimum observation count.
2. A repeated deviation refreshes rather than stacks.
3. One extreme observation cannot move a baseline past its bound.

Three more are held because this design added them and an unenforced property in
this repository has repeatedly turned out false:

4. A state observation never yields two tags inside one window.
5. No surprise is ever infinite or NaN, at any MAD including zero.
6. The tagging and store baseline shapes agree field for field.

---

## 15. What could still move

**The aspect vocabulary is the fragile part.** It is derived from payload fields,
and a payload change in a later milestone changes the derivation. The gate is that
the derivation is total and its output enumerable per channel, so a new field
without a decision fails rather than silently pools.

**The scale floor and the fleet prior are the two numbers with the weakest
provenance.** Both are declared uncalibrated. If the shadow evaluation moves either
one materially, the section 9 scenario should be re-read rather than the number
quietly retuned.

**Whether the divergence between the two timescales should itself gate a tag** is
left open. M2 computes and exposes it. Making it a gate is a claim about adversarial
behaviour that nothing has measured yet.
