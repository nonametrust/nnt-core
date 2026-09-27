# nnt-core

The NonameTrust core engine and the Stellar indexer, in one repository.

They share a repository because the one thing they have in common, the
observation schema, must live in exactly one place: the indexer produces
observations and the engine consumes them, and if the two sides held separate
copies of the shape they would drift the first week. The contract between them
is narrow on purpose, so the two sides run in parallel once the schema is
agreed.

Private until the `v0` tag, then public. Apache-2.0.

## What is here

| Path | What it is |
|---|---|
| `packages/schema` | The observation schema: seven channels, the event/state distinction, namespace and source, per-channel payload validators, the deterministic idempotency key, and one golden fixture per channel. **This is the only package the indexer depends on.** |
| `packages/store` | The Postgres home of every observation, tag, trigger and audit entry the engine produces, with each invariant held by the database rather than by a caller's good manners. Depends on `schema`. See [The store](#the-store). |
| `packages/engine` | The composition point, and the only package allowed to import BOTH `store` and `tagging` -- which is what those two were kept apart for. Holds `BriefPolicy`, the brief's own versioned numbers, and `ids.ts`, the single place an identifier is minted. Depends on `schema`, `store` and `tagging`. See [The engine](#the-engine). |
| `packages/tagging` | The arithmetic: an observation read into `(aspect, value)` readings by a derivation no caller can influence, judged against its baseline, clipped, folded in, and turned into a bounded `g0` when the surprise crosses the noise-adaptive threshold. Depends on `schema` alone and needs no database. See [Tagging](#tagging). |
| `docs/observation-contract.md` | The contract for the indexer developer, in Turkish: what an observation is, what each field means, which rules the schema enforces and which it does not yet. Start there if you are writing a producer. |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | The v0 design and the milestone plan the code follows. |
| `gates/` | Repository-wide gates that are not about one package. Today: no tracked file may contain a Stellar-shaped account id, only `datedAt` reads a date off an observation, the tagging and store baseline shapes agree field for field, the tag-refresh shapes do too, nothing outside the indexer's reader imports Horizon, and only `packages/engine` imports both the store and tagging. See [Gates](#gates) for all six. |

`packages/engine` arrived with M3. The one package named in the design and
still to come is `nonametrust`, the distribution package, which is M5's;
`schema` depends on nothing and is publishable on its own.

## Running it

Node 22 and pnpm 10. Then, at the root:

```bash
pnpm install
pnpm build       # emits packages/*/dist; no test file may land there
pnpm typecheck   # every package, plus the root gates
pnpm test        # every package, then the root gates
```

Build comes first because every workspace dependency resolves through `dist`
and none has a `src` fallback: a package that imports another cannot typecheck
or test on a fresh checkout until that package's `dist` exists, and must be
rebuilt after every pull that touches it. This used to be true of `schema`
alone; since M3 it is true of `store` and `tagging` too, because
`packages/engine` imports both. CI runs those four in that order and then
fails if any file under `packages/*/dist` matches `*.test.*` or `*.spec.*`.

## The store

`packages/store` holds the observations, tags, permanent records, the audit
chain, the counterparty spaces and their month keys, and the four tables M2
and M3 fill -- eleven tables. Its invariants are the database's:
append-only tables, the chain's linkage and hashes, the promotion instant,
the namespace and month-key guards and the refusal to observe an erased
counterparty are held by triggers that raise, and the package maps each SQLSTATE to a named
error. Tag strength is never stored, only derived. Time enters through an
injected clock and nowhere else, which is what lets
`packages/store/src/acceptance.test.ts` run the design's day-twelve to
day-twenty-one scenario, all four acceptance criteria on one database, in
milliseconds.

Retention is the store's own design rather than a policy applied to it, and
it is not deletion. A payload is sealed under a key per (counterparty space,
calendar month), and that month key is wrapped under the space's own key. A
declared grace after the month closes, a sweep shreds the month key: the
payload stops opening while the row, its foreign keys, the audit chain and
every seal stay exactly where they are and stay verifiable. An erasure
request shreds the outer key instead and takes the whole space with it. A
promotion re-seals the rescued observation under that outer key, which is how
a captured trace outlives its month and still dies with an erasure request.

**What "erasure" does NOT mean here**, because the word invites more than the
mechanism delivers and a reader who skips this paragraph will assume the rest.
Four limits, each measured rather than reasoned, in the plan's §2c and R19:

1. A shred is an UPDATE that nulls a column. The wrapped key stays in the
   pre-vacuum heap -- read back with `pageinspect` and used to open an
   expired month -- and in WAL, where a blind scan found one after
   `VACUUM FULL`. So anything that archives WAL, streams to a replica or
   takes base backups keeps every key for as long as it keeps those.
2. Which makes the realistic attacker **a database backup**: the wrap binds a
   key to its row's identity and not to time, so restoring a pre-shred copy
   into its own row makes the space readable again. Irreversible erasure
   needs two things this repository does not have -- a master-key rotation
   runbook whose old master is destroyed, and a backup retention shorter than
   the erasure promise.
3. Erasure is **content-only**. After a shred the counterparty identifier
   itself, every observation's channel, kind, evidence kind, instants and
   producer, every tag's strength and **aspect**, every baseline's mean and
   all permanent-record metadata are still plaintext. Three are worse than
   they look: a baseline over a single observation has a mean equal to that
   observation's amount; the idempotency key is an unkeyed SHA-256 over mostly
   public parts, from which a three-hundred-candidate dictionary recovered 3
   of 3 source references of a shredded namespace; and an aspect is derived
   from the payload and reads like it -- the asset code and direction, the
   quote unit, the on-ledger event name -- so after an erasure the tag queries
   still answer what KIND of thing was observed, in the payload's own words.
4. And the store **answers** a re-delivery for an erased space rather than
   refusing it, so the existence of an observation and the instant it was
   ingested stay answerable per source reference even when its content does
   not.

The defensible sentence is therefore "content unreadable through this
package's API", not "erased".

### Running the store tests

The store suite needs a PostgreSQL 17 database and fails rather than skips
without one, because a store suite that skips itself reports green while
enforcing nothing. From the root, with PostgreSQL 17 installed from Homebrew
(`brew install postgresql@17`; set `NNT_PG_BIN` if its binaries live
elsewhere):

    eval "$(pnpm -s --filter @nonametrust/store db:up)"
    pnpm test

The first line starts a cluster that belongs to this checkout, creates the
test database on first use, and prints the `export` of
`NNT_TEST_DATABASE_URL` that the suite reads; `-s` matters, because without it
pnpm prints its script header into the `eval` as well. The suites generate
their own master keys, so no `NNT_MASTER_KEY` is needed to run them.

The cluster lives in `packages/store/.pgdata`, listens on 127.0.0.1:55432, and
is gitignored. `pnpm --filter @nonametrust/store db:down` stops it;
`packages/store/scripts/dev-db.sh destroy` removes it, and the next `db:up`
creates it again. Each test file works in a schema of its own, created and
dropped around the file, so the database carries nothing over between runs.

## The engine

`packages/engine` is the composition point, and the only package allowed to
import both `@nonametrust/store` and `@nonametrust/tagging`. Those two were
kept apart deliberately -- the store holds invariants and computes nothing a
decision depends on, tagging is arithmetic provable over a fixed corpus with no
cluster -- and a root gate holds the separation in both directions and in the
manifests.

As of M3's first task it holds two values and no behaviour yet. `BriefPolicy`
is the brief's own versioned numbers, kept out of tagging's `Policy` because a
brief field there is a number that package never reads, and because three
fields of the tagging policy are all `3`, which once made a wrong-field read
invisible. **None of its numbers is measured**: each was chosen so the design's
section 9 scenario behaves, which is the same admission the design makes about
its own defaults, and each carries a comment saying what it is, what it is not
and what would replace it. `ids.ts` is the single place an identifier is
minted, and the engine's own gate refuses `randomUUID` everywhere else --
because the brief is a pure function of its inputs, so that the same inputs
replay to the same output, and one identifier reached for inside it breaks that
while leaving the output well-formed.

The engine reads no clock of its own either. Its instant is the `Clock` object
the store already holds, injected, so `clock.now()` is an ordinary call here
and there is nothing to exempt.

## Tagging

`packages/tagging` is where a baseline is defined, where a surprise is
measured against it, and where a tag's `g0` comes from. It depends on
`schema` alone and its suite needs no database:

    pnpm --filter @nonametrust/tagging test

The shape is a pure function: in, an observation, the baseline for its
`(namespace, channel, aspect)`, the live tag on that pair with its strength
at this instant, and the policy and calibration in force; out, the next
baseline and either no decision or a decision carrying `g0`, the channel,
the signed surprise and whether the tag is new or a refresh. The decayed
strength is an input, computed by the caller with the store's `strengthAt`,
because the two packages may not depend on each other and the curve must
have one definition. The aspect is derived from the observation and never
supplied, so a producer cannot split or merge a counterparty's history by
choosing a string.

Two files carry the numbers. `src/calibration.ts` holds what the study
measured, the channel weights and the pooled half-life, each entry naming
its source, and a test recomputes every entry from the aggregate tables
vendored under `fixtures/study/`. `src/policy.ts` holds what the study does
not speak to, and every entry there is declared uncalibrated, its default
chosen to make the design's day-twelve to day-twenty-one scenario behave.
The half-life is one pooled value for every channel and is not calibrated
per channel, pending D1.4. Both files are versioned and every result names
the two versions that produced it, and every decision also names whether
its channel weight came from the calibration or from the policy, since the
two unmeasured channels take a policy number that the calibration never
produced.

`src/acceptance.test.ts` runs the six M2 criteria together on one corpus,
that scenario, in milliseconds.

## Gates

A rule in this repository that nothing enforces is treated as unwritten, so
each property the code claims has a test that would fail if it stopped being
true. Several of the gates below exist because a review walked a spelling past
their first version; each one's own file records which. The ones worth knowing
before you add a file:

- **No Stellar account id in any tracked file**, checksum-valid or not
  (`gates/no-stellar-address.test.ts`). Takes its paths from the git index and
  their content from the working tree, so a staged file is scanned before it
  is committed, while an address staged and then scrubbed locally is caught by
  CI on the committed tree. Refuses to report green unless it can see its own
  file in the index. Synthetic ids in fixtures are short and obviously
  fake, like `GOLDADDRESS`; a test that needs a real-shaped key generates one
  at run time and never writes it to disk.
- **No test file in `dist`**, `*.test.*` or `*.spec.*` (CI, after `pnpm build`).
- **Only `datedAt` reads a date off an observation**
  (`gates/single-date-reader.test.ts`), so a state can never be credited as
  a dated event. The gate scans every `packages/*/src` tree and exempts only
  the module that defines the fields and the one that reads them, keyed by
  path relative to `packages/` rather than by basename, so a new package
  enters under it on the day it is created, with no exemption. Refuses to
  report green if it finds no package to scan.
- **The two `BaselineState` declarations agree field for field**
  (`gates/baseline-shape.test.ts`). `packages/tagging` produces the shape
  and `packages/store` stores it, and the arithmetic may not import the
  store, so the shape is declared twice and this gate reads both
  declarations as text and compares names and written types. Refuses to
  report green unless it finds the Welford fields in each.
- **The two `TagRefresh` declarations agree field for field**
  (`gates/tag-refresh-shape.test.ts`), sharing its reader with the gate
  above (`gates/interface-fields.ts`). The consequence of a drift is worse
  here: the store writes these four values as handed and recomputes none of
  them, so a field the arithmetic starts returning and the store does not
  know about is simply not written, the refresh appears to succeed, and the
  row is left half-updated with nothing raising anything.
- **The store reads no clock but its own**
  (`packages/store/src/clock-gate.test.ts`), a lint over `packages/store/src`
  in the idiom of the tagging package's. It matters because retention is a
  simulated calendar: expiry derived from the period and not from today, a
  sweep told `now` rather than asking, a producer cap measured against the
  caller's instant. All of it is provable in milliseconds only because the
  clock is an argument. Two modules are exempt and both are named in the
  file: `clock.ts`, which is the injection point, and `migrate.ts`, whose
  migration ledger stamps `applied_at` with the database's `now()` -- a
  deployment fact rather than a domain instant, and one a simulated clock
  cannot supply, since the migration is what creates the schema. The exempt
  set is pinned by name, so it cannot widen quietly.

  Called a **lint** deliberately. Review walked about a dozen spellings past
  its first version -- `new (Date)()`, a destructured `now`, a bare `Date()`,
  a Postgres `now()` inside a query -- and the predicate is wider now and
  still cannot be complete, because a lexical scan holds spellings and not
  semantics. What makes the rule true is the suite: every retention fixture
  pins a fixed instant, so a repository that started reading the wall clock
  fails eleven tests before it reaches this one.
- **Only `packages/engine` imports both the store and tagging**
  (`gates/engine-is-the-only-composer.test.ts`). The two were kept apart so
  that the arithmetic stays provable without a database and the store stays a
  place that computes nothing; the engine is the composition point they were
  kept apart for, and this gate holds that the set of packages composing them
  is a set of one. It scans every `packages/*/src`, checks the manifests as
  well as the imports -- including the ROOT manifest, because pnpm hoists a
  dependency declared there into every package's resolution -- resolves real
  paths so a symlinked directory cannot pass a lexical check, and refuses
  `require`, `createRequire` and a dynamic import no reader can resolve.
- **The engine reads no clock and mints no identifier**
  (`packages/engine/src/clock-gate.test.ts`), the store's gate copied pattern
  for pattern and extended to refuse identifiers. `ids.ts` is the one exempt
  module. Because it is a COPY, its last test pins the SHA-256 of the store's
  own form list: any change there turns this red, and the red is the
  instruction to carry the new form across. An earlier version compared form
  NAMES parsed out of that file and review grew the store's list six ways it
  could not see.
- **The engine's boundary** (`packages/engine/src/boundary.test.ts`): it
  declares exactly its three workspace dependencies and no driver, reaches each
  through its public surface rather than past it -- a deep import resolves,
  because no `exports` field refuses one -- and imports no `*.test.ts` helper,
  which would carry that file into `dist`.
- **The schema version is checked exactly** on every observation
  (`packages/schema/src/payloads.test.ts`), and the golden fixtures must all
  validate (`packages/schema/src/fixtures.test.ts`).
