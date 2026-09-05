# M1 decision ledger

**Milestone:** M1, the Postgres stores. Branch `m1-stores`, 26 commits from
`cf84d55`, merged after the whole-branch review.
**Spec:** `docs/superpowers/specs/2026-09-07-m1-stores-design.md`
**Plan:** `docs/superpowers/plans/2026-09-07-m1-stores.md`

The commit messages carry the outcomes. This file carries the reasoning, and
what each ruling costs if it turns out wrong. Where a reviewer corrected the
controller, that is recorded as a correction rather than quietly adopted.

---

## Why the milestone ran on a branch

M0 ran on `main`. M1's first task tightened `@nonametrust/schema`, which the
indexer developer has already integrated against with a delivery due
16 September, and landing a tightening on `main` mid-delivery moves the ground
under him. Cost if wrong: one merge that would not have been needed.

---

## The contradiction M0 carried forward

M0's third carried note held a conflict. One note wanted fixtures to hold
identifiers that were shape-valid but not checksum-valid; the repository's leak
gate refuses anything shape-valid in a tracked file, checksum or not. Both
could not hold.

**Ruling: the two gates are about different things, and separating them
dissolves the conflict rather than trading one property for the other.** The
leak gate's subject is tracked files and its failure mode is publishing a real
person's account identifier; it does not change. The wallet gate's subject is a
runtime value and its failure mode is one counterparty counted as many, so it
became a **negative** check: for a wallet, the identifier may not have the
muxed shape. That is exactly the claim the whitepaper makes. Fixtures stay
short and obviously synthetic, and the residual claim — that a wallet
identifier is a checksum-valid account — is written into the contract document
as the indexer's own and explicitly ungated.

Cost if wrong: an input that should have been refused reaches the store and is
caught later by the indexer's own validation instead.

**A consequence worth knowing.** The refinement changes the exported type from
a plain object schema to an effects wrapper, so `.shape`, `.extend` and `.pick`
are no longer on it. Nothing in this repository used them. The indexer's code
is not visible here, which is why the developer was told before the version
landed rather than after.

---

## The rulings that changed the design

**A wrapped data key is bound to its namespace.** A wrap swap was characterised
as denial of service. It is not: copy one namespace's wrapped key into
another's row *before* the first is shredded, and a live copy of its data key
survives the shred, while its observation rows stay in place by design and
their associated data is reconstructible from the rows. Anyone later holding
the master key recovers the evidence that was supposed to be gone. That is
shred-evasion, and crypto-shredding is the only erasure this design has. Fixed
rather than recorded because the repository already generated the identifier
before it wrapped, so it was free then and six call sites deep later.

**The associated data binds the derived columns, not just the row's identity.**
Found by the whole-branch review. The promotion trigger measures against the
`dated_at` column, and under the associated data's own threat model an attacker
with table write access can move that column while the payload still opens, so
a promotion would carry the row's instant rather than the evidence's. The
layout freezes with the first stored payload, so widening it after merge means
re-encrypting every row. Cost if wrong: one more failure mode where a
legitimate read is refused.

**`permanent_record` is append-only, which the spec did not require.** Every
one of its columns is fixed at promotion time with no designed post-insert
writer; the migration itself calls `confidence` a historical fact, and a
historical fact with an UPDATE path is not a fact; counter-evidence cancels a
tag and never reaches this table; and if observations are append-only so
history replays, the promotions derived from them must be equally fixed.
Concretely, a DELETE silently removes evidence from a day-21 brief with no
trace. Cost if wrong: a mistaken promotion needs a cancellation row rather than
an edit.

**`namespace` gets a guard of its own.** It was the only table without one.
Updating the identity re-attributed every observation, tag, record and baseline
of one counterparty to another in a single statement, and a pre-shred copy of
the wrapped key could un-shred a namespace while satisfying every existing
check. The repository closed both paths and the table did not, which is the
shape the spec's own section 6 warns against. A re-wrap of a live row stays
open, because key rotation needs it. Its own SQLSTATE, because a shred reversal
is not an append-only violation and an operator must tell them apart by class.

**A caller-supplied idempotency key that disagrees with the derived one is
refused, not silently replaced.** The deciding argument was not the one the
controller reached for. It is that silent replacement produces a later
contradiction: a caller who writes with a key and then asks for it gets nothing
back for something the store said it created. A claim accepted and then denied.

**Shredding an identifier that has no row throws; shredding an already-shredded
row stays a success.** A repeated erasure request is not an error. An erasure
request naming a subject that is not there is a different thing, because
returning success tells an operator the data is gone when nothing was examined.

**Promoting into a shredded namespace is refused.** Not for privacy — the
record holds no payload and the observation rows survive a shred by design. A
promotion exists to make evidence surface in a future brief, and evidence whose
content is permanently unreadable can only produce a reason nobody can explain.

**The day seal is checked against the entry it sealed, not a recomputed head.**
Nothing makes the entry instant monotone, so an append whose instant falls
before a sealed day's close moved that day's head, and every later seal raised
a mismatch with no repair, since the seal table is append-only. The seal states
that at a day's close the head was a particular entry with a particular hash. A
backdated entry does not falsify that statement. The mismatch class now means a
rewrite and nothing else.

**`sealDay` does not verify before sealing.** The seal states what the head
was; verification states the chain is internally consistent. A seal over a
broken chain hides nothing, and refusing to seal would remove the auditor's
ability to bound *when* the break happened, because the last good seal is the
evidence. The nightly job verifies and refuses; that contract is on the
function.

**The audit chain's fidelity check lives in the verifier, not in SQL.**
Re-deriving a canonical JSON form inside the database would make the chain's
meaning depend on a Postgres version's serialisation, and a chain that must
verify in a year cannot rest on that. The one place SQL touches the canonical
form uses jsonb **equality**, a value comparison, which is version-stable in
the way text rendering is not.

**The composite namespace keys are kept.** An implementer applied an earlier
task's finding to two new tables on its own initiative and asked for
confirmation rather than assuming it. The failure is real: a trigger's
namespace is a denormalised copy of its observation's and the nightly job
filters on it without joining back, so under independent keys a trigger can be
filed under the wrong counterparty and become a candidate there. This milestone
exists so later ones add code and not migrations, and a pair key added later is
a migration.

**`permanent_record.rescued_by` got the same pair key.** Not only for
consistency: the design's acceptance criteria include a locality test, that an
unrelated counterparty's tags are not promoted by a trigger, and a record in
one namespace whose rescuing trigger belongs to another is exactly that
violation with nothing refusing it.

**One error class for the constraints the database raises directly.** Nine
constraints were reachable only as raw driver codes while the package's own
docstring claimed every invariant maps to a class. The next milestone would
have written a raw code comparison, which is the message-text problem in
another costume.

---

## Where the plan was wrong, and a reviewer or an implementer was right

**The plan's own test asked for the impossible.** It claimed suppression never
drives strength to zero, using a factor and a span that ask for a power of one
half below what a double can represent. The only implementation that could have
passed it is a clamp to a positive constant, and a clamp would make strength
not a function of its inputs, breaking the property the whole design rests on.
The implementer escalated, kept the arithmetic, moved the test and pinned the
underflow boundary. The claim is about the mechanism, not about floating point.

**The controller's stated cost for the shred ruling was wrong.** It said
distinguishing a missing row from an already-shredded one would need a
preceding read. One statement does it, and the same statement preserves the
first erasure timestamp across a repeat, which is the compliance record.

**A reviewer's suggested test fixture would have gated nothing.** It proposed a
migration file that half-applies. Postgres parses a multi-statement simple
query whole before executing any of it and runs it as one implicit
transaction, so no fixture failing *inside* one file can distinguish a wrapped
runner from an unwrapped one. The implementer said so and was verified
empirically by the next reviewer.

**The plan's migration runner leaked a lock.** A session-scoped advisory lock
taken on a pooled connection can have its release land on a different session.
Pinned, and gated by a test that fails when the release is removed. Deferring
the follow-on finding had a price that came due four tasks later, when a second
migrating test file made the lock proof see another worker's lock.

**The plan's duplicate-retry was too wide.** It re-read after any insert
failure, so an unrelated failure could return another writer's row as "already
stored".

**The plan's comment would have failed the gate the milestone had just
widened.** The date-reader gate matches the field names inside comments too,
and the store's comment named two of them while explaining why the package
names none.

---

## What is enforced where, stated plainly

The database holds: append-only on observations, permanent records and both
audit tables; byte-exact namespace identity through an explicit collation; the
promotion timestamp; chain linkage and hash integrity; finiteness on every
float; the locality pairs; namespace identity and shred state.

The application holds: the canonical form's fidelity to its row; tag strength,
which is computed and never stored; the derived-column binding, through the
associated data; suppression as accelerated decay, through a repository that
offers no deletion.

Stated and **not** enforced, deliberately: that a wallet identifier is a
checksum-valid Stellar account, which is the indexer's rule; revocation of
UPDATE and DELETE from the deployed application role, which is the second line
behind every append-only trigger and cannot be exercised on a cluster where the
suite runs as owner.

---

## Carried into M2 and M3

- **Zero-spread handling must be defined before M2's first write.** A robust
  z-score with zero spread yields infinity or a not-a-number from the same
  expression and the store refuses both. Infinity does not merely fail to rank;
  it destroys magnitude, so two zero-spread triggers cannot be ordered and
  everything derived from surprise afterwards is infinity or nothing.
- **Two refusal shapes exist and M2 will call both.** The tag repository
  refuses argument nonsense with a range error before the statement; the four
  arithmetic-free tables let the database's check fire. Both are legitimate;
  M2's dispatch should say once which means what.
- **Every advisory lock in this package is session-scoped unless it says
  otherwise**, and a session-scoped lock on a pooled connection must be pinned.
- **The seal is write-only in M1.** Nothing reads `audit_day` back against the
  chain. M4 owns a seal verifier as a named deliverable.
- **A shredded counterparty can never be observed again.** Re-keying would
  leave readable and unreadable rows behind one shred marker, so `ensure` never
  re-keys. Erasure means permanent blindness to that counterparty. This is a
  product consequence and it is not in the spec.
- **Indexes the nightly read will want** on the namespace columns of
  `trigger_event`, `hot_window` and `permanent_record`.
- **The store never runs the per-channel payload validators**, because `append`
  parses rather than validating. Whichever task wires ingest owns that.
