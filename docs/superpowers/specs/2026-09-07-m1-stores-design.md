# M1 — Stores: design

**Milestone:** M1, 7-10 September 2026.
**Parent spec:** `docs/superpowers/specs/2026-09-05-mvp-v0-core-engine-design.md`, sections 2 and 4.
**Carried from:** `docs/superpowers/ledgers/2026-09-05-m0-decisions.md`, and the six
notes on the M1 board card.

M0 produced `packages/schema`: the types the indexer imports and nothing else.
M1 produces the place those observations live, the store the tagging arithmetic
will read in M2, and the audit chain every later milestone appends to.

---

## 1. What M1 is, and what it is not

**In scope.**

- `packages/store`, a new workspace package depending only on `@nonametrust/schema`.
- Nine tables with their migrations: `namespace`, `observation`, `baseline`,
  `tag`, `trigger`, `permanent_record`, `volatility`, `hot_window`, `audit_entry`
  (with `audit_day` alongside it, see section 8).
- Envelope encryption of the observation payload, with a per-namespace data key,
  so crypto-shredding is a real operation rather than a column that exists.
- Repositories for each table: enough to write a row and read it back, with the
  invariants enforced.
- Tag strength derived at an arbitrary instant, from stored `g0`, elapsed time
  and channel half-life.
- The audit chain, enforced on insert and verifiable end to end.
- A local test database that belongs to this repository and to no machine.
- One change in `packages/schema`: the wallet-identifier gate of section 10.

**Out of scope, with reasons.**

- *The tagging arithmetic.* Welford, MAD, surprise and `g0` calibration are M2.
  M1 lands the `baseline` table and a repository that writes and reads its
  columns. Storing a number the arithmetic has not yet produced is cheap;
  migrating a table after the arithmetic exists is not.
- *The nightly job.* M1 lands `audit_day` and the function that seals a day.
  Scheduling it is M4.
- *`brief` and relatedness.* M3.
- *Fleet-wide priors and cluster consolidation.* The `trigger.cluster_id` column
  is nullable and unused in M1.
- *Any read path optimised for latency.* Section 6 of the parent spec sets a one
  to two second budget for `brief`. M1 creates the indexes that path will need
  and measures nothing.

---

## 2. The contradiction M1 had to settle

The M1 card carried six notes forward from M0. The third contained a conflict
that had to be resolved before any fixture or gate could be written.

**The conflict.** Task 5 carried forward that fixtures should hold identifiers
that are *shape-valid but not checksum-valid*, so the indexer developer debugs
against realistic data. Task 6 and Task 7 landed a repository-root gate that
rejects anything *shaped* like a StrKey account, `G` followed by 55 base32
characters or `M` followed by 68, **checksum-valid or not**. A shape-valid
fixture identifier is exactly what that gate refuses. Both cannot hold.

**The ruling: the two gates are about different things, and separating them
dissolves the conflict rather than trading one property for the other.**

- The root gate in `gates/no-stellar-address.test.ts` is a **leak gate**. Its
  subject is tracked files, its failure mode is publishing a real person's
  account identifier, and its discriminator is deliberately coarse because a
  coarse gate cannot be argued with. It does not change.
- The wallet-identifier gate is a **correctness gate**. Its subject is a runtime
  value, its failure mode is a muxed address landing in `namespace.id` and one
  counterparty being counted as many. This is the claim the whitepaper makes and
  `namespace.ts` states: *muxed addresses resolve to the base address before they
  reach this type.*

The correctness gate is therefore written as a **negative** check, not a positive
one: for `kind: "wallet"`, `id` must not have the shape of a muxed address. It
does not assert that the identifier is a well-formed Stellar account.

Three consequences follow, and each is an improvement rather than a compromise:

1. Fixtures keep short, obviously synthetic identifiers such as `GOLDADDRESS`.
   Nothing shape-valid ever enters a tracked file, so the leak gate stays coarse
   and the fixture rule stops fighting it.
2. The gate matches the claim exactly. A positive shape check would enforce
   *"a wallet identifier is a Stellar account"*, which is a stronger claim than
   the whitepaper makes and which would need rewriting the first time a second
   chain appears.
3. The test that proves the refinement fires needs a muxed-shaped identifier,
   which the leak gate forbids on disk. It is generated at run time. The leak
   gate's own comment already prescribes this pattern for real-shaped keys.

**What stays ungated, said out loud.** That a wallet `id` is a checksum-valid
Stellar account identifier is *not* checked by the schema. It is the indexer's
rule, and `docs/observation-contract.md` states it as such, in the same voice it
already uses for the `kind` vocabulary. An ungated claim that says it is ungated
is honest; one that does not is the failure this project keeps finding.

---

## 3. Package layout

```
packages/store/
  migrations/          0001_*.sql … applied in filename order
  src/
    index.ts           the public surface
    clock.ts           the Clock interface and a fixed clock for tests
    db.ts              connection, Kysely instance, typed schema
    migrate.ts         the migration runner
    crypto.ts          envelope encryption and the key ring
    errors.ts          named errors mapped from SQLSTATE
    repositories/      one module per table
    audit/             chain append, verify, day seal
```

`packages/store` exports repositories and errors. It does not export SQL, a
Kysely instance, or a connection. A consumer that needs a query the store does
not offer gets a new repository method, not a handle to the database. This is
the boundary that lets M2 and M3 be written against an interface rather than
against Postgres.

**Dependencies.** `kysely`, `pg`. Migrations are plain SQL applied by our own
runner; no migration framework. Reason: the load-bearing parts of this milestone
are SQL-level constructs — an explicit collation, triggers that raise, a
generated chain check — that schema-definition libraries either hide or express
through an escape hatch. In a repository whose stated discipline is that a claim
must be readable as a gate, the data-definition language is the gate and it is
kept in view.

---

## 4. Identity, and byte-exact comparison

This is the load-bearing item of the M1 card's first note.

`namespace` holds a surrogate key and the natural identity beside it:

| Column | Type | Note |
|---|---|---|
| `namespace_id` | `uuid` primary key | referenced by every other table |
| `kind` | `text` | one of wallet, domain, endpoint, merchant |
| `ns_id` | `text COLLATE "C"` | the schema's `namespace.id`, byte for byte |
| `data_key_wrapped` | `bytea` null | section 5; null once shredded |
| `key_shredded_at` | `timestamptz` null | |
| `created_at` | `timestamptz not null` | from the injected clock |

`unique (kind, ns_id)`.

**Why the collation is written out.** Equality under any *deterministic*
collation is already byte equality, so on a database created with a normal
locale this column would behave correctly without the clause. It is written
anyway because the failure it prevents is silent and total: a database created
with a nondeterministic ICU collation would fold two distinct spellings into one
logical namespace, and evidence about two counterparties would be summed into
one. The clause costs one word and removes the dependency on how the cluster was
created. `COLLATE "C"` also fixes ordering, which keeps index scans reproducible
across machines.

**The gate.** A test writes two namespaces whose identifiers differ only in
case, and asserts two rows exist and that each reads back its own. A second
assertion covers a trailing space, since a `char`-typed or trimmed column is the
other way this fails.

**Reinforcement that already exists.** `deriveIdempotencyKey` hashes the
namespace identifier as part of the key, so two spellings already produce two
keys. The store's constraint and the schema's derivation now agree, and the test
above states that agreement rather than assuming it.

**What is *not* on this table.** `muxedId` and `continuity` arrive inside a
namespace reference on every observation, and both are assertions made at a
point in time by a named producer. Storing either as a mutable column on the
identity row would turn provenance into current state and lose the history. They
travel with the observation, inside the encrypted payload, and are read back
with it. If a query over continuity assertions is ever needed, it gets its own
append-only table; it does not get a column here.

---

## 5. Encryption, and what crypto-shredding actually deletes

Envelope encryption, two levels.

- **Master key.** 32 bytes, supplied as base64 in `NNT_MASTER_KEY`. The process
  refuses to start without it. There is no default and no development fallback:
  a fallback key is a key that reaches production.
- **Data key.** 32 random bytes per namespace, generated when the namespace row
  is created, encrypted with AES-256-GCM under the master key, stored in
  `data_key_wrapped`.
- **Payload.** The full validated observation is serialised to JSON and
  encrypted with AES-256-GCM under that namespace's data key.

**Associated data.** The additional authenticated data for the payload is the
namespace identifier and the idempotency key, joined the same way the idempotency
key joins its parts. A ciphertext therefore cannot be moved to another row or
another namespace and still decrypt. Without this, an attacker with write access
to the table could swap two counterparties' evidence without breaking any
signature we hold.

**Crypto-shredding.** Setting `data_key_wrapped` to null and stamping
`key_shredded_at` makes every payload for that namespace permanently
unreadable. This is why the key lives on `namespace` and not on `observation`:
shredding is an `UPDATE`, and `observation` accepts none. The observation rows
survive, so counts, timestamps and the audit chain stay intact and verifiable
while the content is gone. That is the correct shape for a subject-erasure
request against an append-only ledger.

**The gate.** A test writes an observation, shreds the namespace, and asserts
three things: the row still exists, reading it raises `NamespaceShredded` rather
than returning a partial record, and the audit chain still verifies.

**What is deliberately not done in M1.** No key rotation, no master-key
derivation from a KMS, no per-day key. Each is a real requirement for the SCF
tranche-1 shadow evaluation and each is a change to operations, not to the
schema. The wrapped-key column is versioned with a one-byte prefix so that
rotation is a decode branch rather than a migration.

---

## 6. Append-only, and the other invariants the database itself holds

The parent spec lists three invariants. M1 decides where each is enforced, and
the answer is *in the database wherever the database can hold it*, because a
rule that lives only in application code is a rule the next caller can go around.

**No `UPDATE` on `observation`.** A `BEFORE UPDATE OR DELETE` trigger raises an
exception with its own SQLSTATE. Additionally the application role has `UPDATE`
and `DELETE` revoked on the table. The trigger is the readable gate and produces
a named error; the revocation is the second line and covers a superuser session
that disabled triggers. A rewrite rule of the `DO INSTEAD NOTHING` form is
explicitly rejected: it swallows the write silently, which converts a loud bug
into a quiet one.

**Tag strength is never stored.** `tag` holds `g0`, `tagged_at`, `channel`,
`refresh_count`, `saturation_state` and `suppression_factor`. It holds no
strength, score or decayed value. The gate reads the live catalogue after
migration and asserts that no column on `tag` matches a strength-like name. It
reads the catalogue rather than the migration text so that a later `ALTER TABLE`
cannot slip past a grep over the original file. Strength is produced by
`strengthAt(tag, instant)`, a pure function of `g0`, elapsed time, the channel
half-life and the suppression factor.

**Suppression is accelerated decay, not deletion.** `suppression_factor`
multiplies the decay rate. The repository surface offers `suppress()` and offers
no delete-by-identifier for a tag at all. Expiry from the bounded window is a
separate, named operation belonging to the nightly job, so the two can never be
confused at a call site. The gate is a test over the exported repository surface
asserting no general tag deletion is reachable.

**A promotion preserves the original timestamp.** `permanent_record` carries
`original_dated_at` and a foreign key to the observation it was promoted from. A
trigger on insert and update asserts that `original_dated_at` equals the source
observation's stored `dated_at`. The claim is held by the database, not by the
one test that happens to check it.

---

## 7. The observation round trip, and why the store never names a date field

`observation` stores the complete validated observation as an encrypted blob,
with a small set of derived columns beside it for querying:

| Column | Source |
|---|---|
| `observation_id` | uuid, assigned on ingest |
| `idempotency_key` | `text COLLATE "C"`, unique |
| `namespace_id` | foreign key |
| `channel`, `kind`, `evidence_kind` | copied from the observation |
| `dated_at` | `timestamptz` null, **from `datedAt(o)`** |
| `ingested_at` | from the injected clock |
| `payload_ciphertext`, `payload_nonce`, `payload_tag` | section 5 |

Reading an observation decrypts the blob and re-parses it through
`observationSchema`. The round trip therefore proves the stored form and the
schema agree, rather than proving that a hand-written mapper is its own inverse.

**The consequence for the single-reader gate.** `dated_at` comes from
`datedAt(o)`, which returns null for a state. The store consequently never names
`observedAt`, `validFrom` or `validUntil` anywhere in its source. That matters,
because the M1 card's second note observed that the single-reader gate scans
`packages/schema/src` only, and that the code most likely to violate the claim —
window and decay arithmetic — is heading into other packages where nothing
enforces it.

M1 closes that note by **moving the gate to the repository root**, next to the
address gate, and scanning every `packages/*/src` tree. Exemptions become paths
relative to the repository root, so `schema/src/timing.ts` is exempt and a later
`store/src/timing.ts` is not. `packages/store` needs no exemption at all: a new
package enters under the widened gate without a hole cut in it.

**A state's interval is not queryable in M1.** No derived column carries
`validFrom` or `validUntil`. When a query needs one, the field is read through a
second named reader added to `timing.ts` beside `datedAt`, and that reader is
exempt. It is not read directly in the store.

---

## 8. The audit chain

`audit_entry` is append-only under the same trigger treatment as `observation`.

| Column | Note |
|---|---|
| `seq` | `bigint` generated always as identity, primary key |
| `occurred_at` | from the injected clock |
| `policy_version` | the mechanism version this decision ran under |
| `kind` | what was decided |
| `body` | `jsonb`, the decision's own fields |
| `canonical` | the exact string that was hashed |
| `prev_sha256` | `bytea`, the previous entry's hash |
| `entry_sha256` | `bytea` |

**Enforced on insert, by trigger:**

1. `prev_sha256` equals the previous row's `entry_sha256`, or a fixed genesis
   constant for the first row.
2. `entry_sha256 = sha256(prev_sha256 || convert_to(canonical, 'UTF8'))`,
   computed with the built-in `sha256`.

**Enforced by the verifier, not by the database, and this boundary is stated
deliberately:** that `canonical` is a faithful rendering of `seq`, `occurred_at`,
`policy_version`, `kind` and `body`. Re-deriving a canonical JSON form inside
`plpgsql` would make the chain's meaning depend on a Postgres version's
serialisation, and a chain that must verify in a year cannot rest on that.
`verifyChain()` walks the table, re-derives `canonical` from each row's own
fields in TypeScript, recomputes both hashes and checks the linkage. The
database holds linkage and hash integrity; the verifier holds fidelity. Neither
half is claimed to be the other.

`audit_day` seals a day: `day`, `terminal_seq`, `terminal_sha256`, `hmac`. The
HMAC is over the terminal hash under a key derived from the master key, so a
rewritten history cannot be re-chained without it. M1 lands the table and
`sealDay()`; the nightly job that calls it is M4.

---

## 9. The four tables M1 lands without their arithmetic

These exist so that M2 and M3 add code and not migrations. Each gets a
repository that writes a row and reads it back, and a test that does exactly
that. None gets a calculation.

**`baseline`**, keyed on `(namespace_id, channel, aspect)`. Welford state as
`count`, `mean`, `m2`; robust state as `median_est`, `mad_est`; the two
timescales as `fast_mean`, `fast_m2`, `slow_mean`, `slow_m2`. Mutable by design:
a baseline is current state, not evidence. `updated_at` from the injected clock.

**`trigger`**, one row per candidate. `trigger_id`, `namespace_id`,
`observation_id`, `status` (candidate, verified, harm_confirmed), `tier` for a
harm-confirmed row, `cluster_id` nullable and unused in M1, `surprise`,
`created_at`. *`trigger` is a non-reserved keyword in Postgres and works
unquoted as a table name; this was verified on 17.7 rather than assumed, because
a quoted table name propagating through every query is an unpleasant thing to
discover on the second day.*

**`volatility`**, one row per namespace. `q_hat`, `updated_at`. Mean-reverting
in M2; a stored number here.

**`hot_window`**, one row per opened window. `namespace_id`, `trigger_id`,
`opens_at`, `closes_at`, `scale`. The window is scaled by volatility in M3;
M1 stores the bounds it is given.

`tier` and `status` are `text` with a check constraint rather than enumerated
types. A Postgres enum cannot have a value removed without rewriting the type,
and the tiered failure policy is M3's to settle. The check constraint is a
one-line migration to change; the enum is not.

---

## 10. The change in `packages/schema`, and its effect on the indexer

`namespaceRefSchema` gains a refinement: when `kind` is `"wallet"`, `id` must not
match the muxed-address shape, `M` followed by 68 base32 characters, in either
case. The error message names the resolution rule so a mapper author reads what
to do rather than what went wrong.

**This is a tightening.** An input that validates today is refused tomorrow.
Three things follow:

- `@nonametrust/schema` goes to `0.2.0`, and `OBSERVATION_SCHEMA_VERSION` stays
  `0.1.0`, because the wire form did not change. The constraint narrowed; the
  shape did not.
- `docs/observation-contract.md` moves the muxed rule from the list of rules the
  developer follows to the list the schema enforces, and the wallet-identifier
  validity rule stays in the first list, explicitly.
- The indexer developer is told before the version lands, not after. His first
  delivery is 16 September. The change is in his favour, since a muxed address
  now fails at validation instead of silently splitting one counterparty into
  many, but it is a behaviour change on a package he has already integrated.

---

## 11. Migrations, and the test database

**Migrations.** Plain SQL files in `packages/store/migrations`, named
`NNNN_short_name.sql`, applied in filename order. The runner takes a Postgres
advisory lock, applies each unapplied file in its own transaction, and records
it in `schema_migration` with its sha256. On a second run it applies nothing. If
a recorded file's hash no longer matches its content, it refuses to run: an
edited migration is a different migration, and discovering that in production is
worse than a failed start.

**The test database is this repository's, not this machine's.** A Postgres is
already listening on the default port of the founder's machine, under a password
and not under the Homebrew service. Binding the suite to it would make the tests
depend on one machine's ambient configuration and produce a silent difference
between local and continuous integration.

`scripts/dev-db.sh` instead runs `initdb` into a gitignored directory inside the
repository, on port 55432, with trust authentication and `listen_addresses` set
to `127.0.0.1`. It collides with nothing and needs no password. The suite reads
`NNT_TEST_DATABASE_URL`.

**It listens on TCP rather than on a Unix socket, and that is not a
preference.** A Unix socket path may not exceed 103 bytes, and a socket
directory inside a checkout under a long path exceeds it and fails at connect
time with an error that reads like a permissions problem. This was hit while
validating this design. TCP on the loopback interface has no such limit and is
also what the continuous-integration service container offers, so both
environments use one transport.

The cluster is created with locale `C`, so the database's own default collation
is deterministic. The explicit `COLLATE "C"` of section 4 stays regardless: the
column must not depend on how the cluster was initialised.

**If that variable is unset, the store tests fail. They do not skip.** A store
suite that skips itself reports green while enforcing nothing, which is the
precise failure this project has now found in three separate places. Continuous
integration gets a Postgres service container and sets the same variable, so the
two environments differ in how the server is started and in nothing else.

Isolation between test files is a fresh schema per file, dropped afterwards.
`TRUNCATE` is not used to reset `observation`, because it bypasses row triggers
and would let a test pass through a path production cannot use.

---

## 12. Errors

Every enforced invariant raises a distinct SQLSTATE, and `errors.ts` maps each to
a named error class: `AppendOnlyViolation`, `ChainBroken`, `TimestampAltered`,
`NamespaceShredded`, `DuplicateObservation`, `MigrationDrift`. Tests assert on
the class, never on the message text, so a reworded message is not a red suite
and a swallowed violation is not a green one.

`DuplicateObservation` is the one that is not a defect: writing the same source
event twice is the indexer's normal retry path. The repository's `append()`
returns the existing observation rather than raising, and reports that it did.
The distinction between "already stored" and "conflicting" is drawn on the
idempotency key alone, which is what the key exists for.

---

## 13. Acceptance criteria

The four from the plan, each with the form its test takes.

1. **An observation round-trips.** Write a validated observation, read it back,
   and parse the result through `observationSchema`. Assert equality with the
   input on every wire field, including the namespace reference with its muxed
   identifier and continuity assertion, and the salience hints. The two fields
   ingest assigns, `observationId` and `ingestedAt`, are asserted to be present
   and well-formed rather than equal to an input that did not carry them.
   Repeat for a state observation and assert its `dated_at` column is null.
2. **A tag's strength is derivable at an arbitrary instant.** Write a tag with a
   known `g0`, then evaluate `strengthAt` at four instants under a fixed clock,
   including one before `tagged_at`, and assert the decay curve. Assert that no
   write occurred during evaluation.
3. **A promotion preserves the original timestamp.** Promote an observation
   dated on simulated day twelve, read the permanent record on simulated day
   twenty-one, assert the original instant survived. Then attempt to write a
   permanent record whose `original_dated_at` disagrees with its source, and
   assert `TimestampAltered`.
4. **The audit chain verifies.** Append a run of entries, verify the chain, then
   tamper with one row's `body` through a superuser session with triggers
   disabled and assert the verifier localises the break to that sequence number.

And the invariant gates of section 6, each of which fails the suite on its own:
byte-exact identity, no `UPDATE` on `observation`, no strength column on `tag`,
no tag deletion on the repository surface, the widened single-reader gate, and
the store suite failing rather than skipping without a database.

---

## 14. The M0 notes, and what M1 does with each

| Note | Disposition |
|---|---|
| 1. Namespace identity byte-exact in storage | Section 4. Explicit `COLLATE "C"`, unique on the pair, gated by a case-difference test. |
| 2. Single-reader gate scans one package only | Section 7. Gate moves to the repository root and scans every package; the store needs no exemption. |
| 3. Wallet-identifier gate, and the contradiction | Section 2. Negative muxed check in the schema; the leak gate is untouched; the residual claim is stated as ungated. |
| 4. A new package brings a test in the commit that opens it | The first `packages/store` commit contains its migration runner and that runner's test. |
| 5. Test configuration must reset `exclude` | `packages/store/tsconfig.test.json` sets `"exclude": []`, and a typecheck of a deliberately broken test file proves it before the file is removed. |
| 6. Continuous integration builds before typechecking | Already correct in `ci.yml`; M1 adds the Postgres service and the `NNT_TEST_DATABASE_URL` variable without reordering the steps. |

The small deferred items from M0 — the separator guard's message naming NUL
unconditionally, the discriminant test reading a Zod 3 surface, the per-channel
payload narrowing, flat error strings — are not M1's. The per-channel narrowing
becomes relevant when M2 reads payloads by channel, and is carried to M2 rather
than closed here.

---

## 15. What could still move

The half-life per channel is a calibration input, not a mechanism parameter, and
M1 stores it nowhere: `strengthAt` takes it as an argument. If M2's calibration
concludes that half-life varies per namespace rather than per channel, that is a
new column on `baseline`, not a change to this design.

The `trigger` table's tier vocabulary is written as text rather than an
enumeration, because the tiered failure policy is M3's and freezing the
vocabulary now would churn a migration through two milestones for no gain. It is
listed here so that the looseness is a decision on the record rather than an
oversight.
