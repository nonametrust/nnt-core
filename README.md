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
| `docs/observation-contract.md` | The contract for the indexer developer, in Turkish: what an observation is, what each field means, which rules the schema enforces and which it does not yet. Start there if you are writing a producer. |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | The v0 design and the milestone plan the code follows. |
| `gates/` | Repository-wide gates that are not about one package. Today: no tracked file may contain a Stellar-shaped account id, and only `datedAt` reads a date off an observation. |

The remaining engine packages named in the design (`tagging`, `engine`,
`nonametrust`) arrive in later milestones and will depend on `schema`; `schema`
depends on nothing and is publishable on its own.

## Running it

Node 22 and pnpm 10. Then, at the root:

```bash
pnpm install
pnpm build       # emits packages/*/dist; no test file may land there
pnpm typecheck   # every package, plus the root gates
pnpm test        # every package, then the root gates
```

Build comes first because `@nonametrust/schema` resolves through `dist` and
has no `src` fallback: a package that imports it cannot typecheck or test on a
fresh checkout until `dist` exists, and must be rebuilt after every pull that
touches `packages/schema`. CI runs those four in that order and then fails if
any file under `packages/*/dist` matches `*.test.*` or `*.spec.*`.

## The store

`packages/store` holds the observations, tags, permanent records, the audit
chain, and the four tables M2 and M3 fill. Its invariants are the database's:
append-only tables, the chain's linkage and hashes, and the promotion instant
are held by triggers that raise, and the package maps each SQLSTATE to a named
error. Tag strength is never stored, only derived. Time enters through an
injected clock and nowhere else, which is what lets
`packages/store/src/acceptance.test.ts` run the design's day-twelve to
day-twenty-one scenario, all four acceptance criteria on one database, in
milliseconds.

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

## Gates

A rule in this repository that nothing enforces is treated as unwritten, so
each property the code claims has a test that would fail if it stopped being
true. The ones worth knowing before you add a file:

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
- **The schema version is checked exactly** on every observation
  (`packages/schema/src/payloads.test.ts`), and the golden fixtures must all
  validate (`packages/schema/src/fixtures.test.ts`).
