# @nonametrust/indexer

Reads the chain history of followed Stellar accounts from Horizon and writes
`volume`, `content` and `protocol` observations that pass
`validateObservation`, as NDJSON. Design: `docs/superpowers/specs/2026-09-08-indexer-design.md`.

## Run

    corepack pnpm build
    node packages/indexer/dist/cli.js select-accounts --network stellar:pubnet --from 2026-08-25 --to 2026-08-26 --n 100 --out packages/indexer/accounts.txt --cache-dir packages/indexer/cache
    node packages/indexer/dist/cli.js backfill --network stellar:pubnet --accounts packages/indexer/accounts.txt --from 2026-08-01 --to 2026-08-31 --out-dir packages/indexer/out --state packages/indexer/state-pubnet.json --cache-dir packages/indexer/cache
    node packages/indexer/dist/cli.js backfill ... --force --compare packages/indexer/out/stellar-pubnet_2026-08-01_2026-08-31.ndjson

`accounts.txt`, `state*.json`, `cache/` and `out/` hold account ids and are
gitignored; the root gate refuses the id shape in any tracked file.

## What is measured

The report (`out/<name>.report.md`) fills the delivery table of the
developer brief: coverage, deduplication across two runs, drops with
reasons, coverage ratio, muxed share, cost. Reads the SDF public Horizon,
which serves about a year and is on its way to end-of-life (issue #3); the
reader sits behind `SourceReader` so the backend can change.
