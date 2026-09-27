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

The rule the plan does not state: **`crossChannelAffinity` must be at least
`relatednessFloor`**. Each of the two can be in range while the PAIR is
inverted, and below the floor the term R12 exists to make non-zero can never
produce a reason — R12's own failure wearing a valid-looking policy.

**Cost, stated because it is real:** this policy cannot express "only
same-channel evidence counts" through a zero affinity. That configuration is
reachable instead by a `relatednessFloor` of 1, which admits the
same-`(channel, aspect)` term alone. The comparison is `>=` and not `>`, because
a reason clears the floor at equality.

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
