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
| `docs/observation-contract.md` | The contract for the indexer developer, in Turkish: what an observation is, what each field means, which rules the schema enforces and which it does not yet. Start there if you are writing a producer. |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | The v0 design and the milestone plan the code follows. |
| `gates/` | Repository-wide gates that are not about one package. Today: no tracked file may contain a Stellar-shaped account id, and only `datedAt` reads a date off an observation. |

The engine packages named in the design (`store`, `tagging`, `engine`,
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
