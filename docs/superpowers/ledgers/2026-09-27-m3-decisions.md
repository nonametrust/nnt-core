# M3 decision ledger: the synchronous path and the brief

**Card:** "M3 · Senkron yol ve brief" on `github.com/orgs/nonametrust/projects/1`.
Branch `m3-sync-path`, from `11db2ac`.
**Plan:** `docs/superpowers/plans/2026-09-27-m3-sync-path.md` — fourteen
findings, thirty-two rulings, nine tasks, twenty gates.
**Code:** `packages/engine`, plus root gates under `gates/`.

This file is written WHILE M3 runs, not after it. The storage card's ledger
records that its own §2d went stale twice and that a close-out review rather
than the executor is what noticed; the plan's Notes for the executor say to
expect the same here and write it down when it happens. So each task appends
what it found that the plan did not know, with the measurement beside it.

**Read the plan first**, in its own order: §1 findings, §2 rulings R1-R32, §2b
what the review of the plan changed, §3b the mutation step, then the tasks. This
ledger does not restate them. It records what execution found that the plan got
wrong, left out, or could not have known.

---

## Task 1 — `packages/engine`, three gates, `BriefPolicy`

Committed at `2013081` and `ba66afa`. Counts after it: schema 105, tagging 329,
indexer 122, store 508, **engine 79, root gates 34**. Green under
`Pacific/Kiritimati` and `Etc/GMT+12`.

### What shipped

`packages/engine` with `@nonametrust/schema`, `store` and `tagging` as
dependencies — the first module allowed to declare the last two together.
`BriefPolicy` and `assertBriefPolicy` in `policy.ts`; `ids.ts` as the single
identifier seam; `index.ts` as the public surface. Three gates:
`gates/engine-is-the-only-composer.test.ts` (G1),
`packages/engine/src/policy.test.ts` (G2) and
`packages/engine/src/clock-gate.test.ts` (G3).

### R27 and §6 both say "seven fields" and name two different sevens

R27 lists `briefThreshold`, `thresholdUnit`, `activeTagFactor`, `activeFloor`,
`relatednessFloor`, `crossChannelAffinity`, `mediumCeiling` — and omits
`maxRetries`, which **R28 declares in this same value**. §6 lists a different
seven: it includes `maxRetries` and drops `thresholdUnit`. And neither carries a
`version`, which **R26** needs as the fourth component of
`retention/tagging/calibration/brief` and which **R2** makes the
champion-challenger key a quadruple over.

**Ruling: nine fields.** The union of what the rulings require, plus `version`.
The field set is pinned lexically by a test, so a tenth cannot arrive quietly.

**Cost if wrong:** none identified — every field has a ruling naming it. The
risk is the opposite one, that a later task adds a field without a ruling, which
the lexical pin is there to catch.

### Two rulings the plan states in prose now refuse a value

**R26's separator was ungated and violable.** R26 fixes the composite format as
`retention/tagging/calibration/brief` "with no separator any of them may
contain", and nothing held it. A `BriefPolicy.version` of `brief/v0` was legal
and would have made the composite unparseable. `assertBriefPolicy` now refuses
it. This gates one quarter of R26; the other three version strings are not this
package's to check, and whether any of them already contains a `/` is an open
item below.

**R12's cross-channel term is bounded at both ends, and a cross-field rule the
plan does not state was added.** Zero is refused because the acceptance
scenario's own case is same-namespace-different-channel and a zero makes the
day-twelve address change not a reason, which §9 and Task 9 both require it to
be. One is refused because at one a different channel is worth exactly as much
as the same channel and the term is deleted rather than declared.

> **THIS RULE WAS RETIRED AT TASK 4 (R36).** With only three relatedness values it
> left `relatednessFloor` one admissible position, so the field decided nothing.
> `crossAspectAffinity` (R35) gives relatedness a fourth value and the rule is gone;
> what it protected is asserted on `BRIEF_POLICY_V0` instead. Read R36 before
> acting on the paragraph below.

The rule the plan does not state: **`crossChannelAffinity` must be at least
`relatednessFloor`**. Each of the two can be in range while the PAIR is
inverted, and below the floor the term R12 exists to make non-zero can never
produce a reason — R12's own failure wearing a valid-looking policy.

**Cost, stated because it is real:** this policy cannot express "only
same-channel evidence counts" through a zero affinity. The comparison is `>=` and
not `>`, because a reason clears the floor at equality.

> **CORRECTED BY THE REVIEW ROUND BELOW, and the correction is left in place
> rather than swapped out.** This paragraph originally continued: "That
> configuration is reachable instead by a `relatednessFloor` of 1, which admits
> the same-`(channel, aspect)` term alone." That is FALSE. A floor of 1 is refused
> under every admissible affinity, because the cross-field rule requires the
> affinity to clear the floor and the affinity is itself capped below 1 —
> measured at 0.55, 0.999 and 1. Same-channel-only relatedness is not expressible
> under this policy at all. The sentence had an argument and no measurement, which
> is the failure this project keeps naming; it is shown struck rather than deleted
> because this ledger opens by warning that the storage card's own §2d went stale
> twice and a review, not the executor, is what noticed.

### The engine's clock gate refuses identifiers, and is held against drifting from its original

Both shipped clock gates scan their own package only, so on the day
`packages/engine` was created it was the one package under no clock gate — which
the first version of the plan said in its risks section and then gave no task
the job of fixing, the failure §3b forbids in the document that contains §3b.

Two things the engine's gate does that neither shipped gate does:

**It refuses IDENTIFIERS.** `randomUUID`, `Math.random`, and the random-bytes
spellings one layer down. R1 makes the brief's ids inputs so that a replay
reproduces them; a `randomUUID()` reached for inside the core breaks determinism
in the worst available way, leaving the output well-formed, passing every
assertion about its shape, and differing between two runs. `ids.ts` is the
single exempt module, the way `clock.ts` is the store's. The engine has no
exempt CLOCK module at all, because §3 says its instant is the store's own
injected `Clock` object, so `clock.now()` is an ordinary allowed call here.

**It is held against drift from the scanner it copies.** Every pattern in the
store's `CLOCK_FORMS` except the first two was added after review planted a
spelling that walked past it. A copy frozen at today's list would report green on
a narrower one the day the store's grows, and nothing would say so — and a gate
that has quietly stopped holding what its original holds is worse than no gate,
because its green is trusted. The last test reads the store gate's own form
names out of its source and refuses any this list lacks. Names and not
implementations: two packages may phrase a pattern differently, and what must not
happen is a FORM going unrepresented.

### Three defects measurement found that reasoning did not

**A bug in the composer gate's own predicate, caught by its own planted lines.**
The first `reaches` took no importing package, so `./observation.js` inside
`store/src/repositories` resolved under `packages/store` and every sibling
import in the store read as the store importing the store. The tree-level checks
stayed green by luck — the offence they look for is the other side — which is the
shape of a gate reporting on something it is not measuring.

**Two mutants survived, and both were colliding fixture values making a rule
invisible.** That failure is now on its fifth occurrence in this repository.

1. Replacing the composer gate's name boundary with a bare `startsWith` left
   every test green. The prefix row asked its question of a STORE file importing
   `@nonametrust/storeroom`, where the self-reference check answers `null`
   before the name is ever compared. The row now asks from a neutral package,
   and asks it of both sides.
2. Replacing `ids.ts`'s `randomUUID()` with the string `"fixed"` left the
   "exemption is doing work" test green, because the `import { randomUUID }`
   line still named it. This is the store's own recorded failure — a doc comment
   standing in for a clock read — one layer over.

**And the fix for the second had the second defect in it.** The first fix
blanked import LINES; a multi-line import puts `randomUUID` on a line that is
not an import by that test, so the exemption stayed alive. Measured: with
`ids.ts` reformatted and its call replaced by a constant, all fifty tests
passed. It blanks import STATEMENTS now, and the fix is checked three ways — the
single-line mutant dies, the multi-line mutant dies, and an honest tree with a
multi-line import and the call intact stays green, the last because a blanker
that blanks too much passes both mutants for the wrong reason.

**The lesson, in one sentence:** a fix verified only against the mutant it was
written for is the shape of the defect it was fixing.

### Mutation

Forty mutants for Task 1, then three more for the fixes. 38 of the original 40
died at a test whose name states the mutated rule; the two that did not are
above. Two harness false alarms worth recording so the next reader does not
chase them: `it.each` renders an empty-string field as `version =`, so a killer
regex expecting a trailing space mislabelled two correct kills as
wrong-killer — re-run individually, each turns two rows red.

### The numbers, declared as R5 requires

> **THESE ARE TASK 1'S VALUES AND TWO OF THEM MOVED AT TASK 4.** `briefThreshold`
> is 600 and `mediumCeiling` is 100 as of `25e038f`, and `crossAspectAffinity`
> 0.75 was added; see R35-R37 below for the ruling and `policy.ts` for the current
> list. Left in place rather than edited because this section records what Task 1
> shipped — but a review found this passage contradicting the code, which is the
> failure this ledger opens by warning about, so the pointer is here rather than
> further down.

`briefThreshold: 3000`, `thresholdUnit: "USDC"`, `activeTagFactor: 0.8`,
`activeFloor: 0.25`, `relatednessFloor: 0.3`, `crossChannelAffinity: 0.55`,
`mediumCeiling: 750`, `maxRetries: 5`.

**None is measured.** They were chosen so §9's scenario behaves: a 2500 USDC
request passes the base threshold and is held once the day-twelve tag has
lowered it, since 3000 × 0.8 = 2400 < 2500. That is the whole derivation, and it
is the same admission design §8:338-339 makes about its own defaults. `activeFloor`
is 0.25 rather than anything nearer 0.415, because §6 measured the two scenario
tags sitting 0.0014 apart around there and a floor in that band flips which one
is active between two scenarios differing in nothing else; a test refuses a value
inside the band. Every number differs from every other, held by a test, because
three fields of the tagging policy are all 3 and that made a wrong-field read
invisible there.

### A count this repository carried in prose and had never run

The task handoff and `nnt-engine-state` both said root gates were **20 over 6
files**. They were **13 over 5**: `gates/` holds six files and one,
`interface-fields.ts`, is a helper and not a suite. The other four counts in the
same sentence were exact. Measured before Task 1 began; the only commits between
the storage card's merge and that measurement were docs and plans, so 20 was
wrong when it was written. Corrected in memory. They are 34 now.

### Open, and owed to a later task

- **The other three version strings in R26's composite are unchecked for `/`.**
  `assertBriefPolicy` holds its own quarter. If retention's, tagging's or
  calibration's version already contains a `/`, R26's format is broken today and
  Task 1 only gated a quarter of it. Owed: read the three actual strings.
- **Nothing holds §3's "the engine's clock is the SAME `Clock` object the store
  holds".** The clock gate refuses wall-clock reads; it does not refuse two
  injected clocks. §8 lists this as a risk and says the good case is the store
  refusing it at construction. Whether an engine can pass every gate and still
  use two clocks is not yet measured.
- **`IdSource` is `{ next(): string }`.** Whether that shape survives Tasks 5
  and 8 — which need a brief id, a trigger id and an audit id, possibly
  correlated — is not yet known.
- Whether exporting `randomIdSource` from `index.ts` is consistent with ids
  entering only at the edge.

### Task 1's review round: three lenses, and what it changed

Committed at `ab5fcfe`. Counts after it: schema 105, tagging 329, indexer 122,
store **510**, engine **143**, root gates **47**.

Three agents, one lens each — are the gates real, are the rulings implemented,
what is missing — in separate worktrees with separate databases. They converged
independently on two findings, which is the strongest signal a review gives: R26
is gated for one component of four, and `ba66afa`'s exemption fix was still
narrower than its hole.

**Nine holes in the gates, each replanted and now refused.** They are written out
in `ab5fcfe`'s message with the measurement for each. The two worth carrying
here because they are about this repository's habits rather than about M3:

- **A string containing `/*` blanked real code in BOTH clock gates**, the store's
  included. The block-comment regex ran before quote tracking, so
  `const glob = "dist/*"` opened a comment that any later `*/` closed. This was a
  live hole in a shipped gate, not an M3 defect, and it is the third round of
  holes found in that scanner.
- **The drift test was fooled by six of seven ways to grow the store's list.** It
  parsed another file's source with a regex. It pins that block's SHA-256 now.
  The general lesson: a check that reads another file's SOURCE to confirm two
  copies agree should compare bytes, not parse.

**Twelve fixes survived mutation, and that is the finding of the round.** A
tree-scan rule over a clean tree returns the same empty offender list whether it
checks anything or not. Nine holes had been closed and not one closure was held.
Every rule is now a named judge over one file or manifest, with a synthetic
violation and a synthetic innocent; survivors went 12 → 0. Recorded in memory as
[[tree-scan-rules-need-synthetic-inputs]] because it is not specific to M3.

**Two defects in the fixes themselves.** The import blanker was per-line, so a
multi-line import kept the hollow exemption alive (`ba66afa`); the property is
tested behaviourally now as well. And the real-path fix was wrong in the case it
existed for — it asked "inside store? inside tagging?" with a lexical fallback
OR-ed into each question, so a symlink lexically inside the store answered the
first question and the self-reference check returned null. It resolves one answer
now, real path first.

**A whole-file quote scan cannot read a regex literal.** `/["']([^"']+)["']/`
leaves an odd number of quotes open and inverts the parse from that line on. The
scan is per line with the state reset at each newline; a multi-line template
holding `import(` is refused rather than missed, which is the direction a gate
should fail in.

**Rulings the review corrected.**

- The escape hatch documented for the `crossChannelAffinity >= relatednessFloor`
  rule **does not exist**. A `relatednessFloor` of 1 is refused under every
  admissible affinity — measured at 0.55, 0.999 and 1 — so same-channel-only
  relatedness is not expressible under this policy at all. The claim is deleted
  from the three places it appeared and the bound is declared `(0, 1)`, which was
  always its effective range. A sentence with an argument and no measurement,
  which is the failure this project keeps naming.
- **`mediumCeiling` now must sit strictly below `briefThreshold`.** A ceiling of
  5000 against a threshold of 3000 let a medium-risk intent of 4000 PROCEED while
  a store was unreachable and be HELD when it was reachable — design §6:281's
  prohibition, wearing a valid-looking policy. Necessary and not sufficient:
  3000 × 0.8^7 = 629.15 is under the shipped ceiling, and nothing in M3 bounds
  the number of active tags.
- **`thresholdUnit` refuses padding.** `" USDC "` was legal and would have made
  Task 6's comparison refuse a correct intent.
- **Every refusal row demands its own bound's phrasing.** Deleting
  `relatednessFloor`'s interval left its `1.01` row green on the cross-field
  rule's message.
- **A bound is two claims**, and the refusal table held one. Flipping
  `activeFloor` from closed-at-1 to open survived, because nothing asserted that
  1 is ACCEPTED — and 1 is the OFF setting, the control configuration for a
  champion-challenger run. There is an "accepts the admissible ends" test now.
- **The defaults' derivation was arithmetically wrong.** "3000 × 0.8 = 2400" is
  one tag. Replaying M2's corpus through the real `tagObservation` and
  `strengthAt` at the day-twenty-one instant gives a `trustline_open` state at
  0.5197, the address tag at 0.4165 and the price tag at 0.4151; R22 excludes the
  last, leaving TWO active tags and a threshold of 1920. §9's hold survives; the
  sentence did not.

### Owed to later tasks, from the review

- **TASK 9 CANNOT USE THE COMPARISON ITS ACCEPTANCE NAMES.** The
  `protocol/event/trustline_open` state is refreshed every morning, so it is
  active from day ONE and the provider's threshold is lowered before the
  day-twelve address change exists. "The provider's threshold lower than the same
  query returns for a counterparty with no active tag" is therefore satisfiable
  with the day-twelve tag doing no work at all — R22's failure one tag over. The
  comparison must be the provider before and after day twelve, or with the
  address tag filtered out.
- **Nothing holds §3's "the same `Clock` object the store holds", and §8's claim
  about it is false.** Review constructed an engine module giving
  `TagRepository` and `BaselineRepository` two different clock objects: typecheck
  clean, every test green. The store checks clock identity in exactly one place,
  `observation.ts:129` (observation against namespace repository); `TagRepository`,
  `BaselineRepository`, `TriggerEventRepository`, `AuditChain` and
  `VolatilityRepository` each take an unchecked clock. §8 says "the engine must
  pass the same object down or it will be refused at construction — which is the
  good case": untrue for five of six. The cheap fix is store-side and therefore
  **Task 2's**; the alternative is one engine composition root whose test asserts
  every repository's clock is `===` one object, which is Task 5's. It is a gate
  the plan gives to no task.
- **R26's join must refuse the separator in all four components, at join time.**
  Measured: `retention-v0`, `policy-v0`, `calibration-v0` and `brief-policy-v0`
  contain no `/` today, so the composite is not broken — but the other three
  assert non-blank only, so `retention/v1` is legal in the store tomorrow. The
  engine is the only place that joins them, so the join is where the refusal
  belongs. **Task 5's**, with a plant per component.
- **`BriefPolicy` will gain a tenth field at Task 7.** R7 names "a timeout the
  engine sets itself" and Task 7's acceptance uses one; by R2's own logic a number
  that decides when "unavailable" fires belongs in this value. The lexical field
  pin will move then, deliberately.
- **R1's replay holds for the brief only, not for ingest.**
  `ObservationRepository.append` mints its own `randomUUID()` and
  `AuditChain.append` stamps `occurredAt` from its clock, and Task 2 does not add
  an id parameter to `append`. So design §9's "identical audit chain" cannot hold
  over the ingest path as written. Plan-level; name it or narrow the claim.
- **`tagging/src/policy.ts:11-12` still describes the scenario as "a
  five-hundred-unit request … held".** R15 made it 2500 USDC. A stale docstring in
  another package, left alone rather than edited mid-task.
- ~~**`README.md` is stale in four places**~~ — **done at `68619e5`**; it has an
  engine row, six gates, and says the engine arrived with M3. The original entry: line 25
  says the engine arrives in a later milestone, the packages table has no engine
  row, the `gates/` row names three gates of six, and "only schema resolves
  through dist" is no longer true. One docs commit before the public tag.

### A process failure worth more than most of the findings

The three reviewer worktrees were created with
`git worktree add -f <path> m3-sync-path` — separate directories, separate
databases, and **the same branch ref**. Two consequences, both measured:

1. Commits made in the main checkout moved the reviewers' HEAD mid-review. Two
   of the three noticed and reported a staged file they had never touched.
2. One reviewer ran `git reset --hard HEAD` to return to a clean state, which
   moved the shared branch BACKWARD and discarded the ledger commit made minutes
   earlier. The reflog records it as `reset: moving to ba66afa`. This file
   survived only because it was still in the main checkout's working tree and was
   re-added by the next commit; its own commit and message are gone.

Isolation has three axes, not two: the tree, the database, **and the ref**.
Reviewer worktrees must be `--detach`ed or on their own throwaway branch. Carried
into memory as [[mutation-agents-need-isolation]].

## Task 1's second review round, and the two rulings it forced before Task 2

Committed at `168038a`. Counts: schema 105, tagging 329, indexer 122, store
**512**, engine **151**, root gates **64**.

Three agents again, one lens each, **detached** worktrees this time. The findings
are written out in `168038a`'s message; what belongs here is the pattern and the
decisions.

**The pattern: every fix in round one was narrower than its hole, and two of them
made things worse.** Round one's rewrite of the store's clock gate — a gate
already hardened by three review rounds — let four clock reads through that the
old one refused, the most realistic being a URL-scheme regex whose trailing
`\/\/` read as a comment. Round one's anchoring of the specifier pattern closed a
false positive by dropping nine real import shapes, including
`const a = 1; import { POLICY_V0 } from "@nonametrust/tagging";` in the store —
the M3 headline gate defeated by putting a statement first on the line. Both are
fixed and both are now rows.

**The lesson, which is not the same as round one's.** Round one learned that a
rule needs a synthetic violation. Round two learned that **a fix needs a
regression test against the behaviour it replaced**: both regressions were
invisible because the suite only ever asked "is the tree clean", never "does this
still catch what the old version caught". Where a fix replaces a working
mechanism, the old mechanism's kills are the specification.

### R33. M3's brief reads TAGS only. Permanent records are M4's.

**Closes F6, which no ruling in the plan closed.** Design §6:265's flow includes
"recent permanent records"; F6 records that no listing by namespace exists, and
review confirmed no ruling R1-R32 closes it and Task 5 names no source for it.

**Ruled: the brief's reasons come from tags, and from nothing else, in M3.** A
permanent record is promoted evidence whose reason shape, whose relatedness and
whose interaction with `SOURCE_UNREADABLE` no ruling here defines. Adding an
unruled fourth reason source at Task 5 is precisely how a scenario gets closed on
the last day with an invented constant, which R5 exists to forbid.

**Cost, stated because it is outward-facing:** design §6:265's flow is not fully
implemented in M3, so the brief can miss evidence that was deliberately promoted
to outlive its month. That sentence belongs in the README beside R13's and R29's,
not discovered by a reader of the design. M4 inherits the listing, the indexes the
M1 ledger already asked for (`ledgers/2026-09-06-m1-decisions.md:246`), and the
reason shape.

### R34. `TriggerEventRepository` keeps its clock, as a BOUND on the instant it is handed.

R1 gives `record` the trigger id and the instant, which makes its injected clock
dead — a constructor dependency nothing reads. Review named the choice and left
it open: drop the clock, or use it.

**Ruled: keep it, and refuse an instant after `clock.now()`**, the way
`TagRepository` already refuses a `taggedAt` after its clock (M2's R12). Dropping
it would make this repository the one that cannot be checked for clock identity,
which is the very property Task 5 is about to gate; and a caller handing a future
instant is the mistake the bound exists to catch on every other table.

**Cost:** one more refusal path, and a test for it, in Task 2.

### The clock-identity fix goes ENGINE-side, and Task 2 opens the door

§3 requires the engine's `at` to come from the same `Clock` the store holds, and
§8 claims the store refuses otherwise. **Measured false, and worse than the
ledger's earlier note said: 7 of 8 repository classes take an unchecked clock.**
Only `ObservationRepository` checks identity, against its namespace repository
(`observation.ts:129`); `PermanentRecordRepository` builds its own inner
repositories from its own clock, so it is unchecked too. Review built an engine
module giving five repositories a foreign clock: typecheck clean, 143 engine tests
green, 47 root gates green. Live against the built store, one logical event landed
with `ingested_at` from one clock, `baseline.updated_at` from a clock twenty days
behind, `trigger.created_at` from a third and `audit.occurred_at` from a fourth,
with no error anywhere — and a tag stamped four days in the future returned full
`g0`, because `strengthAt` returns `g0` for every non-positive elapsed.

A store-side fix was constructed and run: identity checks on four more
constructors, 510/510 still green. It was rejected on the measurement.
`AuditChain` is cross-namespace and has nothing to anchor to, so it stays
unchecked under that design; `tag.test.ts:771` legitimately runs a second clock in
one process and had to grow a second namespace repository to keep doing it; and
the check only ever proves "the same clock as the object you handed me", which
moves the problem rather than closing it.

**Ruled: the composition root is the engine's, and so is the gate.** Task 5 gets
one module that builds every repository from one clock, a test asserting each
one's clock is `===` that object, and a lexical rule in the engine's own idiom —
no `new *Repository(` or `new AuditChain(` outside that module, the same shape as
`ids.ts`'s exemption. **Task 2's part is five words:** `private readonly clock`
becomes `readonly clock` on the five classes that hide it, so the test can see
it. Zero behaviour change, no call-site change; `namespace.ts:127` already does
exactly this.

One property no identity check reaches, recorded so Task 5 does not assume it:
the brief's `at` is an INPUT under R1, so `at === clock.now()` is a separate
claim the wrapper must establish.

### Task 2's text, corrected before it is implemented

- **R13's clear read must NOT return `idempotency_key`.** The storage card's §2c
  measured a 300-candidate dictionary recovering 3 of 3 source references from
  it. The columns to return are the ones §2c already lists as plaintext
  survivors: `namespace_id`, `dated_at`, `channel`, `kind`, `evidence_kind`,
  `ingested_at`, `producer`, `period` — plus the two state flags the private
  `skeleton` already carries, so Task 5 need not decrypt-and-catch to decide
  `SOURCE_UNREADABLE`. The plan's R13 text does not say this and §2c is where it
  comes from.
- **R9's expected count is a PARAMETER, never a field on `BaselineState`.**
  `gates/baseline-shape.test.ts` holds that shape equal field for field between
  tagging and the store, so a field added for the optimistic predicate would
  break a shipped gate. `BaselineStale` does not exist in `errors.ts` yet. 15
  `upsert` call sites change signature.
- **`upsert` must keep composing on a `Transaction`.** `observation.test.ts:2301`
  pins the refusing set as exactly `["append", "AuditChain.append", "promote"]`,
  and R10 needs the fold and the tag write in one transaction — so `upsert` must
  not join that set.
- **R20 exports selectively, not `export *`.** `db.ts` also exports `Schema`,
  `withIsoDates` and `refuseWriteInsideTransaction`; the header sentence promises
  the connection, not the SQL.

### Owed to a named task, not to Task 2

- **R12 has an unruled FOURTH case:** same namespace, same channel, DIFFERENT
  aspect — `price/quoted/USDC` against `price/quoted/XLM`, both of which the
  corpus produces. R12 names three terms and the data model has four, and design
  §1 puts aspect matching inside `rel()`. **Rule before Task 4.** If that case
  gets a value below `crossChannelAffinity`, `relatednessFloor` stops being inert.
- **Task 5 must exclude tags whose `taggedAt` is after the brief's `at`.** (R42
  narrowed R1 afterwards; the exclusion STANDS — see R43 below, it is about a past
  brief being correct and not about determinism.)
  `strengthAt` returns `g0` for every non-positive elapsed, and `listLive` has a
  lower bound on the instant and no upper one, so a replay at a past `at` reports
  every tag refreshed since at FULL strength. That is a determinism hole in G10
  independent of any policy number.
- **`BriefPolicy` will need four more numbers** — **two of these four are since
  resolved: R38's `watch` rule needs no number, and `maxReasons` was dropped with a
  latency measurement. Two remain, both Task 7's.** The original entry: `timeoutMs` (R7's engine-set timeout), a
  lock/statement timeout (R7 puts `Cancelled`/55P03 in the unavailable set, and
  that only fires under a `lock_timeout` the engine sets), **the rule that
  produces `watch`** — §7 rules the grade vocabulary provisionally and nothing
  anywhere says what produces the middle value, which is the largest unruled
  number in the plan — and `maxReasons` if §7's latency measurement needs a cap.
- **Task 7 must rule the ceiling at equality.** Its acceptance says "passes under,
  refuses above" and leaves `amount === mediumCeiling` unsaid.
- **The engine can still write SQL through the public surface**, and the boundary
  gate cannot hold it lexically: `migrate(db)` leaks the `Db` type, so
  `db.deleteFrom("tag").execute()` typechecks with every gate green. Named as a
  stated limit and routed to R20/Task 2, where the engine is actually handed a
  `Db`.

### A reviewer finding this ledger refuses

Round one reported `tagging/src/policy.ts:11-12` as stale for describing the
scenario as "a five-hundred-unit request … held", on the grounds that R15 made it
2500 USDC. **Checked: design §9:358 says "a five hundred unit authorization".**
The docstring is accurate about the design; the 500-against-2500 disagreement is
finding F8, which the plan already records. No change.

**But checking it found something in this milestone's own numbers.**
`BRIEF_POLICY_V0` does not satisfy design §9's assertion. A 500-unit request
against a lowered threshold of 2400 (one active tag) or 1920 (two) is not held, so
§9's own scenario test would fail on these defaults. They are fitted to R15's
2500-USDC story, which the plan chose deliberately to close F8. Both are
satisfiable at once — a base in `(500, 625]` with a factor of 0.8 makes an
unlowered 500 pass and a lowered one hold, while 2500 stays held either way — and
the numbers are NOT being re-fitted now, because re-fitting to a scenario the plan
set aside is the quiet re-fitting R5 forbids. **§9's story is the whitepaper's
story, so this is outward-facing and it is Kerem's call**, not Task 9's to
discover.

> **HE DELEGATED IT, and the delegation belongs here rather than only in a commit
> message.** Asked to decide, Kerem's answer was to hand all three open decisions
> back: handle them yourself. R37 below is the ruling that followed, and the
> numbers moved at `25e038f`. Recorded because a review read this paragraph
> against the code and could not tell whether the call had been made or taken —
> "either Kerem ruled it and it was not recorded, or the branch took an
> outward-facing decision by itself" — and a ledger that cannot answer that
> question about an outward-facing number is not doing its job.

---

## Task 2 — the store changes, and one the plan gave to no task

Committed at `f047e44`. Counts: schema 105, store **529**, tagging 329, indexer
122, engine 151, root gates 64.

R20, R9, R1, R34 and R13 all shipped as the corrected Task 2 text above
prescribes. What execution added to that:

**R13's read is held twice, because once was not enough.** The returned key set is
pinned exactly AND the query is asserted not to select `idempotency_key` at all.
Adding the column to the select alone — without returning it — left every test
green, which is a latent disclosure waiting for the next reader to spread the row.
A property stated about a return value does not constrain a query.

**`BaselineStale`'s null case is a false predicate, not an impossible number.**
`expectedCount === null` means "I read no row", and the conflict path needs a
predicate nothing satisfies. `where n = -1` would have worked only because `n >= 0`
is the table's rule, which is not this method's business to depend on.

**R9's concurrency test asserts the MEAN, not only the count.** F14's defect leaves
the count looking right — both writers write `count = 11` — so the count alone
cannot witness a lost fold.

**Two mutants needed a second look rather than a second row**, and the distinction
is worth keeping. Making a clock `private` again is caught by `tsc` (TS2339) and
not by vitest, so that rule is held by the typechecker; and selecting
`idempotency_key` without returning it violated no property the tests STATED, so
the property was widened rather than the mutant excused.

## Task 3 — `holdsAt`, the stored form, and 71 assertions

Committed at `a269316`. Counts: schema **117**, store 529, engine 151, root gates
64. `@nonametrust/schema` moves 0.2.0 → 0.3.0; the WIRE version stays 0.1.0 and
now carries a docstring saying why the two move for different reasons.

**R16 needed no gate exemption, which was the whole argument.** Measured both
ways: the root single-date-reader gate stays green with `holdsAt` in
`schema/src/timing.ts`, and a copy planted in `packages/engine` turns it red.

**Three decisions the plan's acceptance does not name.** The interval is CLOSED AT
BOTH ENDS (a state valid until noon holds at noon); BOTH bounds are checked, not
only `validUntil`, because a state beginning tomorrow does not hold today either;
and an EVENT always holds, as a choice — a three-valued answer like `datedAt`'s
was rejected because every caller would collapse it to a boolean and the collapse
is where the mistake would live. An unparseable instant is refused rather than
reported as "does not hold", since `NaN` fails every comparison and a silent
`false` would claim an expiry nobody measured.

**R32 cost more than the plan said, in the good direction.** 71 non-null
assertions across five store test files became unnecessary once `AppendResult`'s
arms carried `StoredObservation`, every removal confirmed by `tsc`. The plan
described R32 as a typing tidy-up; it was 71 places where the tree had been
asserting a fact the types could have carried.

**And a type helper that could be deleted with nothing failing.** The first
version of `StoredObservation` wrapped its intersection in
`T extends unknown ? ... : never` and claimed that distribution was what kept
`evidenceKind` narrowing. Mutation refused it: removing the conditional produced
ZERO typecheck errors, because TypeScript already normalises `(A | B) & C` to
`(A & C) | (B & C)`. `DistributiveOmit` beside it genuinely needs the helper,
since `keyof` of a union is only its common keys. **A helper that can be deleted
with nothing failing is a helper whose comment is wrong** — and the only reason
this one was found is that the mutation step covers type-level rules through
`tsc`, not only runtime rules through vitest.

## Task 4 — relatedness, and the three decisions it could not start without

Committed at `25e038f`. Counts: schema 117, tagging 329, indexer 122, store 529,
engine **177**, root gates 64.

The three were listed above as owed to Kerem or to a later task. He delegated all
three; they are ruled here with their reasoning and their costs.

### R35. Relatedness has FOUR cases, and `crossAspectAffinity` is the fourth

R12 names three terms. The data model has four: same namespace, same channel,
**different aspect** — `price/quoted/USDC` against `price/quoted/XLM`,
`volume/amount/USDC/in` against `volume/amount/XLM/in`, both of which the corpus
produces. Design §1 puts aspect matching inside `rel()`, so this was never out of
scope, only unruled — and unruled it would have been decided on the day Task 4 met
a second aspect, by whichever branch happened to catch it.

Ordered by SPECIFICITY, which is the ruling: `crossChannelAffinity <
crossAspectAffinity < 1`. Evidence about the same quantity is more related than
evidence about another quantity on the same channel, which is more related than
evidence on another channel. A policy inverting the middle pair is refused by
name.

**Cost:** a tenth field, and the version composite grows with it.

### R36. The `crossChannelAffinity >= relatednessFloor` rule is RETIRED

It was added in Task 1 — by me, not by the plan — to stop the cross-channel term
being "in range and dead". Review measured what it cost: with only three
relatedness values the floor had exactly ONE admissible position, so every
admissible policy partitioned those values identically and two policies differing
only in the floor returned byte-identical briefs. `relatednessFloor` occupied a
slot in the version composite and decided nothing.

With four values the floor has three meaningful positions — every same-namespace
term counts; cross-channel excluded; only the same aspect counts — and two of them
are what that rule forbade. Those are configuration CHOICES a challenger policy
should be able to make, not incoherent states.

What the rule was really protecting is that the SHIPPED default admits
cross-channel evidence, because design §9 needs a day-twelve `address_integrity`
change to bear on a day-twenty-one `price` intent. That is now asserted on
`BRIEF_POLICY_V0` itself rather than imposed on every policy.

**Cost, and it is real:** a challenger policy can now be written that silently
fails design §9. Nothing holds that but the default's own assertion. Recorded as a
limit rather than closed, because closing it would re-impose the rule that made the
field inert.

**`relatednessFloor`'s bound has now moved twice** and the chain is in one place in
`policy.ts`: closed, then opened when review proved 1 unreachable under the retired
rule, now closed again because "only the same aspect counts" is reachable and
meaningful. Each move was right when it was made.

### R37. The defaults satisfy BOTH scenarios' hold

F8 records that design §9 and R15 disagree on the amount. §9:358 asserts a **five
hundred** unit authorization is held on day twenty-one because the day-twelve tag
lowered the threshold; R15 rules M3's acceptance scenario is M1's story at **2500
USDC**. The first defaults were fitted to R15 alone — threshold 3000, lowered to
2400 or 1920 — and measurement showed §9's own assertion FAILING on the numbers
this repository ships.

Both are satisfiable at once, so both are satisfied. **At `briefThreshold` 600 and
`activeTagFactor` 0.8, the day-twenty-one threshold is 600 × 0.8² = 384 and BOTH
500 and 2500 are held there.** That is what each document literally asserts, and
it is all that is claimed.

> **THIS PARAGRAPH SAID SOMETHING ELSE AND THE CORPUS REFUTED IT.** It read: "600
> with 0.8 leaves 500 above the base bar and below it once one tag is active, which
> is what §9 means by the tag doing the work". Three things wrong. 500 is BELOW
> 600, so the words were inverted. §9 asks for a `hold` and for the address change
> to be among the reasons; it says the tag LOWERS the threshold, and lowering is not
> flipping — the flip was an interpolation. And the flip is unreachable anyway:
> §9 and R15 share ONE corpus, whose daily-refreshed trustline state is active from
> day one, so there are never zero active tags, and with the address tag filtered
> out 500 is still held at 480. The windows where the address tag WOULD be the
> flipping tag are disjoint — base in (625, 781.25] for 500, (3125, 3906.25] for
> 2500 — so no single base gives both a flip.
>
> `policy.ts` and `policy.test.ts` were corrected at `cef11b7`; this paragraph was
> not, and a review reading the ledger against the code found it. **Task 9's
> acceptance is derived from here**, so it matters more than most: Task 9 compares
> the provider's THRESHOLD before and after day twelve, never grade against grade.

What the test pins is therefore the window in which both holds are true and the base
still sits above 500 unlowered: `500 < briefThreshold <= 500 / f`. `mediumCeiling`
moves to 100 to stay under the lower threshold, and the seven-tag gap its docstring
recorded is nine tags now, computed rather than recalled.

**These numbers are still FITTED, and still declared so.** What changed is that
they are fitted to both documents instead of one, which removes any need to edit
either — and §9's story is the whitepaper's story, so not editing it was the point.

### R38. What produces `watch`

§7 rules the vocabulary provisionally and records that `hold` is the only value any
document names; review called the middle value the largest unruled number left in
the plan.

**`hold`** when the amount is at or above the threshold. **`watch`** when it is
not and at least one piece of evidence cleared `relatednessFloor`. **`clear`** when
it is not and nothing did.

**It needs no number**, which is why it beat the alternative. A fraction of the
threshold would have added an eleventh uncalibrated field with no measurement
behind it, which §6 would then declare and R5 would have to defend. This rule
reuses the threshold (R3, R4, R27) and the reasons (R12), and tells a caller
something it did not know — a fraction would only have said "your amount is
largish".

Monotone in both inputs, held by property tests: raising the amount or adding a
reason can never soften a grade. And it makes R29 exact — a first-ever brief
grades `clear` on no evidence, so `clear` means "nothing crossed" and never
"nothing happened", which is the sentence the README owes.

**Cost:** `watch` says nothing about HOW MUCH evidence. One weak reason and nine
strong ones read the same while the amount is under the bar. A graded watch needs a
number and a population to measure it against; that is the shadow evaluation's, and
M4's at the earliest.

**Implemented rather than recorded**, in `grade.ts`, because a ruling held by prose
is what §3b forbids — and because Task 5 should compose this rule, not invent it.

### Still open, and now the most important unruled thing

**Does an UNRELATED active tag lower the threshold?** Design §6:275 says "an active
tag lowers that counterparty's brief threshold" and says nothing about relatedness.
R12 gives relatedness; R38's grade rule counts reasons. If an unrelated active tag
lowers the threshold, a brief can `hold` with ZERO reasons — a graded answer with no
account of itself, against design §6:270-273. If it does not, the threshold depends
on the intent and `thresholdFor(namespaceId, at)` in Task 6 cannot have that
signature. **Owed before Task 6, and asked of the round-three review.**

## Round three, lens three: the ground Task 5 stands on

Three lenses at `25e038f`. Lenses one and two are recorded above with their fixes
(`cef11b7`, `d5660db`). This lens asked what Task 5 will trip over, and it found
enough that Task 5 does not start until these are ruled.

### R39. The set of tags that LOWERS the threshold is the set of REASONS: active AND related

**Two lenses converged on this independently, which is the strongest signal a
review gives**, and I measured both directions before ruling.

Design §6:275 says "an active tag lowers that counterparty's brief threshold" and
says nothing about relatedness. R3 makes "active" a strength comparison; R12 makes
"reason" a relatedness comparison; **nothing tied them**, and design §6:263 is a
conjunction the code did not implement: "keep those whose relatedness AND decayed
strength clear their thresholds".

Measured, with the real functions and a policy `assertBriefPolicy` ACCEPTS
(`relatednessFloor: 0.9`):

- the day-twelve address tag scores 0.55, so it is **not a reason**
- it is active at its measured strength 0.4165, so it **lowers 600 to 480**
- `gradeFor(500, 480, reasons: 0)` = **`hold`**; against the unlowered 600 the same
  intent is `clear`

**The tag decided the grade and the brief cannot cite it.** `grade.ts` calls that
the thing design §6 exists to avoid, in its own docstring. And the other direction,
under the SHIPPED policy: a same-aspect tag decayed to 0.01 is not active and is
still a reason, so `watch` on evidence that has decayed below the active floor.

**Ruled: a tag counts — for lowering AND for citing — iff
`strengthAt(tag, at) >= activeFloor` AND
`relatedness(tag, intent) >= relatednessFloor`.** R13's kept reasons are those that
satisfy both and whose source will not open. Then a hold caused by a tag always has
that tag among its reasons, and the only zero-reason hold is a hold on the amount
alone. The brief's output carries `threshold: { base, applied, loweredBy }` so every
grade has an account of itself.

**What it costs, and it is not small: `thresholdFor(namespaceId, at)` cannot be Task
6's signature.** It becomes intent-scoped, because there is no intent-free threshold
once relatedness gates the lowering. Design §6's "the engine exposes the current
threshold as a query" either goes or becomes a second, intent-free query that no
brief uses — and Task 6's acceptance ("the threshold query and the brief read one
value at one instant") and Task 9's comparison must both use the intent-scoped one.

The alternatives, for the record. Lowering by every active tag and citing by
relatedness is the status quo and produces the measured unaccounted hold. Lowering
AND citing by activity alone makes `relatednessFloor` dead again, undoing Task 4's
whole argument.

### R40. The intent's reading is CARRIED from `observe`, not re-derived by decrypting

Relatedness needs the intent's `(channel, aspect)`. `readClear` returns the channel
and **not the aspect** — aspect comes from `readObservation`, which needs the
decrypted payload. So the core either opens the payload itself or is handed the
reading.

Measured cost of opening it: one AEAD open per brief, and — decisively — **after a
sweep `get(intent)` raises `PayloadExpired`, so a brief could not be replayed 90 to
120 days later at all.** That undermines R13, whose entire design is to keep a
reason whose source will not open; a brief that cannot read its OWN intent after
expiry makes R13's careful handling of everything else pointless.

**Ruled: `observe` returns the intent's derived reading and `brief` takes it.** The
objection — that relatedness then rests on a caller-supplied aspect, which tagging
refuses by design — does not apply inside one engine call: `observe` derived that
aspect from the payload through tagging's own derivation, and carrying it forward is
the engine remembering its own work, not an integrator asserting a quantity.

**The residual risk, stated:** an integrator calling the core directly with a
fabricated aspect gets wrong relatedness. Mitigated by the wrapper being the
supported entry point (R1), which R20 already records is a convention rather than a
mechanism. A gate for it would have to recognise the core's callers; if one can be
written it should be.

### R41. R22's filter is on the tags the intent TOUCHED, not the ones it opened

R22 excludes "any tag whose `observation_id` is the intent's". Measured hole: a
refresh does **not** change `observation_id` — it keeps the opening observation's —
so a tag opened by observation A and **refreshed by the intent** survives the filter
and reads full strength at the intent's own instant. The intent lowers its own
threshold through the tag it just refreshed, which is exactly what R22 exists to
prevent, one verb over.

**Ruled: `observe` returns the tag ids it opened OR refreshed, and `brief` takes
them as `ownTagIds`.** The filter is on identity, not on provenance.

### R42. R1's determinism is "the same inputs AND the same store state"

Measured: one tag at instant T1 reads strength 0.4243 with `refreshCount` 0; after a
refresh at T1+3d, the same `strengthAt` at **the same T1** returns 0.9000 with
`refreshCount` 1, because `refresh` overwrites `g0`, `tagged_at`, `refresh_count`
and `saturation_state` and the prior state is stored nowhere (F3). Excluding tags
whose `taggedAt` is after `at` — which the ledger owed Task 5 — removes that tag
entirely, so a past replay sees zero tags where one existed and was active.

**No filter recovers it**, because the history is not kept. So R1's replay claim is
narrowed rather than defended: the same inputs against the same store state replay
to the same output. **G10's two runs must not write between them**, and the reason's
`refreshCount` and `saturationState` at any past `at` are post-refresh values.

### Inside Task 5, with what each needs

- **The R26 join is unheld, and three of four components accept `/`.** Measured:
  retention, tagging and calibration all accept `version: ".../v1"`; only
  `assertBriefPolicy` refuses. `AuditChain.append` took the malformed composite
  unparsed. The engine's `compositePolicyVersion(...)` refuses each component, with
  a plant per component.
- **R25's gate must be a WHITELIST, not a blacklist.** `AuditChain.append` accepted
  `{ payload, source, evidence: { ref } }` — a `payload`/`source` key check passes
  `evidence.ref`. The body needs a closed type plus a runtime whitelist of key names
  **at every depth** over the rendered canonical JSON; `canonicalForm` is exported.
- **`at === clock.now()` is plantable and must be gated in the wrapper.** `record`
  bounds only the future (R34), and `AuditChain.append` stamps its own `occurredAt`.
  Measured with `at = now − 3d`: the trigger landed at day 8 and the audit row at day
  11, no error. Rule it too: the replay entry point performs NO effects; only the
  live wrapper reads `at` from the clock and performs them.
- **R14 needs an observer.** "Before any tag is read" cannot be seen from outside;
  the test counts `listLive` calls. And the refusal can only name a uuid —
  `NamespaceRepository` has no read by uuid — so the check sits on the first read,
  `readClear(intentObservationId)`, whose `namespaceErased` flag is what R14 acts on.
  (An earlier version of this entry said `NamespaceRepository` has no read by uuid.
  It has three — `dataKey`, `periodsOf`, `shred` — and `dataKey` raises
  `NamespaceShredded` on an erased one. The conclusion stands for a different
  reason: `dataKey` UNWRAPS and hands key material to the engine on the happy path,
  which is not what a liveness check should do.)
  A brief on an erased namespace is refused whole, not served as
  `SOURCE_UNREADABLE` reasons.
- **The candidate trigger's `surprise` has no source.** It lives only on
  `trigger_event`; the tag row has none; `brief` does not ingest (R22); recomputing
  it judges against a baseline that already holds the intent's fold, which R10
  forbids. So the input carries `surprise: number | null` out of `observe`, and
  `null` is the one branch that is both R18 (categorical) and R29 (cold).
- **A DB-backed engine test needs no gate change.** Measured: `kysely` and the
  store's test harness are both refused in engine test files, and the store's
  public surface alone is enough — `openDb(base).schema.createSchema(...)`,
  `migrate(db, <store migrations path>)` (12 tables), and
  `db.selectFrom(...).select(db.dynamic.ref<string>("xmin"))` for G9's snapshot.
  Two gotchas recorded: `db.dynamic.ref("xmin as xmin")` does not work, kysely
  quotes the whole string; and the boundary gate refuses the bare word `kysely`
  **inside a string as well as in code** — comments are blanked and strings are not
  — so a test title may not name the driver.
- **`maxReasons` is NOT needed, and §7's cap question dissolves.** Measured at 200
  reasons: `listLive` 0.8 ms, `readClear` ×200 24 ms, `get` ×200 46 ms sequential
  and 33 ms parallel. Round trips dominate, not AEAD, and the one-to-two-second
  budget is about forty times away. What remains to decide is whether M3's reason
  carries `source.ref` at all, since that is inside the payload and is the only
  thing needing a `get`.
- **The composition root takes a `Db` OR a `Transaction`.** The lexical
  "no `new *Repository(` outside the root" rule collides with Task 8 rebuilding
  repositories per transaction under R10; `Db` already admits a trx.

### R31 is worse than "updatable", and it is measured

The ledger recorded that `trigger_event` has no append-only guard. Measured on a raw
writer: `UPDATE surprise` succeeded, **`UPDATE status = 'harm_confirmed', tier = 'A'`
succeeded**, and `DELETE` succeeded, while the control `DELETE` on `tag` was refused
by NNT07. So a raw writer can promote the brief's candidate into a harm-confirmed,
tiered trigger — not merely edit it. Scope stays M4 as ruled, and it is recorded as
a known hole in this repository's idiom: a test that asserts the hole, so the day it
closes is noticed.

## R43-R48: the decisions Task 5 would otherwise have made by accident

A fourth review built Task 5's skeleton from this ledger and reported every place it
had to guess. Those are ruled here, because a decision made by whichever branch
catches it first is the failure R5 and §3b both exist to prevent. Each carries what
it costs.

### R43. The `taggedAt > at` exclusion STANDS, and it is about correctness rather than determinism

R42 narrowed R1's replay claim and said the exclusion "removes that tag entirely",
which read as though the exclusion might be the problem. It is not. Measured: a tag
stamped after `at` reads its full `g0` at `at`, because `strengthAt` returns `g0` for
every non-positive elapsed. A brief at a past instant that counted such a tag would
be reporting evidence that did not exist yet, at a strength it never had.

So the exclusion stands. What R42 concedes is separate: a REFRESHED tag's earlier
state is not recoverable, so a past-`at` brief is correct about what existed and
approximate about its strength. Both sentences are true and they are about different
things.

### R44. Task 5 computes the threshold; Task 6 becomes the query and its consistency test

Under R39 the lowering set IS the reason set, so `applied = base × factor^|reasons|`
is one line inside the brief and cannot be deferred. **And the unit refusal cannot
wait either**: without it a Task 5 brief with `unit: "XLM"` grades a raw number
against a USDC threshold. R27 already rules the refusal; Task 5 performs it.

Task 6 keeps the intent-scoped `thresholdFor`, its "one value at one instant"
consistency test, and Task 9's comparison. **Cost:** two task boundaries move, and
Task 6 is smaller than its text implies. Recorded rather than discovered when Task 6
finds its work already done.

### R45. `riskTier` is `"low" | "medium" | "high"`, refused by name at runtime

Nowhere in the tree: the design says "low-stakes / mid-tier / high-stakes", the plan
says "low/mid/high" once and "medium" once. `"medium"` is chosen because
`mediumCeiling` is already named for it, so the policy field and the tier agree.

Refused at RUNTIME and not only by the type, because a JavaScript caller bypasses
the type and this value goes into the audit body — which is hashed and outlives
every key (R25, and the storage card's F7). A tier the vocabulary does not admit
must not become a permanent row.

### R46. An intent with more than ONE reading is refused in M3, by name

R40 says "the intent's derived reading", singular. `readObservation` returns
`Reading[]`, and `cluster_proximity` yields TWO — `hops` and `amount` — so R40 is
unimplementable as written for one of seven channels.

The alternatives were max-over-readings and per-reading briefs. Both invent a rule
nobody has measured: which of two readings is "the" intent for relatedness, and
which surprise goes on the candidate trigger. **Ruled: refuse it, by name.** A
refusal is honest, is one line, and leaves M4 the ruling with a population to
measure it against. **Cost, stated because it is outward-facing:** a
`cluster_proximity` intent cannot be briefed in M3, and that belongs in the README
beside R33's.

### R47. A reason does NOT carry `source.ref` in M3

The source reference lives inside the sealed payload, so carrying it costs one AEAD
open per readable reason and makes the reason unbuildable once the month expires.
Three reasons not to:

- **R25 forbids it in the audit body anyway** — the chain outlives both the month
  key and the namespace key, so a body naming a source would defeat erasure through
  the audit table.
- **F3 measured that a refreshed tag's source misdescribes its own evidence**: a tag
  refreshed forty times names one observation and records the other thirty-nine
  nowhere. A ref that is right about 1 of 40 events is worse than an honest absence.
- The latency measurement shows `get` is the only real cost in a brief, and dropping
  the ref drops it.

So a reason's source is a CODE and its clear columns, never a dereference:
`SOURCE_PRESENT` when the payload would open, `SOURCE_UNREADABLE` when
`periodExpired || namespaceErased`. Design §6 says error states are codes; the
ordinary state needed a code too, and nothing had named it.

**Cost, and it is outward-facing:** design §6:270-273 says each reason carries its
sources, and in M3 it carries a code and the clear columns rather than a reference.
That sentence belongs in the README beside R13's and R33's.

### R48. The audit body is a CLOSED type, and the whitelist WALKS it

R25 admits "ids, codes, versions and instants". A grade cannot be explained by those
alone: `amount`, `unit`, `threshold.base`, `threshold.applied` and each reason's
`strength` and `relatedness` are none of the four, and **a grade nobody can
recompute is not auditable** — which is what an audit row is for.

So the body is a closed `BriefAuditBody` type admitting exactly those named fields,
and the runtime check is a WHITELIST that walks the object at every depth. Not a
blacklist: review measured `AuditChain.append` accepting
`{ payload, source, evidence: { ref } }`, so a `payload`/`source` key check passes
`evidence.ref`. And not a regex over the rendered canonical JSON either, because a
string VALUE containing `":` fools one.

`AuditEntryInput.kind` for a brief is `"brief"`. None of the admitted numbers is a
payload field: `amount` is an input (R8), and the strengths and relatednesses are
computed from tag rows the store already keeps in the clear.

### Recorded as known properties, not ruled away

- **Two briefs on one intent write two candidate triggers.** Measured: no uniqueness
  on `observation_id`, three `record`s on one observation landed. Each brief is its
  own decision citing the same intent, so this is correct — and R1's "a retry
  collides on the primary key" covers only a retry reusing its id.
- **A retry whose first `record` actually landed sees 23505 on the primary key.** The
  wrapper must read that as "landed" and continue to the audit append. And R24 —
  a committed write with no chain entry is a named inconsistency, not a rollback —
  **extends to the brief verbatim**; the plan rules it for ingest only.
- **Two `compose` calls with two clocks are invisible to every gate.** The
  composition root makes one clock the norm, not a guarantee.
- **A reason whose namespace is erased mid-brief is `SOURCE_UNREADABLE`, not a
  refusal.** R14 refuses on the INTENT's flag; a reason's flag is R13's business.
- **The `at === clock.now()` gate can only hold identity under a fixed clock.** With
  `systemClock`, `occurredAt` trails `at` by milliseconds, so the production property
  is `at <= occurredAt`.
- **The compose lexical rule must admit member access.** Review's own first pattern,
  `new \w*Repository(`, walked past `new store.TagRepository(`.
