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
| `gates/` | Repository-wide gates that are not about one package. Today: no tracked file may contain a Stellar-shaped account id. |

The engine packages named in the design (`store`, `tagging`, `engine`,
`nonametrust`) arrive in later milestones and will depend on `schema`; `schema`
depends on nothing and is publishable on its own.

## Running it

Node 22 and pnpm 10. Then, at the root:

```bash
pnpm install
pnpm typecheck   # every package, plus the root gates
pnpm test        # every package, then the root gates
pnpm build       # emits packages/*/dist; no test file may land there
```

CI runs those four in that order and then fails if any file under
`packages/*/dist` matches `*.test.*`.

## Gates

A rule in this repository that nothing enforces is treated as unwritten, so
each property the code claims has a test that would fail if it stopped being
true. The ones worth knowing before you add a file:

- **No Stellar account id in any tracked file**, checksum-valid or not
  (`gates/no-stellar-address.test.ts`). Scans the git index, so a file fails
  the moment it is `git add`ed, and refuses to report green unless it can see
  its own file in the index. Synthetic ids in fixtures are short and obviously
  fake, like `GOLDADDRESS`; a test that needs a real-shaped key generates one
  at run time and never writes it to disk.
- **No test file in `dist`** (CI, after `pnpm build`).
- **Only `datedAt` reads a date off an observation**
  (`packages/schema/src/timing.test.ts`), so a state can never be credited as
  a dated event.
- **The schema version is checked exactly** on every observation, and the
  golden fixtures must all validate (`packages/schema/src/fixtures.test.ts`).
