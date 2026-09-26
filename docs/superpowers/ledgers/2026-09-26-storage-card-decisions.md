# Storage card decision ledger (migration `0007`)

**Card:** "Depo kartı (migration 0007)". Branch `storage-card-0007`, 50 commits
from `6a95e25`, eleven tasks, fourteen review rounds and three close-out
audits, awaiting merge.
**Plan:** `docs/superpowers/plans/2026-09-21-storage-card.md`
**Code:** `packages/store` and `packages/store/migrations/0007_retention_aspect_and_baseline_shape.sql`
(eight named sections), plus one root gate under `gates/`.

This file is short on purpose. M0, M1 and M2 each have a ledger that carries
the reasoning the commits do not; this card put that reasoning in the plan
instead, as §2b (rulings made during execution), §2c (the limits of
crypto-shredding) and §2d (what the later tasks must read instead of their own
text), written while the card ran rather than after it. Those sections are the
ledger. This file exists because a reader of this repository looks in
`ledgers/` and, until today, found M2 and then nothing — and because a close-out
review, not the executor, is what noticed.

**Read, in this order:** the plan's §2b for R9-R21, §2c for what
crypto-shredding does not do, §2d for every task text that is now misleading,
and the commit messages for the outcomes.

---

## What the card was, in one paragraph

Retention as unreadability on a clock. A payload is sealed under a key per
`(namespace, calendar month)`; that month key is wrapped under the namespace's
own key; a fixed grace after the month closes the month key is shredded, and
the payload stops opening while the row skeleton, every foreign key and every
audit row stay where they are. A promotion re-seals the rescued payload under
the namespace key, which is how a captured trace outlives its month. Around
that: the tag table keyed on its aspect, the two baseline checks M2's
arithmetic assumes, the producer cap, and a gate for each.

## The rulings, and where they are

R1-R8 were made in the plan before any code. R9-R21 were made while the card
ran and are written out in §2b with their costs; four of them (R18-R21) exist
because a review refused a sentence this plan had already written. Rather than
restate twenty-one rulings here, this ledger records only what a ledger is for:
what they cost if they are wrong, which are overridable, and what the card
learned that no ruling captures.

**Overridable without a migration:** R3 (the cap's scope), R2 (`expires_at`
fixed at mint), the grace of ninety days, and the cap of ten million. All four
are policy numbers in `retention.ts` with their sources in the doc comments;
three of the four are declared and uncalibrated and say so.

**Not overridable after merge:** the envelope's nine parts (R13, R15), the
month-key layout, and the seven sections' constraint names. `0007` refuses to
run over a non-empty `observation` table for exactly this reason, so the
irreversibility is enforced rather than promised.

---

## What the card cost, measured

Fourteen review rounds on eleven tasks. The reviews, not the tasks, are where
the branch's real work went, and the pattern is one sentence: **a rule written
in prose is not a rule until something refuses it, and my own commit messages
repeatedly claimed more than the code held.**

What the reviews caught that the tasks did not:

- A producer cap a session setting could triple (REPEATABLE READ takes its
  snapshot at lock acquisition), and then **the fix for it had the same defect
  inside it** — `withIsoDates` returned early on any existing `datestyle=`, so
  the isolation pin it added was never appended.
- A promotion that sealed under the caller's uuid spelling while `read` rebuilt
  the canonical one: a promotion that succeeded and produced a payload that
  never opened — the empty rescue Task 9 existed to close, reopened one column
  over.
- An M1 guarantee ("a shredded counterparty can never be observed again") that
  was false in a race window; it is now a database trigger, because measurement
  refused the sentence.
- A `reason` union that asserted an exclusivity the data lacks: a month whose
  grace ran out before its namespace was erased was both, came back as
  `erased-namespace`, and vanished from the retention count.
- A deadlock reachable through the store's own public API, now mapped.
- A lexical clock gate that held two spellings while a dozen walked past it,
  one of them planted inside `expirePeriods` with the gate green.
- Four separate rules made invisible by **fixture values that happened to be
  equal** — `shredded_at` and `expires_at` being the same instant in the only
  test that asserted either.
- Batches of one hiding a reporting contract: `slice(0, 1)` passed 368 tests
  because every sweep in the suite returned exactly one row.
- A test name claiming the store writes no audit row while the assertion read
  an in-memory array the store cannot write to. Planted an `AuditChain.append`
  inside `expirePeriods`: 462 of 463 green, and the one red was a test of
  another rule entirely.

## The three mutation lessons, since they cost the most

1. **When a mutant dies, ask which test killed it.** A test of another rule
   going red is not evidence. This was got wrong once on this branch and
   written into a commit message as "measured".
2. **Mutate both sides of a binding consistently as well as separately.** A
   consistent rename passes every round-trip test.
3. **Colliding fixture values make a rule invisible.** Four times.

And one about the harness rather than the code: **never read an exit code
through a pipe.** `cmd | tail` returns tail's status, which hid a failing
typecheck for several steps.

---

## What this card did not do

- **F7 stands: the audit chain hashes the caller's body and no ciphertext
  digest.** Deliberate, recorded in §1 and §8, carried to M3. Nothing refuses a
  `payload` key in an audit body today.
- **Tag retirement is a column, not an operation.** `retired_at` and its rules
  shipped; `retire()` is M4's, and the surface pin refuses it until then.
- **`listLive(since)` after a moved instant** is undecided; M4's card decides
  whether the window wants the opening instant or the last refresh.
- **R2 and R3 were never vetoed or accepted in writing.** §7 named two veto
  windows, both passed, both tasks shipped. §7 now records them as accepted by
  silence and says plainly that the asking was the part that failed: no
  deadline, no stated meaning for silence, on our own work.
- **The whitepaper's line 145** said the per-source rate limit was "designed
  and scheduled rather than built". It is built, and the sentence was corrected
  on `whitepaper-source` (`3a0eba9`) in both languages -- with the clause R3's
  own reasoning demands: until sources are authenticated the cap bounds volume
  per DECLARED source and an attacker rotates names past it, so Section 7 does
  not get to call it an attack counter. Source only; the built PDFs are still
  the stale ones.

## Where the numbers stand at close

`packages/store` 508 tests over 15 files, `packages/schema` 105,
`packages/tagging` 329, root gates 18. Green under process timezones
`Pacific/Kiritimati` (+14) and `Pacific/Midway` (-11), and green with
`extra_float_digits=0`, `timezone=Pacific/Pago_Pago` and `datestyle='German,
DMY'` set at the DATABASE level all at once -- which is the measurement the
three connection pins exist for, and which nothing had ever run before the
close-out audits.

All twelve gates of §5 were re-measured at close against planted violations,
one per rule, each going red at a test naming the rule it holds. That
measurement was made by a review agent in its own worktree and its own
database and is recorded here as its report, not as something re-run line by
line afterwards; the four mutants that its sibling reported as surviving WERE
re-run here against the whole suite, and three of the four turned out to be
held in a test file the agent had not run. Which is the first lesson above,
pointed the other way: a mutant that survives a subset proves nothing either.

---

## Three audits after the card was already "finished"

The card was finished twice before it was finished. Each of these ran after a
commit had said the work was done, and each found something no amount of
re-reading would have.

**A ten-lens review of the whole diff.** 73 raw findings, 40 after triage, each
then given three independent refuters with different lenses, and every survivor
REPRODUCED by running it rather than argued about. 36 reproduced. Most became
commits; eight are recorded in the plan's §2d as deliberately not fixed, with
reasons. The ones worth remembering: `withIsoDates` had its third and fourth
bypass (a pin can be *present* without being *in force*); `promote` read a
column it did not lock and wrote a permanent copy of an erased counterparty's
evidence; a foreign key asks whether a row exists and not what is in it, so an
observation could be written under a month key that had been shredded; a temp
table called `namespace` answered the erasure gate, needing no privilege a
plain application role lacks; and the sweep's order was `localeCompare` with no
locale, which made it a property of `LANG`.

**A run against a differently configured Postgres, and over a non-empty
database.** Neither had ever been done. It found the one WRONG ANSWER on the
branch: under `extra_float_digits = 0` the store hands back a float it did not
store, and M2's read-modify-write of a baseline then turns that into a named
refusal that reads as impossible on a write that was correct. It also found a
test that held only EAST of Greenwich -- the mirror of the constraint this
branch had already found wrong only to the west -- and that `0007` over a
pre-branch database fails with a constraint name and no remedy, which it now
refuses by name instead.

**A re-run of the branch's own mutation claims.** ~130 mutant descriptions in
48 commits, 145 re-run at HEAD. 139 still died. Four had stopped being held,
in four distinct ways: one killer DISARMED by a later task adding a second
call the stub did not cover; one rule claimed to have a killer that was never
written; one plant the gate was credited for catching while sixteen fixture
tests did the killing; and one killer whose test name was about a different
rule, named in a commit after a test that had never existed. All four fixed.

The lesson the three share, and it is the card's real one: **every claim on
this branch that nothing could refuse turned out to be wrong, and the ones that
survived longest were the ones written most confidently.** The commit messages
are unusually careful and that is exactly what made them worth auditing.
