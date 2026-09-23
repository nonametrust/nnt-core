# Storage card (migration `0007`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Design authority:** this milestone has no separate spec file. Its design is
> the board card "Depo kartı (migration 0007)" on
> `github.com/orgs/nonametrust/projects/1`, together with the rulings the
> M2 ledger carried forward. This plan was written against the shipped code
> rather than against either, which is the card's own rule, and section 1 is
> what that rule produced.

**Goal:** Land migration `0007` and the store code around it so that M3 opens with nothing on the storage card still open: retention as unreadability on a per-`(namespace, calendar month)` key, the `tag` table keyed on the aspect with a refresh that stores what M2's arithmetic returns, the two baseline checks M2's arithmetic now assumes, the permanent copy a promotion re-seals, the producer cap, and the gates that hold each of these from any writer.

**Architecture:** One migration file grown across the tasks on the branch (it is applied nowhere until merge; `migrate.ts:57-73` freezes a file only once a ledger records it), one new versioned value `RetentionPolicy` in `packages/store` because the store may not import `packages/tagging` (`packages/store/package.json` depends on `schema` alone), one new table `namespace_key`, and repositories rewritten where M1's shipped semantics contradict M2's shipped decision type. Everything invariant is held by Postgres; the TypeScript refuses first and names the class, which is M1's two-shapes rule (`packages/store/migrations/0003_tag.sql:10-16`).

**Authorities read:** board card "Depo kartı (migration 0007)" and its 12 and 21 September addenda; `docs/superpowers/ledgers/2026-09-12-m2-decisions.md` §"Carried into M3 and the schema card" (615-743) and the rulings it points at; `docs/superpowers/ledgers/2026-09-06-m1-decisions.md`; the M1 and M2 specs and plans; migrations `0001`-`0006`; every repository; `packages/tagging/src/tag.ts`, `baseline.ts`, `policy.ts`, `reading.ts`; the whitepaper source at `whitepaper-source:docs/whitepaper/nonametrust-whitepaper.en.md` (line 141 is the retention paragraph, line 145 the rate-limit sentence); `origin/feature/indexer:docs/indexer-run-2026-09.md` for the one measured ingest volume that exists.

**Blocking question:** closed, as instructed. `5b8b406` on `whitepaper-source` reads "replayed deterministically over the retention window" (en.md line 141). The design is ratified; nothing below reopens it.

---

## 1. Findings: where shipped code contradicts its design document or the card

The card's rule is that the plan is written against code. Reading the code found the four things the card names and seven it does not. Where the card and the code disagree, the code wins and it says so.

**F1. `TagRepository.refresh` is the M1 semantics, not M2's, exactly as the card says.** `packages/store/src/repositories/tag.ts:141-152`: `greatest("g0", val)` at :146 over the *stored* `g0`, `refresh_count + 1` at :147, no `tagged_at`, no `saturation_state`. M2's `refreshTag` (`packages/tagging/src/tag.ts:148-185`) takes the maximum over the *decayed* strength (:176), moves the instant forward (:165), and returns `{ g0, taggedAt, refreshCount, saturationState }` (`TagRefresh`, :36-41). The M2 ledger 624-632 says these four must be stored as returned. Cost of leaving it: with the instant moved, `greatest` over the stored value revives a tag to full at every repeat; without moving it, a standing condition fades while it holds (M2 spec §16, lines 388-393 of the spec file). Confirmed, and the store must also stop computing anything in a refresh: the arithmetic lives in tagging and the store has no policy to bound by.

**F2. `TagRepository.open` stamps `tagged_at` from the clock, and M2's decision stamps it from the event. Not on the card.** `tag.ts:77` writes `taggedAt: this.clock.now()`; `tag.test.ts:191-194` pins it ("stamps taggedAt from the injected clock, not from the database's now()"). M2's `decide` returns `kind: "new"` with `taggedAt: instant` (`tagging/src/tag.ts:314`) where `instant` is the event's own instant clamped to `at` (:265-271); for a state it is `at`. M1's own acceptance test insists the two instants differ ("Ingested a minute after each was observed ... A repository that confused the two would fail criterion 3", `acceptance.test.ts:263-266`). Cost: every event tag dated at ingest rather than at the event, decaying from the wrong instant; on a backfill the whole history is dated the day it was loaded, and `refreshTag`'s `max(live.taggedAt, instant)` then compares a store-stamped instant to an event instant. `open` must take `taggedAt` from the decision. This is the second M1-versus-M2 contradiction the card did not see.

**F3. The `tag` table has no `aspect`, and there is also no live-tag lookup by pair at all.** `0003_tag.sql:25-41` and `StoredTag` (`tag.ts:11-21`): channel only. `TagDecision` carries `aspect` (`tagging/src/tag.ts:201-203`), `LiveTagInput` is "the live tag on a (namespace, channel, aspect)" (:17-18), and `tagObservation` takes contexts keyed by aspect (:410-418). The only reader is `listLive(namespaceId, since?)` (`tag.ts:161-170`), so M3 would have to filter in memory and could not tell two live tags on one pair apart. And `tag.test.ts:338-342` opens two `volume` tags on one observation in one namespace, which a one-live-tag-per-pair rule refuses; that test changes on purpose.

**F4. Both baseline checks are missing, and the store fixture is worse than the card says.** `0006_baseline_trigger_volatility_window.sql:28-36` ties nothing between `n` and `median_est`, and :33-36 leave both estimates independently nullable; :14-17 explicitly leave "whether median and MAD arrive together" to M2. Tagging now refuses a positive count with a null pair (`tagging/src/baseline.ts:124-128`), a zero count with a location (:115-117), one estimate without the other (:107-111), and `medianEst !== mean` by strict equality (:136-140). The card names `baseline-trigger-volatility-window.test.ts:96` (`count: 2, medianEst: null, madEst: null`), correctly. What it does not say: the suite's default fixture `aBaseline` at :60-68 has `mean: 512.5, medianEst: 500`, and the signed-column case at :152 has `mean: -3, medianEst: -2`. Every baseline row the store suite writes is a row the arithmetic refuses. The fixture, not one line, changes.

**F5. `ingested_at` is a derived column beside the payload that the payload is not bound to.** `payloadAad` binds six parts (`crypto.ts:106-121`); the M1 spec §5 (201-207) and the AAD test (`observation.test.ts:286-296`: "Every derived column is therefore inside the envelope") both claim every derived column is bound, and `ingested_at` (`0002_observation.sql:27`) is not. The card is right to fold it in "while the layout is still free", and the code says what "free" costs: `crypto.ts:39-42` freezes the layout at the first stored payload. Nothing is deployed, but the migration must make that a fact rather than a belief: `0007` refuses to run over a non-empty `observation` table (Task 6), because an existing row is sealed under the namespace key with the old layout and has no month key.

**F6. `permanent_record` holds no payload and `promote` never opens the observation.** `0004_permanent_record.sql:19-39`; `promote` (`permanent-record.ts:87-138`) pre-reads `dated_at` and `key_shredded_at` (:92-103) and copies `dated_at` by insert-from-select (:114-132) without ever decrypting. The whitepaper's retention paragraph (line 141) says a promotion re-seals the rescued payload under the counterparty key, and the card names "payload columns on permanent_record". The M1 ledger's reason for refusing a promotion into a shredded namespace, "evidence whose content is permanently unreadable can only produce a reason nobody can explain" (M1 ledger 119-122), applies verbatim to an expired month, and nothing today would refuse it: a promotion after expiry succeeds with nothing rescued. `promote` must open, re-seal, and refuse `PayloadExpired`; the M1 ledger's phrase "the record holds no payload" (line 120) stops being true and the reason gains a second leg.

**F7. The audit chain hashes whatever body the caller gives it; nothing commits to a ciphertext digest.** Whitepaper line 141: "the chain and the anchored roots commit to ciphertext digests rather than plaintext". `chain.ts:129-160` renders the caller's `body`, and the store computes no digest of `payload_ciphertext` anywhere. Not this card's to add (it is not on the card and would be an invented column), but a contract M3 owes: an audit body that carries payload plaintext outlives its key inside `audit_entry`, which is append-only under `0005:125-138`. Carried, with a one-line gate suggestion under Risks.

**F8. `append` cannot answer an expired re-delivery.** `AppendResult` (`observation.ts:12-15`) is `{ observation, created }`; the pre-read at :64 is `byIdempotencyKey` (:137-139), which goes through `read` (:149-178) and opens the payload. Once the month key is gone that pre-read throws, so the indexer's normal retry path (:41-46, M1 spec 484-490) becomes an error ninety days after a month closes. The card's "append handling an expired re-delivery" is this.

**F9. The M1 design excluded a time-based key on purpose, and the M1 ledger's re-key argument assumed one key per namespace.** M1 spec §5 231-235: "no per-day key ... each is a change to operations, not to the schema". The card overrides that with a month key, which is a schema change. M1 ledger 240-245 argues against re-keying a shredded namespace because it "would leave readable and unreadable rows behind one shred marker"; under period keys, readable and unreadable rows behind different markers is the designed normal state. The ruling that a shredded namespace is never re-keyed still holds (a shred is total), but its stated reason no longer carries it alone; the plan restates it as: a namespace shred is the outer key and there is no inner key to mint under a null outer one.

**F10. Retirement is named in three documents and exists nowhere.** M0 spec line 295 ("expired tags are retired"), M1 spec 262-267 ("expiry from the bounded window is a separate, named operation"), `tag.ts:47-53`. No `retired_at`; `listLive` returns every row (:154-160, and its docstring says so). The column and its one-way rule land here; the operation is M4's, as the card says.

**F11. The store has no lexical clock gate.** `clock.ts:2-5` states the rule; `clock.test.ts` tests `fixedClock` only; the only wall-clock read is `systemClock` at `clock.ts:12`. Tagging has the gate (`tagging/src/boundary.test.ts:41`, regex `CLOCK`). `expirePeriods` is the first store operation whose *result* depends on the clock argument, so the gate is added here with the tagging regex and one exemption.

**F12. The card's "ingested_at index" is for the producer cap, and the code says it needs `producer` beside it.** No reader of `ingested_at` by range exists today (`0002:45` indexes `(namespace_id, dated_at)`). Expiry reads `namespace_key`, not `observation`. The cap counts `where producer = ? and ingested_at > ?`, so the index is `(producer, ingested_at desc)`. Refined, not contradicted.

**F13. The card says "observe writes the producer"; the code's rule is that every column beside the payload is derived from one parsed object.** `observation.ts:77-83`, held by `observation.test.ts:118-123`. `producer` is derived by `append` from `source.producer` (`schema/src/source.ts:20-26`, a bare lowercase name) and bound into the AAD like every other derived column; `observe` passes nothing. Code wins.

**F14. Two small pins that will go red on purpose.** `errors.test.ts:66-70` asserts unknown SQLSTATEs map to null, so the two new codes must be added to `BY_SQLSTATE` (`errors.ts:105-111`) and to the table at :25-36. `tag.test.ts:98-107` pins the `tag` column list and :115-121 the repository prototype, exactly so that "an added column of any name is a decision"; both are re-pinned in Task 2 and 3 and the decision is written where they are.

---

## 2. Rulings this plan makes, so no implementer has to

These are mine, could be overturned, and each says what it costs. They are the places a reviewer should look first.

**R1. The period is the UTC calendar month of `ingested_at`.** Not `dated_at`: a state has none (`0002:39-42`), and a backfill keyed on the event's month would be born expired, which contradicts "no observation is dropped at write time". UTC because the card's month must not depend on a process time zone. Cost if wrong: a month boundary in another zone is a different bucket, and changing it is a re-keying of every row after the change.

**R2. `expires_at` is fixed on the `namespace_key` row at mint, from the period and the policy in force, and the guard refuses shredding before it.** The DB cannot hold a policy number it does not have, and a guard that read `now()` would break the injected-clock rule and every simulated-day test. So the repository computes `period close + graceDays` once, writes it, and the trigger holds `shredded_at >= expires_at` against the row's own value, no wall clock. Cost: a later policy that shortens the grace does not shorten months already minted; that is a migration, loudly, the same shape as the M2 ceiling ruling (M2 ledger 214-225).

**R3. The producer cap is per producer over a sliding window on `ingested_at`, counted and inserted under a per-producer transaction advisory lock so it is exact.** A "rate" is over ingest time; that is what the whitepaper's "per-source rate limit" (line 145) means and what the growth argument on the retention card needs. Scope is per producer, not per (producer, namespace): the cap is a defence against a misbehaving *known* producer, because the producer name is free text (`source.ts:20-26`) and an attacker rotates names until signatures are enforced, which is the open gap the M2 ledger names (286-287). Cost: a legitimate burst above the cap is refused; the numbers are chosen so the largest delivery measured to date passes in one window (section 5).

**R4. `refresh` is optimistic: it writes the four fields as handed, matched on `refresh_count = handed − 1`, and a lost race is `TagRefreshStale`, never merged.** M1's single-statement `greatest` (`tag.ts:133-140`) existed because the store could merge two refreshes arithmetically. It no longer may: the merged value depends on the decayed strength at `at`, which the store cannot compute without the half-life it deliberately does not hold (`strength.ts:20-22`). Two concurrent refreshes from one live row are one success and one refusal, and M3 re-reads and recomputes. The concurrency test at `tag.test.ts:284-292` inverts to assert exactly that. Cost: M3 needs a retry loop on `TagRefreshStale`; the alternative was a silently wrong strength.

**R5. One live tag per `(namespace, channel, aspect)`, held by a partial unique index.** M2 criterion 4 and `tagReading` (`tagging/src/tag.ts:367-403`) assume exactly one live tag per pair (`LiveTagInput | null`). Holding it in the database turns "never yields two tags inside one window" from a promise into a constraint. Cost: `tag.test.ts:338-342` changes to use distinct aspects; a retired tag frees the pair.

**R6. `0007` grows across tasks on the branch and refuses a non-empty `observation` table when it runs.** One file, as the card requires; grown because the retention core cannot land in one reviewable task. The drift check (`migrate.ts:67-72`) is about applied ledgers; nothing has applied `0007`. The preamble refusal is what makes "the layout is still free" a fact the migration checks rather than a sentence in a card. Cost: if anything had been deployed, `0007` would need a re-encryption task; the refusal says so instead of corrupting.

**R7. The store gets its own versioned value, `RetentionPolicy`, and M3's audit body names both versions.** Store cannot import tagging (dependency table in the M0 spec, `store/package.json`), and the four inputs are the store's. Cost: two policy versions where the M0 spec (line 306-311) says one file; the engine composes them, and every audit row carries both.

**R8. `period` is a `date` column that the repository never reads back as a driver `Date`.** The driver parses a `date` at *local* midnight (db.ts:72-75 records that no parser is configured), and a process east of UTC would then re-render `2026-09-01` as `2026-08-31T21:00Z` and look up the wrong month key, silently. Every select of `period` renders it as text in SQL. A test sets `TZ` to a zone ahead of UTC and proves the round trip. Cost: one cast per query.

---

## 2b. Rulings added during execution, not in the plan's own list

Each came from review and each is recorded here because a guard rule nobody
argued for is a rule nobody can revisit.

**R9. The tag guard refuses a falling `suppression_factor`.** The repository
took the greater of the two and its own test called lowering one "a way to
revive evidence that nothing in the design asks for" — held only there, it was
a promise a raw writer could break.

**R10. A retired tag is not refreshed, and one statement may not retire and
refresh at once.** The first rule alone reads `old.retired_at`, so a single
statement that does both passed it: the row was live when the statement began.
The result would be a retired row carrying a strength no decision produced.

**R11. `retired_at` is not before `tagged_at`.** A tag cannot retire before it
was opened. This is also what makes a future-dated tag unretirable, which is
why R12 exists.

**R12. A tag may not be stamped after the store's clock**, refused in
TypeScript by `open` and `refresh`. A future-dated tag is full strength
forever, because the decay curve reads any instant before the tag as `g0`, and
under R11 it cannot be retired either. M2 never produces one, since `decide`
clamps an event to the caller's `at`; the database cannot hold the rule
without a wall clock, which the injected-clock discipline forbids. **This is
what the repository's `Clock` is for now that `open` takes its instant from
the decision** — the alternative was to delete a constructor parameter that
had quietly become dead. Cost if wrong: an engine whose clock runs ahead of
the store's has legitimate decisions refused; in v0 both are one process.

**R13. The eight-part envelope lands with the `producer` column and the
migration preamble, which the plan assigned to Task 6.** Task 4 is scoped "no
database", but `PayloadBinding` gaining `producer` breaks `observation.ts`:
`append` has `source.producer`, and `read` has no column to rebuild it from.
The envelope cannot land half-wired, and binding a value the read side cannot
verify would be a binding in name only -- it would round-trip, because seal
and open would agree on the same invented value, and no test would see it. So
`producer` (with its shape check and its not-null) and the R6 preamble came
forward with the layout move that needs them; F5 already tied the preamble to
that move. Task 6 keeps `period`, the period check, the `namespace_key`
foreign key, the `(producer, ingested_at)` index and the observation
catalogue pin, all of which genuinely wait on Task 5. Cost: Task 4 touches
the migration after all, so its reviewer reads SQL the plan did not promise
there; and Task 6 is smaller than its own acceptance list reads.

**What Task 6 must not silently re-green.** `observation.test.ts` now asserts
that a raw `ingested_at = ingested_at + interval '1 month'` is refused as
`CiphertextRejected`. Once Task 6 adds `observation_period_from_ingested_at`,
that same UPDATE fails at the check with 23514 BEFORE the envelope is ever
consulted, so the assertion inverts on purpose: it becomes 23514 by
constraint name, and the test must say which layer refused. An implementer
who edits it back to green without reading this has removed a gate. The
one-hour move stays `CiphertextRejected`, because it does not change the
month, and the pair is what shows the two layers apart.

**Already done, not Task 6's any more:** the `producer` column with its shape
check (regex *and* the schema's 64-character bound) and its not-null, the R6
preamble with its own test, and the two additions to the move list. Gate G8's
"producer shaped" shipped in Task 4; the gate table's row is stale. 0007's
sections now read 1 baseline, 2 tag, 3 observation.producer, so Task 5's
`namespace_key` is section 4, Task 6's period work section 5, and Task 9's
permanent columns section 6 -- one higher than this plan says throughout.
`observation` is therefore altered in section 3 and again in Task 6's
section, which is correct (the period's foreign key needs `namespace_key`
first) but is not the shape the plan describes.

**Correction to Task 4's acceptance text:** it says "a payload sealed under
the seven-part layout fails to open under the eight-part one". The layout
that shipped has six parts, not seven; the test built the six-part envelope
by hand and proves it. Nothing else depended on the number.

**Correction to `permanentAad`'s stated reason.** The plan says the domain
literal works because "no uuid can equal `permanent`". That is true and it is
not what carries the property: `payloadAad` does not check that its namespace
id is a uuid, so a caller passing the literal itself is the case that reason
does not cover. What carries it is the part count -- six against eight, with
no part allowed to contain the separator -- so the two envelopes cannot be
equal for any inputs at all. The test asserts the adversarial case and the
structural reason, not the slogan.

**R14. A live month key is never replaced, only nulled by a shred.** The
`namespace` table deliberately admits a live re-wrap, because rotating the
master re-wraps every namespace key under the new one. No such reason exists a
level down: a month key is wrapped under the namespace data key, and M1 rules
that key is never rotated. Without the guard branch a live month can be
silently re-keyed, stranding every payload already sealed under the old key
while the row still says the month is live -- and the read reports it as a
tamper, naming the ciphertext rather than the write that caused it. Found
because the row-copy test depended on the hole; that test now disables the
trigger, which is honest, since the envelope's threat model assumes exactly
that. Cost: a future master rotation that also re-keys month keys becomes a
migration rather than an UPDATE.

**Correction to Task 5's reasoning about check constraints.** The migration
first said Postgres refuses a bare `timestamptz` comparison in a CHECK because
it is only stable. That is false: Postgres enforces immutability for index
expressions and generated columns, never for CHECK. The immutable form is
still correct, for the reason that actually holds and was measured -- the
naive form converts using the SESSION's TimeZone, so for period `2026-03-01`
it demands `2026-04-01T04:00Z` under America/New_York and admits
`2026-03-31T21:00Z` under Europe/Istanbul. It is wrong in both directions and
which one depends on a setting no migration controls.

**Correction to the cap's derivation.** §6's rule is a full order of magnitude
over the measured delivery, which any value at or above 6,468,900 satisfies.
Rounding up to the next power of ten is a *convention* applied after the rule,
added in the same commit that moved the constant; calling it part of the rule
would be the reverse-engineering the section exists to record. The test now
asserts the rule and the convention as two separate claims, so a veto of the
convention leaves the rule standing.

**R15. The row's own primary key is inside the payload envelope.** `payloadAad`
bound the namespace and the idempotency key but not `observation_id`, which is
what every foreign key in the schema hangs from. Measured by review: with the
append-only trigger off, exchanging the whole contents of two rows in one
namespace -- idempotency key, derived columns and ciphertext together -- left
both opening, so the evidence behind a tag became another observation's and
nothing in the store could tell. Nine parts now, and `read` additionally
refuses a payload whose parsed id is not the row's. Cost: the layout moved a
third time, which is free only until the first deployed row, and the migration
preamble is what keeps that true.

**R16. `expires_at` is bounded above as well as below, and the repository
refuses a month whose expiry its own policy did not compute.** `namespace_key`
has no INSERT guard -- every guard in this schema is update/delete -- and
`periodKey` is on-conflict-do-nothing, so a row planted before the legitimate
mint WINS. Planted with an expiry in 2999 the month is never swept and its
payloads stay readable indefinitely. The check bounds expiry to ten years past
the period, which is deliberately generous: it is not a policy number, it is
the line between a grace and a mistake. Cost: a policy that genuinely wanted
longer is a migration, which is the same shape as R2.

**R17. Every connection this package opens pins `DateStyle=ISO`, and the
period is rendered by `to_char` rather than by `::text`.** Two separate
mechanisms for one setting. The binding a month key is wrapped under was built
from `period::text`, which renders through the session's DateStyle: the same
date is `2026-09-01` under ISO and `01.09.2026` under German, so a key minted
under one and opened under another refused as `CiphertextRejected` -- a tamper
report for a `postgresql.conf` line. That is the same class of mistake as the
naive CHECK inheriting the session's TimeZone, one function away. Separately,
under a non-ISO DateStyle node-pg cannot parse the timestamptz text the server
sends and returns **null** for every timestamp column, so a read crashes on
`.getTime()` with an error this package does not own. `to_char` fixes what we
render; the connection pin fixes what the driver parses.

## 2c. Limits of crypto-shredding, recorded rather than fixed

Two things a security review measured that no schema change can close. They
belong in the card because the whitepaper's erasure sentence is read by people
who will assume otherwise.

**A shred is reversible by anyone who can restore a pre-shred copy of the
wrapped key into its own row.** The wrap's associated data binds a key to its
row's identity, not to time, so the row-copy defence (which holds in every
direction tested) says nothing about a same-row restore. With the guard
disabled, writing captured bytes back with `key_shredded_at = null` makes the
namespace readable again; the same holds for a month key. The guard is the
only line, and the threat model this design states assumes it bypassed. **The
realistic form of this attacker is a database backup.** Irreversible erasure
therefore needs two things this repository does not have: a master-key
rotation runbook whose old master is destroyed after a shred, and a backup
retention policy shorter than the erasure promise. Until both exist, the
honest claim is "unreadable in the live database", not "erased".

**Erasure is content-only: the metadata around it survives, and the
idempotency key leaks the source references.** After a shred the following are
still plaintext: the counterparty identifier itself (`namespace.ns_id`, a
wallet address), every observation's `channel`, `kind`, `evidence_kind`,
`dated_at`, `ingested_at` and `producer`, every tag's strength and instant,
every baseline's `mean` and `median_est`, and all `permanent_record` metadata.
Two of those are worse than they look. A baseline over a single observation
has a `mean` equal to that observation's amount, so an aggregate column holds
the payload value. And `idempotency_key` is an unkeyed SHA-256 over
`(producer, network, ref, channel, kind, namespace id)` where every part but
`ref` is a column in the clear and `ref` is a public-ledger operation id: a
three-hundred-candidate dictionary recovered 3 of 3 source references of a
shredded namespace. So "which on-ledger operations were observed about this
wallet" survives erasure.

**Shredding a key erases nothing from the disk, and this is the one that most
needs saying.** Both shreds are an UPDATE that nulls a column, so:

- the previous heap tuple, carrying the wrapped key, stays on the page until
  vacuum reaches it. Review read it back with `pageinspect` and opened an
  expired month's payload from it; a plain `VACUUM` removed the bytes, and on
  a six-row table autovacuum may not run for a long time.
- the WAL record of the original INSERT carries the wrapped key. Review did a
  **blind** scan of `pg_wal` -- no prior copy of the key, only the public
  `(namespace, period)` binding -- found a wrapped key that authenticated, and
  opened the payload, *after* `VACUUM FULL`. `wal_compression=off`,
  `wal_level=replica`, which are the defaults.

So anything that archives WAL, streams to a replica or takes base backups
keeps every month key and every namespace key for as long as it keeps those,
and "the key is gone" is true only of the live heap after vacuum. This is a
property of shred-by-UPDATE on Postgres rather than anything this card chose,
and it is exactly what the sentence "shredding that key is what retention is"
rests on. Until there is a WAL-retention and backup policy shorter than the
erasure promise, the defensible claim is **unreadable through the store's
API**, and the card should not say more than that anywhere it faces outward.

**A new observation CAN land in an expired month, so the write-time rule has a
condition.** "No observation is dropped at write time" is the rule this design
does not bend, and the branch asserted in three places that the period coming
from ingest time makes it automatic. It does not. With `graceDays: 0`, which
`assertRetentionPolicy` admits as a policy, a month expires at its own close:
an append that captured its instant at 23:59:59.999 and a sweep that runs at
00:00:00.000 leave the append throwing `PayloadExpired` with nothing stored.
Reproduced end to end. The general condition is that the grace must exceed the
skew between the appending clock and the sweeping one; at ninety days it is
unreachable outside a simulated clock. Pinned by a test so Task 8, which owns
the shape of what `append` returns, changes it deliberately.

*Not decided here.* The fix, if it is one, is to derive the idempotency key
under a per-namespace HMAC, which is possible because the only reader is the
retry pre-read and that already refuses on a shredded namespace. It touches
`@nonametrust/schema`, changes every stored key, and belongs on its own card
with the baseline and tag survivals beside it. Recorded now so that nobody
reads the retention card as a privacy guarantee it does not make.

**Carried, not ruled:** a tag may still move from `open` to `saturated` with
the count unchanged. Nothing in M2's arithmetic produces it and nothing
refuses it; it belongs on M4's card beside retirement rather than being
invented here.

## 2d. What the remaining tasks must read instead of their own text

The plan was written before execution and execution moved work between tasks.
Where a Task section below contradicts this list, this list wins.

**Section numbers in `0007` are one higher than every Task says**, because
R13 gave the file a section 3 (`observation.producer`). The file now reads: 1
baseline, 2 tag, 3 observation.producer, 4 namespace_key. So Task 6's period
work is **section 5** and Task 9's permanent columns are **section 6**. The
header's section list is extended by whichever task adds one, and each section
names the task that added it.

**Task 6 shipped.** What it added: `observation.period`,
`observation_period_from_ingested_at`, the `observation_period_key` foreign
key, the `(producer, ingested_at desc)` index, the observation catalogue pin,
and `append`/`read` moved onto the month key. `0007` section 5. One design
question it closed: a NEW observation can never land in an expired month,
because its period is the month it is written in and that month has not
closed -- so the only expired-month case is a re-delivery, which is Task 8's.

**Task 6 must not redo Task 4b.** Its text still instructs the preamble, the
`producer` column and the two move-list additions; all three shipped. Followed
literally it produces a duplicate column (42701) and two sections numbered 4.
What remains for Task 6: the `period` column, `observation_period_from_ingested_at`,
the foreign key to `namespace_key`, the `(producer, ingested_at desc)` index,
the observation catalogue pin, and moving `append`/`read` onto the month key.

**Task 6 will turn one existing assertion red, on purpose.**
`observation.test.ts` asserts that a raw `ingested_at + interval '1 month'` is
refused as `CiphertextRejected`. Once the period check exists, that UPDATE
fails at 23514 before the envelope is consulted, so the assertion becomes
23514 by constraint name and the test must say which layer refused. The
one-hour move stays `CiphertextRejected`. Re-greening it without reading this
removes a gate.

**Task 6's check form is settled and measured.** `period = date_trunc('month',
timezone('UTC', ingested_at))::date`. The three-argument
`date_trunc('month', ingested_at, 'UTC')::date` is NOT equivalent: the
`timestamptz::date` cast converts in the session's zone, so the whole
expression is only stable and an index refuses it. To prove any expression
immutable, put it in an index -- a CHECK does not enforce it.

**Task 6 must not select `period` as a column.** `never` on the read side
removes it from `Selectable`, but Kysely takes select names from the table
type, so `.select(["period"])` compiles and hands back a driver `Date` at
local midnight. Read it through `periodsOf`, or with `to_char(period,
'YYYY-MM-DD')`.

**Tasks 7 and 11: every repository touching one namespace must be built from
the SAME policy object.** R16 made `periodKey` refuse a stored expiry that its
own policy did not compute, so a second repository under a different grace is
a `PeriodKeyAltered` on the next append to that namespace -- measured. Task 7's
text says "Override `graceDays` to 7 in this test" and both test files hold
file-level repositories under `RETENTION_V0`: append the fixture through one
and sweep with the other and either nothing is shredded at +7, or the next
append there refuses. Build the whole fixture from the overridden policy, or
use a namespace no file-level repository touches.

**Task 7: `returning namespace_id::text, to_char(period, 'YYYY-MM-DD')`, not
`period::text`.** The plan's text says `::text`, which R17 replaced. Under the
connection's ISO pin the two agree, so a `::text` implementation stays green
and the divergence survives review -- this branch already recorded that pair
as an equivalent mutant. `PERIOD_TEXT` in `namespace.ts` is the shared form.

**Task 7 owes a ruling on already-shredded namespaces.** The sweep as written
also nulls month keys belonging to namespaces that were erased on request --
their `namespace_key` rows still carry a key -- and returns those periods to
M4's audit as retention expiries. Reads are unaffected, since `openPeriodKey`
answers `NamespaceShredded` first; what needs deciding is whether the sweep
filters them out or reports them and says what they are.

**Task 8: the policy must be the same object.** `ObservationRepository` gains
a `RetentionPolicy` beside `NamespaceRepository`'s. Two repositories handed
different policies would expire under one number and cap under another with
nothing comparing them; the composition point passes one value to both, and
each constructor asserts it (R16's sibling, added in this round).

**Task 8 owes a ruling the plan never made: a re-delivery for a SHREDDED
namespace.** `openPeriodKey` reads the namespace key first, so such a
re-delivery throws `NamespaceShredded` out of `append`, and the indexer's
normal retry path errors forever for that counterparty. F8 named the month
version of this; the namespace version has existed since M1 and is not
written down. Either give the third `AppendResult` shape a reason field
covering both, or record that the M1 ruling makes the throw intended.

**Task 9 owes a composition answer.** Its text says `observations.get(id)`
runs "inside the same transaction", but repositories are bound to a `Db` at
construction and `promote` creates its own `trx`. Either the constructor takes
`(db, ring, clock, policy)` and builds transaction-bound repositories, or the
plan records that the pre-read is outside the transaction and why that is
acceptable.

**Task 10 has lost one item and gained none.** `index.ts` already exports
`retention.js`, because Task 5 made the policy a required constructor
argument and the package could not otherwise construct its own repository.

**Gate table corrections.** G8's "producer shaped" and all of G9 shipped in
Task 4b; G10's "migration refuses data" shipped there too. What remains: G8's
period, foreign key and catalogue pin (Task 6), G10's expiry (Task 7), G11
(Task 9), G12 (Tasks 8 and 10).

**Two names in the plan that are wrong.** The file is
`0007_retention_aspect_and_baseline_shape.sql`, not `..._and_checks.sql`. R8
and Task 5 say `period` is typed `ColumnType<string, string, never>`; it ships
as `ColumnType<never, string, never>`, because the read side must not claim a
type the driver does not return.

## 3. Global constraints for every task

- Everything M1 and M2 fixed: Node 22, pnpm, strict TS, `tsconfig.test.json` with `"exclude": []`, build before typecheck, Apache-2.0, English in code, Turkish on the board, no Stellar-shaped id in a tracked file.
- **Every task here writes to the database, so the worktree needs the cluster from Task 1**, exactly as the M2 ledger warned for M3 (610-611): `eval "$(pnpm -s --filter @nonametrust/store db:up)"` then `pnpm test`. A task report that says "cannot verify, no cluster" is a failed task.
- `Date.now` and a no-argument `new Date` do not appear in `packages/store/src` outside `clock.ts:12` and `clock.test.ts`. Task 10 makes that a gate.
- No line in `packages/store/src` names `observedAt`, `validFrom` or `validUntil`, in code or comment (`gates/single-date-reader.test.ts:40`). The store reaches an instant through `datedAt` (`observation.ts:82`).
- **The store computes nothing.** No arithmetic on `g0`, on strength, on counts. It writes what it is handed and refuses what the table refuses.
- The two test habits from the M2 ledger (501-515): assert a refusal's message or constraint name, not only its class; override every `RetentionPolicy` field in at least one test with a number no other field shares (the shipped values are 90, 86 400 000 and 1 000 000; no two collide).
- For every test in a brief, delete the line it claims to protect and confirm the test fails; report any that stay green (M2 ledger 452-482; seven of eleven tasks had one).
- The plan's code blocks are intent, not transcription: keep every guard the current code has unless the task says to remove it (M2 ledger 488-499).

## SQLSTATE allocation

| Code | Class | Raised by |
|---|---|---|
| `NNT06` | `PeriodKeyAltered` | the `namespace_key` guard |
| `NNT07` | `TagAltered` | the `tag` guard |

Raised in TypeScript, no SQLSTATE: `PayloadExpired`, `SourceRateExceeded`, `TagRefreshStale`.

## File structure

| Path | Responsibility |
|---|---|
| `packages/store/migrations/0007_retention_aspect_and_checks.sql` | one file, grown by Tasks 1, 2, 5, 6, 9 in named sections |
| `packages/store/src/retention.ts` (+ test) | `RetentionPolicy`, `RETENTION_V0`, `periodOf`, `periodCloses`, `expiresAt`, `assertRetentionPolicy` |
| `packages/store/src/crypto.ts` | `wrapUnder`/`unwrapUnder` (the ring's layout under a data key), eight-part `payloadAad`, `permanentAad` |
| `packages/store/src/repositories/namespace.ts` | `periodKey`, `openPeriodKey`, `expirePeriods` |
| `packages/store/src/repositories/observation.ts` | producer, period, AAD, `PayloadExpired`, the cap, expired re-delivery |
| `packages/store/src/repositories/tag.ts` | aspect, `retiredAt`, `open` with `taggedAt`, `findLive`, `refresh(TagRefresh)` |
| `packages/store/src/repositories/permanent-record.ts` | payload columns, `promote` re-seals, `read` |
| `packages/store/src/errors.ts`, `db.ts`, `index.ts` | classes, schema type, exports |
| `packages/store/src/clock-gate.test.ts` | the store's lexical clock gate |
| `gates/interface-fields.ts`, `gates/tag-refresh-shape.test.ts` | the baseline-shape extractor shared, applied to `TagRefresh` |
| `packages/store/src/acceptance.test.ts` | M1's four criteria still hold, plus the month boundary |
| `README.md` | gates list, store section |

## Where each gate is gated

| Gate | Task |
|---|---|
| G1 baseline pair-with-count | 1 |
| G2 baseline location is the mean | 1 |
| G3 tag catalogue and surface, re-pinned | 2, 3 |
| G4 one live tag per pair | 2 |
| G5 tag guard, `NNT07` | 2 |
| G6 refresh stores the decision; `TagRefresh` shapes agree | 3 |
| G7 `namespace_key` guard, `NNT06`; month key bound to its pair | 5 |
| G8 period derived from `ingested_at`, keyed to `namespace_key`; producer shaped; observation catalogue pinned | 6 |
| G9 payload bound to producer and `ingested_at` | 4, 6 |
| G10 expiry is unreadability and nothing else; early shred refused; migration refuses data | 6, 7 |
| G11 promotion outlives its month; refused after it | 9 |
| G12 producer cap exact under concurrency; expired re-delivery is not a revival; store clock gate | 8, 10 |
| All of them on one database across a month boundary | 11 |

---

## 3b. The mutation step is not optional, and was skipped once

Tasks 1 and 2 were committed without it and review found four surviving
mutants: the exact equality rewritten as a tolerance, the `tag_id` line
removed from the guard, `tag_aspect_nonempty` deleted, and all six guard
messages replaced with `'generic'` — each passed the whole suite. Every one
was a test asserting a class or a code where it should have asserted the rule.

So for every task from here: after green, delete or weaken each rule the task
added, one at a time, run the suite, and record which test went red. A rule
whose removal leaves the suite green is not held, whatever the migration
comment says about it.

## 4. Tasks

Eleven, a fresh implementer each, a review after each, a whole-branch review at the end. Each ends at a gate a reviewer can reject.

### Task 1: The two baseline checks `0006` left to M2, and the fixture that violates them

**Does:** Opens `0007` with a header saying it is grown across tasks and why (R6), then `alter table baseline add constraint baseline_pair_with_count check ((n = 0) = (median_est is null) and (median_est is null) = (mad_est is null))` and `baseline_location_is_mean check (median_est is null or median_est = mean)`. Rewrites `aBaseline` in `baseline-trigger-volatility-window.test.ts:60-68` so `medianEst` equals `mean` (the number the fixture already uses for `mean`, 512.5, since the suite says numbers are chosen distinct from defaults, :18-23); turns :93-103 into a refusal test for the positive-count-null-pair row and a separate passing test for the zero-count-null-pair upsert; fixes :152 (`medianEst: -3`). Adds raw-writer refusals for each of the four disallowed shapes, asserting the constraint name (`{ code: "23514", constraint: "baseline_pair_with_count" }`), the way :144-148 does.

**Why the SQL equality is safe:** `float8 = float8` in Postgres is exact bitwise-value comparison with `-0 = 0` true, which matches JS `!==` on the same operands (`baseline.ts:129-135`); NaN never reaches the comparison because `0006:29-34` refuses it first.

**Files:** `0007` (section 1), the volatility-window test.
**Acceptance:** a raw insert with `n = 2, median_est null` and one with `n = 0, median_est = 1` and one with `median_est = 200, mean = 100` are each refused by name; the repository round trip still passes with the fixed fixture; `pnpm test` green.
**Cost if wrong:** M3's read path throws `RangeError` from `assertBaseline` on a row the store wrote (M2 ledger 683-689), which is a refusal on the pipeline rather than on an observation.

### Task 2: `tag.aspect`, `tag.retired_at`, one live tag per pair, and the tag guard

**Does:** `0007` section 2: `add column aspect text not null check (length(aspect) > 0)`, `add column retired_at timestamptz`, `create unique index tag_one_live_per_pair on tag (namespace_id, channel, aspect) where retired_at is null`, and `tag_guard()` on `before update or delete`: no DELETE (retirement is a column, and the M1 surface gate already refuses deletion, `tag.test.ts:115-121`); `tag_id`, `namespace_id`, `observation_id`, `channel`, `aspect` fixed; `new.tagged_at >= old.tagged_at` (the forward-only rule `refreshTag` computes at `tagging/src/tag.ts:165`, held from any writer); `new.refresh_count in (old.refresh_count, old.refresh_count + 1)` (a suppress does not move it, a refresh moves it by one); `saturated` never returns to `open` (`refreshTag` :168-175 never does); `retired_at` once set does not move or clear. All under `NNT07`, mapped to `TagAltered`. `StoredTag` and `OpenTag` gain `aspect`; `StoredTag` gains `retiredAt: Date | null`; `COLUMNS` (:30-33) and `toStored` (:175-187) follow; `db.ts:35-45` follows. `listLive` adds `where retired_at is null`. `open` and the two catalogue pins updated: the column list at `tag.test.ts:103-106` becomes the eleven columns, with the decision written in the comment; `tag.test.ts:338-342` opens under distinct aspects.

**Files:** `0007` (section 2), `db.ts`, `errors.ts` (+ test rows), `repositories/tag.ts`, `tag.test.ts`, `acceptance.test.ts` (opens now pass `aspect: "transition"`, from `reading.ts:67`).
**Acceptance:** G3, G4, G5. Planted: a second `open` on a live pair is `ConstraintViolation` 23505 naming `tag_one_live_per_pair`; each raw `UPDATE` in the guard's list is `TagAltered` with the message naming which rule; a raw `DELETE` likewise; an `UPDATE` moving `tagged_at` forward by one refresh passes.
**Cost if wrong:** a deviation on one asset refreshes a tag opened by another (M2 ledger 675-682); or a raw writer moves a tag backward and the decay curve at `strength.ts:38` credits it with a future it did not have.

### Task 3: `open` and `refresh` store what M2's decision returns, and the root gate that holds the two `TagRefresh` shapes equal

**Does:** `OpenTag` gains `taggedAt: Date` (F2) and `open` writes it instead of `this.clock.now()`; `tag.test.ts:191-194` inverts to "stamps taggedAt from the decision, which for an event is earlier than the clock". New `export interface TagRefresh { g0: number; taggedAt: Date; refreshCount: number; saturationState: "open" | "saturated" }` in `repositories/tag.ts`, spelled identically to `tagging/src/tag.ts:36-41`. `refresh(tagId: string, next: TagRefresh): Promise<void>`: `requireFinite` on `g0` as today (:142), `requireInstant`, safe-integer count, then one `UPDATE ... set g0, tagged_at, refresh_count, saturation_state where tag_id = ? and refresh_count = ? - 1`; zero rows: a follow-up `select` distinguishes `TagNotFound` from `TagRefreshStale`. `findLive(namespaceId, channel, aspect): Promise<StoredTag | null>`. Surface pin at `tag.test.ts:116-118` becomes `["constructor","findLive","get","listLive","open","refresh","suppress"]`, still no deletion and no `retire` (M4's). `acceptance.test.ts:294-303` hands a refresh built the way M2 returns it (`g0: 0.4, taggedAt` one minute later, `refreshCount: 1, saturationState: "open"`) and asserts the stored `g0` is `0.4`, which under M1 semantics would have stayed `0.6`. New root gate `gates/tag-refresh-shape.test.ts` reusing the extractor from `gates/baseline-shape.test.ts:50-65` moved into `gates/interface-fields.ts` parameterised on the interface name, with the same self-checks (no block, two blocks, commented-out field) and the same "cannot pass by comparing nothing" clause.

**Files:** `repositories/tag.ts`, `tag.test.ts`, `acceptance.test.ts`, `errors.ts` (`TagRefreshStale`), `gates/interface-fields.ts`, `gates/baseline-shape.test.ts` (imports the shared extractor; its three tests unchanged), `gates/tag-refresh-shape.test.ts`, `README.md` gates list.
**Acceptance:** G6. Planted: a refresh handing `g0` lower than stored writes the lower value (the M1 `greatest` mutant fails); a refresh with `taggedAt` behind the stored instant is `TagAltered` from the guard; forty concurrent refreshes from one live row yield exactly one success, thirty-nine `TagRefreshStale`, `refresh_count = 1`; a field added to either `TagRefresh` fails the root gate with the field named; the baseline gate still fires on a planted field after the refactor (re-run Task 10's M2 planting on it).
**Cost if wrong:** the store silently substitutes M1's arithmetic for M2's, and every number the M2 acceptance corpus pinned is false in production.

### Task 4: `RetentionPolicy`, the period arithmetic, and the cryptography for a key under a key

**Does (no database):** `retention.ts`: the interface and `RETENTION_V0` with the four inputs of section 5, `assertRetentionPolicy` (blank version refused, `graceDays` a non-negative safe integer, window positive, cap a positive safe integer), `periodOf(ingestedAt: Date): string` returning `YYYY-MM-01` in UTC, `periodCloses(period): Date` (`Date.UTC(y, m + 1, 1)`, so December rolls), `expiresAt(period, policy)`. Tests override each field with a distinct number and pin the December rollover, the last millisecond of a month, and a leap February. `crypto.ts`: lift the body of `ring.wrap`/`unwrap` (:213-237) into module functions `wrapUnder(key, plaintextKey, aad)` / `unwrapUnder(key, wrapped, aad)` with the same versioned layout (:24-25, 181-186) so `namespace_key_present`'s 29 stays one number (`0001:39-44`, pinned at `namespace.test.ts:130-142`); the ring calls them with `master`. `PayloadBinding` gains `producer: string` and `ingestedAt: Date`; `payloadAad` renders eight parts in the order `[namespaceId, idempotencyKey, evidenceKind, channel, kind, producer, ingestedAt ISO, datedAt-or-empty]`, keeping the instant last so the null-rendering argument at :45-50 stays true. New `permanentAad({ recordId, observationId, namespaceId, originalDatedAt, promotedAt })` whose first part is the literal `permanent`, which no uuid can equal, so the two domains cannot collide. `crypto.test.ts:157-172` extends its per-column rewrite loop to the two new parts; :219-229 re-partition test extends.

**Acceptance:** every existing crypto test passes; a payload sealed under the seven-part layout fails to open under the eight-part one (planted by hand in a test, proving the layout moved); `wrapUnder` under a data key round-trips and refuses a swapped AAD by class; `assertRetentionPolicy` refuses each bad field by message.
**Cost if wrong:** a month key that unwraps under any namespace's key (F-M1 ledger 69-77 in another costume), or a period arithmetic off by one at year end that files January under December's key.

### Task 5: The `namespace_key` table, its guard, and `periodKey`

**Does:** `0007` section 3: `create table namespace_key (namespace_id uuid not null references namespace, period date not null, key_wrapped bytea, expires_at timestamptz not null, shredded_at timestamptz, created_at timestamptz not null, primary key (namespace_id, period), constraint namespace_key_shred_consistent check ((key_wrapped is null) = (shredded_at is not null)), constraint namespace_key_present check (key_wrapped is null or octet_length(key_wrapped) > 29), constraint namespace_key_expires_after_period check (expires_at >= (period + interval '1 month')), constraint namespace_key_period_is_month check (period = date_trunc('month', period::timestamp)::date), constraint namespace_key_shred_not_early check (shredded_at is null or shredded_at >= expires_at))` and `namespace_key_guard()` mirroring `0001:76-104`: no DELETE; `namespace_id`, `period`, `expires_at`, `created_at` fixed; a shred is one-way; `NNT06`. `NamespaceRepository.periodKey(namespaceId, period): Promise<void>`: insert-on-conflict-do-nothing (the `ensure` shape, `namespace.ts:32-59`, for the same reason: never re-mint under a shredded row), wrapping a fresh 32-byte key with `wrapUnder(dataKey, key, aad = namespaceId + "\0" + period)`, where `dataKey` comes from `this.dataKey(namespaceId)` so a shredded namespace refuses before any insert. `openPeriodKey(namespaceId, period): Promise<Buffer>`: `dataKey` first (so `NamespaceShredded` wins), then the row: missing → `PayloadExpired`? No: missing is a caller defect, `PeriodKeyNotFound`-shaped, but the only reader is `read` on a row whose FK guarantees existence, so a missing row is `Error` as at `namespace.ts:57`; `key_wrapped null` → `PayloadExpired` with the period and `shredded_at` in the message. `period` typed `ColumnType<string, string, never>` in `db.ts`, selected as `period::text` everywhere (R8), with a test that sets `process.env.TZ = "Etc/GMT-3"` before importing the driver and round-trips a September key. `shred` untouched: still the one UPDATE at `namespace.ts:113-125`, and a test proves that after it every period's `openPeriodKey` is `NamespaceShredded` while the `namespace_key` rows are unchanged (their `xmin`, the `tag.test.ts:72-76` trick).

**Acceptance:** G7. Planted: a live month key copied into another namespace's row for the same period, and into another period's row of the same namespace, each refuses with `CiphertextRejected` (the `namespace.test.ts:184-198` pattern); each guard rule refused by `PeriodKeyAltered` with the rule named; `expires_at` earlier than the period's close is 23514 by name; `shredded_at` before `expires_at` is 23514 by name; the TZ round trip.
**Cost if wrong:** a month un-expired by a row copy (the shred-evasion the M1 ledger fixed one level up), or the wrong month key looked up on a machine three hours east of UTC.

### Task 6: `observation.producer`, `observation.period`, the eight-part binding, and reading under the month key

**Does:** `0007` section 4 begins with the preamble (R6): `do $$ begin if exists (select 1 from observation) then raise exception 'migration 0007 re-keys the payload layout and cannot run over stored observations; a re-encryption is a separate migration'; end if; end $$;` — placed at the top of the file in Task 1's header, activated here. Then `add column producer text not null check (producer ~ '^[a-z0-9]+(-[a-z0-9]+)*$')` (the schema's regex, `source.ts:24`, restated because a check that cites a regex the schema owns must say so), `add column period date not null`, `constraint observation_period_from_ingested_at check (period = date_trunc('month', timezone('UTC', ingested_at))::date)` — both functions verified `provolatile = 'i'` on the repository's 17.7 cluster (`timezone(text, timestamptz)` and `date_trunc(text, timestamp)`; `to_char` and the two-argument `date_trunc(text, timestamptz)` are stable and cannot be used), `constraint observation_period_key foreign key (namespace_id, period) references namespace_key (namespace_id, period)`, and `create index observation_by_producer_ingested on observation (producer, ingested_at desc)` (F12). `append`: after `ensure`, `periodKey(ns, periodOf(ingestedAt))`, then seal under `openPeriodKey` with the eight-part AAD, insert `producer` and `period`. `read`: select the two new columns (as text for `period`), `openPeriodKey` (which calls `dataKey` first), open with the eight parts. `observation.test.ts:297-321` adds `producer = 'tampered'` and `ingested_at = ingested_at + interval '1 hour'` to its move list; a move of `ingested_at` across a month boundary is refused by the check before the AAD ever sees it, and the test says which layer refused. A catalogue pin for `observation` in the `tag.test.ts:98-107` idiom, since none exists (F14).

**Acceptance:** G8, G9, half of G10. Planted: raw insert with `period` one month off → 23514 `observation_period_from_ingested_at`; with a `period` no `namespace_key` row has → 23503 `observation_period_key`; each AAD move → `CiphertextRejected`; the round-trip suite and the acceptance suite green unchanged in meaning; the preamble refusal proven by applying `0001`-`0006`, inserting one raw observation row, and asserting `migrate` throws with nothing recorded for `0007` (`migrate.test.ts:142-147` idiom).
**Cost if wrong:** a payload readable under a key its row does not name, or the shape of ingest changing under a deployed table with no refusal.

### Task 7: `expirePeriods`, and the gate that expiry is unreadability and nothing else

**Does:** `NamespaceRepository.expirePeriods(): Promise<{ shredded: { namespaceId: string; period: string }[] }>`: one statement, `update namespace_key set key_wrapped = null, shredded_at = ${now} where key_wrapped is not null and expires_at <= ${now} returning namespace_id, period::text`, `now` from the injected clock. Returns what it shredded so M4's nightly job can audit it; the store writes no audit row (it never has; `acceptance.test.ts:174-182` shows the caller does). The test: append in September under a fixed clock, advance to `expiresAt` minus one millisecond and expire → nothing; advance one millisecond and expire → that period; then: the row exists, `get` is `PayloadExpired`, a September observation in another namespace with the same period is also expired while an October one is readable, every foreign key and the audit chain verify, `namespaces.shred` on the namespace still works afterwards and is still one statement, and `NamespaceShredded` takes precedence over `PayloadExpired` on a namespace that is both. Override `graceDays` to `7` in this test.

**Acceptance:** G10. Planted: a raw `update namespace_key set key_wrapped = null, shredded_at = <before expires_at>` is `PeriodKeyAltered`; deleting the `expires_at <= now` clause makes the minus-one-millisecond assertion fail.
**Cost if wrong:** either retention never fires and the design is a sentence, or it fires early and evidence inside its window is unreadable to the brief.

### Task 8: `append` under the cap, and an expired re-delivery

**Does:** `AppendResult` becomes `{ created: true; observation } | { created: false; expired: false; observation } | { created: false; expired: true; observationId: string; ingestedAt: Date }`. The pre-read at `observation.ts:64` becomes a skeleton read (`observation_id, namespace_id, period, ingested_at` by key, no decrypt); if found, `openPeriodKey` decides between the second and third shapes; the third never re-seals and never touches the row (assert `xmin` unchanged). The duplicate-retry path at :122-125 goes through the same skeleton read. The cap: `append` wraps its insert in a transaction that takes `pg_advisory_xact_lock(hashtext(producer))` (the `0005:84` and `chain.ts:275` precedent, transaction-scoped so nothing leaks, M1 ledger 189-194), counts `where producer = ? and ingested_at > now - windowMs`, and throws `SourceRateExceeded` with the producer, the window and the count if `count >= max`. The pre-read stays outside the lock, so a re-delivery never consumes the cap. `ObservationRepository`'s constructor takes the `RetentionPolicy`.

**Acceptance:** G12 first half. With the cap overridden to 3 and the window to 1 000 ms: three appends pass, the fourth is `SourceRateExceeded` and writes nothing, a re-delivery of the first still returns `created: false` under the full cap, another producer is unaffected, advancing the clock past the window admits a fourth; twenty concurrent fresh appends under a cap of 5 store exactly five (delete the lock and this fails); after expiry (Task 7's clock) the same wire observation returns the third shape with the original `ingestedAt`, and the row's `xmin` and ciphertext are unchanged.
**Cost if wrong:** a producer resurrects any payload by re-delivering it, so retention is a fiction; or the cap admits `pool width` extra rows per window, which is not a cap.

### Task 9: The permanent copy

**Does:** `0007` section 5: `alter table permanent_record add column payload_nonce bytea not null, payload_tag bytea not null, payload_ciphertext bytea not null` (append-only stays; `0004:102-112`). `PermanentRecordRepository` takes `ObservationRepository` and `NamespaceRepository`; `promote` keeps its three named refusals (`permanent-record.ts:98-107`), then `observations.get(id)` inside the same transaction (which raises `NamespaceShredded` or `PayloadExpired` before anything is written), re-seals `JSON.stringify(observation)` under `namespaces.dataKey(namespaceId)` with `permanentAad`, and includes the three columns in the insert-from-select (:114-132, the `dated_at` copy stays inside the database). `read(recordId): Promise<Observation>` opens under the namespace key, rebuilding the AAD from the row's own columns, and re-parses through `observationSchema` as `read` does at `observation.ts:177`. `get` stays metadata-only so a shredded namespace's record is still listable. `acceptance.test.ts:234` and the promote steps follow the new constructor. The `permanent_record` column catalogue pinned.

**Acceptance:** G11. Promote in September; expire September (Task 7's clock); `records.read` returns the day-twelve observation byte for byte while `observations.get` on its source is `PayloadExpired`; promoting after expiry is `PayloadExpired` and writes no row; promoting into a shredded namespace stays `NamespaceShredded` (existing test :280-292); each `permanentAad` column moved with the triggers off refuses the read (`observation.test.ts:297` pattern); a namespace shred makes `read` `NamespaceShredded`, which is the whitepaper's "a whole counterparty space is erased by destroying that key".
**Cost if wrong:** a captured trace does not outlive its month, which is the one sentence the card exists for; or the permanent copy is readable under a payload moved from another record.

### Task 10: The store's clock gate, the error map, the exports, the README, and `0007` read as one document

**Does:** `packages/store/src/clock-gate.test.ts` with the tagging regex (`boundary.test.ts:41`) over `packages/store/src`, exempting `clock.ts` alone, self-checking on the planted forms the tagging gate lists (:151-166). `errors.test.ts:25-36` gains `NNT06`/`NNT07`; :66-70 keeps its unknown-code cases. `index.ts` exports `retention.ts`. `README.md`: the gates list (116-146) gains the tag-refresh gate and the store clock gate; the store section names retention in one paragraph. The reviewer of this task reads `0007` top to bottom as a single migration: every section's comment says what it holds, what it leaves open, and which task added it, in the voice of `0001`-`0006`.

**Acceptance:** planted `const t = new Date();` in a store module fails the gate with the line; `pnpm build && pnpm typecheck && pnpm test` green from a fresh checkout with the cluster up.
**Cost if wrong:** `expirePeriods` silently reading the wall clock on the day someone refactors it; a migration that reads as five patches.

### Task 11: Acceptance: M1's four criteria still hold, and a captured trace outlives its month

**Does:** Extend `acceptance.test.ts` with a fifth block after the seals: advance the one clock past September's expiry (grace overridden to a small number in this suite's policy, as Task 7 does), `expirePeriods` returns the provider's and the wallet's September periods, the day-twelve observations are `PayloadExpired`, both permanent records still `read` back dated day twelve, the tag row and its live listing are unchanged, the chain verifies and every seal re-verifies (`sealDay` is idempotent, `chain.ts:411-420`), and a re-delivery of the day-twelve fixture returns the expired shape. The journal gains no kinds, because the store writes no audit rows; the test says that the nightly job's `periods.expired` entry is M4's. The M5 card owns the scenario crossing a *calendar* month with a real ninety days; this task proves the mechanism on the M1 scenario, which the card explicitly leaves to M5 for the full horizon.

**Acceptance:** the whole file green; the eleven journal kinds at `acceptance.test.ts:392-401` unchanged.
**Cost if wrong:** the criteria hold in isolation and not in composition, which is the M1 lesson (M2 spec §14).

---

## 5. The twelve gates

Each named, what it refuses, how it is proven to fail on a planted violation, whether it exists.

1. **`baseline_pair_with_count`** (new, DB check). Refuses `n > 0` with a null pair, `n = 0` with a location, and one estimate without the other. Planted: three raw inserts, each 23514 by name.
2. **`baseline_location_is_mean`** (new, DB check). Refuses `median_est <> mean`. Planted: raw insert `100` against `200`, 23514 by name; the arithmetic's own message for the same row is `baseline.ts:137-139`, and the store test cites it.
3. **Tag catalogue and surface pins** (exist, `tag.test.ts:98-121`, re-pinned). Refuse any column or method not argued in. Planted: the M2-style probe, a column added in SQL alone; a `retire` method added early.
4. **`tag_one_live_per_pair`** (new, partial unique index). Refuses a second live tag on `(namespace, channel, aspect)`. Planted: two `open`s, 23505 by name; a retired first tag admits a second.
5. **`tag_guard`, `NNT07`** (new, trigger). Refuses DELETE, identity moves, a backward `tagged_at`, a count moved by other than 0 or 1, saturated-to-open, and un-retirement. Planted: one raw statement per rule, `TagAltered` with the rule in the message.
6. **Refresh stores the decision, and the two `TagRefresh` declarations agree** (new; store test plus root gate). Refuses the M1 arithmetic and any drift between `tagging/src/tag.ts:36-41` and the store's copy. Planted: the `greatest` mutant; a field added on one side.
7. **`namespace_key_guard`, `NNT06`, and the pair-bound month key** (new). Refuses DELETE, identity and `expires_at` moves, un-shred, early shred (`shredded_at < expires_at`), and a wrapped key moved between rows. Planted: per rule; the row copy is `CiphertextRejected`.
8. **`observation_period_from_ingested_at`, `observation_period_key`, the producer shape, the observation catalogue** (new). Refuses a period that is not `ingested_at`'s UTC month, a period with no key row, a producer the schema would refuse. Planted: each by name.
9. **Payload bound to `producer` and `ingested_at`** (extends `observation.test.ts:297` and `crypto.test.ts:157`). Refuses a read after either column moves. Planted: with the append-only trigger off, in a rolled-back transaction.
10. **Expiry is unreadability and nothing else, never early, never over data** (new). Refuses a read of an expired month while rows, keys, chain and seals stand; refuses `expirePeriods` reaching a live month; `0007` refuses a non-empty table. Planted: minus-one-millisecond; raw early shred; a raw row before `migrate`.
11. **Promotion outlives its month and is refused after it** (new). Planted: expire then read; promote after expiry; each `permanentAad` column moved.
12. **The producer cap is exact and an expired re-delivery is not a revival; no wall clock in the store** (new). Planted: the lock removed under twenty concurrent appends; a re-delivery after expiry with `xmin` compared; `new Date()` in a store module.

Existing gates untouched and still required green: no Stellar address, single date reader, baseline shape, no test file in `dist`.

---

## 6. The four uncalibrated policy inputs

The card does not enumerate them. These are the four the code needs and cannot derive; all live in `RETENTION_V0` (`packages/store/src/retention.ts`), each with its source written beside it, and every store test that reads one overrides it with a number no other field shares.

| Input | What an invented value would be | How it is declared instead |
|---|---|---|
| `graceDays` | "sixty days" or "a quarter", from taste | `90`, the whitepaper's own sentence (en.md line 141: "ninety days after a calendar month closes"). A design number, not a measurement: declared, sourced, uncalibrated. |
| `period` | a rolling 30 days, a week, a day | `"calendar-month-utc"`, the whitepaper's "(counterparty space, calendar month)". The UTC half is ours and says so; the field is a literal type so a change is a policy version, not an edit. |
| `producerWindowMs` | "per hour" | `86 400 000`, one sliding UTC day on `ingested_at`, chosen so the unit matches the one measured delivery (below). |
| `producerMaxObservations` | "10 000" | `10 000 000`, by a written rule: the largest delivery measured to date must be ingestible in one window with a margin of an order of magnitude. The A1 run report (`origin/feature/indexer:docs/indexer-run-2026-09.md` §3) delivered 646 890 observations for 100 accounts over 31 days in one file, the busiest account 187 313. Ten times that is 6 468 900, and the smallest power of ten at or above it is ten million. The test computes that from the rule rather than comparing the constant to a band. Re-derived, not retuned, when the shadow evaluation measures a larger fleet. |

**The cap was 1 000 000 for three commits and that was a fitted number.** The
rule above was written first; the constant gave a margin of 1.55x, not ten,
and the discrepancy survived two review rounds -- the second of which kept the
number and rewrote the sentence to admit 1.55x, then moved the test to
`margin > 1.5 && margin < 2`, a band 1 200 000 also satisfies. Between a rule
that was reasoned about and a number that drifted, the number gives way. The
direction also matters: R3 says this cap is not a defence against an attacker,
since the producer name is free text until signatures are enforced, so its
real job is catching our own indexer in a loop. Too low refuses a legitimate
delivery, which is the denial of service on ourselves this section exists to
prevent, and 1.55x would have refused a fleet only 60% larger than the one
measured; too high only delays noticing a runaway, and ten million a day per
producer is still a bound.

Stated plainly: "10 000 per hour" would refuse the A1 backfill sixty times over and turn the indexer's own delivery into a denial of service, which is why the cap's numbers come from the one delivery that exists rather than from a sense of what a rate limit usually is. The bound it gives is real where the retention card wanted one: readable bytes are bounded by the window and the grace, and rows per producer per day are bounded by the cap; the row skeleton still grows without bound, by design.

---

## 7. Open questions for Kerem

None block the plan. Two rulings above rest on the weakest sources and are the ones to veto before their task starts, if at all:

- **R3, the cap's scope** (per producer, on ingest time, sized to the A1 delivery). The alternative, per `(producer, namespace)`, defends a counterparty's competition better and the indexer's delivery worse. Veto before Task 8.
- **R2, `expires_at` fixed at mint.** The alternative, re-deriving expiry from the policy at each `expirePeriods`, lets a shortened grace apply to old months but puts the number in two places. Veto before Task 5.

One outward-facing item is not a question but must not be forgotten: after this card the whitepaper's "per-source rate limit ... designed and scheduled rather than built" (line 145) is false in the built direction; it belongs on the whitepaper card, not here.

---

## 8. Risks: where a plausible implementation is silently wrong

- **A row the arithmetic refuses reaching the database.** Task 1's checks are the gate; the trap is an implementer "fixing" the store fixture by widening the check to `abs(median_est - mean) < epsilon`. The arithmetic's equality is strict (`baseline.ts:129-135`) and the store's must be too; a tolerance admits the row the ledger measured at 106/21 against a bound of 6/21 (M2 ledger 147-163).
- **A payload outliving its key.** Three paths: `append` re-sealing an expired re-delivery (Task 8's `xmin` assertion); `promote` copying ciphertext instead of re-sealing (then the copy dies with the month; Task 9 opens after expiry); an audit body carrying plaintext (F7, M3's; suggested gate for M3: the audit body renderer refuses any key named `payload`). A fourth, subtler: a `permanent_record` re-sealed under the *month* key by a copy-paste of `append`'s call; Task 9's expire-then-read catches it.
- **The wrong month on a machine east of UTC** (R8). A driver `Date` for a `date` column is local midnight. Kerem's machine is UTC+3. Every `period` read is text or the September test under `TZ=Etc/GMT-3` fails.
- **The check constraint that will not compile in a check.** `to_char` and two-argument `date_trunc` on `timestamptz` are stable on 17.7 and Postgres refuses them in a check; the immutable pair is `date_trunc('month', timezone('UTC', ingested_at))::date`, verified against `pg_proc` on the repository's cluster. An implementer who reaches for `to_char` will fall back to a trigger and lose the constraint-name refusal the tests assert.
- **A cap that is not a cap.** Count-then-insert without the per-producer transaction lock admits the pool's width over the cap; the twenty-concurrent test is the only thing that sees it. And a cap counted *including* the re-delivery pre-read charges retries against the producer.
- **`refresh` that quietly merges.** Any `greatest`, any `+ 1` in the SQL, is the M1 semantics back. The store writes the four fields as handed and refuses a stale count; the guard holds the direction of `tagged_at` from raw writers.
- **`open` still stamping from the clock.** F2; the M1 test at `tag.test.ts:191-194` will be edited to keep passing if nobody reads why it changed. Task 3's brief says the reason in the test name.
- **`expires_at` from the clock instead of from the period.** Then a backfill of last year expires ninety days from today. `expiresAt(period, policy)` takes no clock, and a test mints a 2025 period under a 2026 clock and asserts a 2025 expiry.
- **`0007` applied over data.** The preamble refusal is the gate; without it a deployed table would have rows no key can open and no error would say so until the first read.
- **The tag guard refusing the suppress path.** `suppress` updates `suppression_factor` alone (`tag.ts:121-131`); the guard's count rule admits `old.refresh_count` unchanged for that reason. An implementer who writes `= old + 1` breaks suppression and the existing test at `tag.test.ts:222-228` catches it.
- **`listLive(since)` after a moved instant.** `tag.ts:167` filters on `tagged_at`, which now moves on refresh; M4's window query must decide whether it wants the opening instant or the last refresh, and nothing here decides it. Carried, one line, for M4's card.

---

## Notes for the executor

1. Cluster up from Task 1, every task; the M2 constraint does not apply and its absence is not an excuse.
2. `0007` is one file grown in five named sections; Task 10's reviewer reads it whole. Never split it into `0008`.
3. Two board updates during execution, not after: after Task 3 (the refresh and `open` findings, F1 and F2, with the acceptance numbers) and after Task 9 (the retention gate results), and the M3 card's list "carried from M2" gets the F2 line, because M3's engine must pass the decision's `taggedAt` to `open`.
4. The ledger for this card records R1-R8 with their costs, the eleven findings, and whatever the implementers find that this plan did not; M2's ledger found seven hollow plan tests in eleven tasks and this plan expects the same.