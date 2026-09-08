# A1 — Stellar indexer: design

**Deliverable:** board card "A1 Indexer", first delivery 16 September 2026.
**Owner:** Atahan.
**Contract:** `docs/observation-contract.md`; `packages/schema` and its fixtures win on disagreement.
**Related:** issue #2 (schema 0.2.0), issue #3 (Horizon end-of-life), the
developer brief rev. 2 (5 September), the v0 design spec section 3.

The indexer turns chain events about a set of followed Stellar accounts into
observations the engine can consume. On 16 September there is no ingest layer,
so its output is files; its acceptance is a table of measured numbers, not the
word "done".

---

## 1. What the first delivery is, and what it is not

**In scope.**

- `packages/indexer`, a new workspace package depending on
  `@nonametrust/schema` and `@stellar/stellar-sdk`, nothing else at run time.
- Three channels: `volume`, `content` (memo), `protocol`.
- A backfill of at least 100 followed pubnet accounts over 30 days, written as
  NDJSON, one validated observation per line, one file per run.
- Re-run safety: the same range processed twice yields the same set of
  idempotency keys.
- Counters and a report: events read, observations produced, records dropped
  with their reason, coverage ratio, muxed share, request cost.
- The Horizon traps measured in the backtest, each with a test.
- Resumable operation: a state file with a cursor per account, so a run that
  stops continues where it left off.

**Out of scope, with reasons.**

- *`cluster_proximity`.* Needs a cluster list and a dust threshold that come
  from the study and are an undecided input. The channel stays in the schema
  so adding it later is not a migration.
- *`latency`, `price`, `address_integrity`.* The x402 gateway produces them,
  not the chain reader.
- *Writing into the engine's store.* M1's store exists on `m1-stores`, but the
  ingest surface (`observe`) is M3's and does not exist. The sink is a file;
  replacing it with an ingest call is one module (section 4).
- *Continuous following as a service.* `follow` ships as the same engine
  driven from the stored cursors, exercised by a test, not by a deployment.
  Shadow mode's operational shape (scheduling, alerting) is Tranche 1.
- *A second source backend.* Section 2 makes the seam; filling it is a
  decision recorded in issue #3, not a task of this delivery.

---

## 2. The source question: Horizon is on its way out

Checked on 8 September 2026 against developers.stellar.org and the SDF blog
(issue #3 carries the citations):

- Horizon "is nearing end-of-life and will eventually be deprecated in favor
  of Stellar RPC and Portfolio APIs"; it receives protocol-compatibility
  updates only. No sunset date is published.
- The SDF-hosted public Horizon truncated its history to one year on
  1 August 2024. The backtest measured about fourteen months of served
  history and a moving wall (HTTP 410 before it). Both agree.
- The default rate limit is 3600 requests per hour, one per second; the
  backtest sustained 0.8 per second.
- Stellar RPC keeps a seven-day window for `getTransactions` and `getEvents`,
  and has no per-account payment or effect endpoint. The migration guide
  says endpoints without a mapping need an indexer or a self-built one.
  `getLedgers` with data-lake integration reaches older history but returns
  raw ledger meta, which the reader would have to decode itself.

**Ruling.** The first delivery reads Horizon, because nothing else serves
thirty days of per-account payment, effect and memo history publicly today.
The reader is written behind one narrow interface, `SourceReader`, so the
mapper, deduplication and counters never see a Horizon record. The second
backend (RPC plus data lake, a Portfolio API, or a third-party Horizon with
longer retention) is chosen in Tranche 1, and the 16 September report lists
"depends on SDF Horizon" as a stated limit. Cost if wrong: the interface
turns out to be Horizon-shaped and the second backend needs a wider one,
which is a refactor of one package rather than of the engine.

```ts
interface SourceReader {
  /** Payment-family records touching `account` inside [from, to], oldest first. */
  payments(account: AccountId, range: LedgerRange): AsyncIterable<SourcePayment>;
  /** Effects on `account` inside the range: trustline, claimable balance, account flags. */
  effects(account: AccountId, range: LedgerRange): AsyncIterable<SourceEffect>;
  /** The memo of one transaction, when the payment record did not carry it. */
  memo(transactionHash: string): Promise<SourceMemo | null>;
  /** The oldest ledger the source serves; distinguishes "before retention" from "empty". */
  retentionFloor(): Promise<number>;
}
```

`SourcePayment`, `SourceEffect` and `SourceMemo` are the indexer's own types,
already normalised: amounts as decimal strings, times as UTC instants, the
muxed identifier as a separate field, the asset as `{ code, issuer | null }`.
Horizon's field names stop at the reader's boundary.

---

## 3. Package layout

```
packages/indexer/
  src/
    index.ts                 public surface: types, run functions, nothing Horizon
    cli.ts                   select-accounts | backfill | follow | report
    config.ts                network, followed accounts, ranges, paths, known issuers
    clock.ts                 injected Clock, as in packages/store
    horizon/
      client.ts              fetch, rate limiter, cache, 410 and page-cap handling
      reader.ts              SourceReader over the client
      records.ts             the raw Horizon record types the reader accepts
    source/
      types.ts               SourcePayment, SourceEffect, SourceMemo, LedgerRange
      reader.ts              the SourceReader interface
    mapper/
      volume.ts              payment family -> volume observations
      content.ts             transaction memo -> content observation
      protocol.ts            effects -> protocol observations
      address.ts             StrKey checksum, muxed resolution
      kinds.ts               the kind vocabulary, one spelling each
      issuers.ts             the known-issuer list
    dedupe.ts                in-run key set, and comparison against a previous run
    counters.ts              the counters, and their JSON and Markdown rendering
    sink.ts                  NDJSON writer, file name from the range
    state.ts                 cursor per account, completed ranges, JSON on disk
    accounts.ts              the deterministic selection rule for followed accounts
    run.ts                   backfill and follow: read -> map -> validate -> dedupe -> sink
  test/
    horizon-fixtures.ts      builders that make Horizon-shaped records from run-time keys
```

Dependencies: `@nonametrust/schema` (workspace), `@stellar/stellar-sdk`
(StrKey, `MuxedAccount`, `Keypair.random()` in tests). No HTTP library:
Node 22's `fetch`. No CLI framework: `node:util` `parseArgs`. Reason: the
traps live in the HTTP layer (410, page caps, rate limits) and must be
measured, not hidden inside a client that retries on its own.

---

## 4. Data flow

```
accounts.txt ─┐
              ├─> run.backfill(range) ─ for each account, in order:
state.json ───┘        reader.payments ──> mapper.volume ─┐
                       reader.effects  ──> mapper.protocol ├─> validateObservation ─> dedupe ─> sink (NDJSON)
                       reader.memo     ──> mapper.content ─┘         │
                                                                     └─> counters (every drop has a reason)
```

- Every observation passes `validateObservation` from the schema before it is
  written; a rejection is a counted drop with the validator's message as the
  reason, never a silent skip. Reason: the contract's own acceptance
  criterion is "one validated observation per line".
- The sink is the only module that knows the output is a file. Replacing it
  with a call to the engine's `observe` is the change M3 will make.
- Time enters through the injected `Clock` (for `fetchedAt` and file names);
  `Date.now()` appears only in `clock.test.ts`, as in `packages/store`.

---

## 5. Mapping rules

The contract (sections 2 to 9) fixes most of this. What follows restates it
as the mapper implements it and records the decisions the contract left open.

### 5.1 Which records, and for which namespace

The indexer follows a set of accounts. Each followed account is a namespace
`{ kind: "wallet", id: <base address> }`. Observations are produced **only for
followed namespaces**; when the other side of an event is not followed, that
side produces nothing (contract section 6, "our decision, not Horizon's").

A followed account's payments come from `/accounts/{id}/payments` with
`join=transactions`, which carries the memo; its effects from
`/accounts/{id}/effects`. Both are read oldest-first from the range's start,
bounded by `created_at`, with the cursor recorded per account.

### 5.2 `volume`

| Horizon record | Observation |
|---|---|
| `payment` | `kind: "payment"`; `amount`, `assetCode` (`"XLM"` for `native`, else `asset_code`); `direction: "in"` if the followed account is `to`, `"out"` if it is `from`. A self-payment is one namespace and one key, so one observation, `direction: "in"`, counted as `self_payment` (section 5.6) |
| `path_payment_strict_send`, `path_payment_strict_receive` | `kind: "path_payment"`; receiver side uses `amount` and the destination asset, sender side uses `source_amount` and the source asset |
| `create_account` | `kind: "create_account"`; `account` side `"in"`, `funder` side `"out"`, `starting_balance`, `"XLM"` |
| `invoke_host_function` with `asset_balance_changes` | **Measured on 8 September 2026: Horizon's `/payments` now returns Soroban invocations that moved a Stellar asset through its asset contract**, with `asset_balance_changes[]` entries of type `transfer`, `mint`, `burn`, `clawback` carrying `from`, `to`, `amount`, asset. This is a fourth member of the payment family the brief did not list. `transfer` entries whose `from` or `to` is the followed account become one `volume` observation per (operation, namespace, direction) with `kind: "sac_transfer"`, `ref: "op:<id>"`; several transfers to one account in one invocation are summed (section 5.6). `mint`, `burn` and `clawback` entries are counted, not mapped, in v0 |
| `account_merge` | Not returned by `/payments`; invisible, as the brief says. Counted from `/operations` only if the run enables `--merges`; off by default in v0 |

`ref` is `op:<id>` (the Horizon operation id), `observedAt` is `created_at`,
`salienceHints.amount` equals `payload.amount`. The muxed identifier, when
Horizon supplies `to_muxed_id` or `from_muxed_id` on the followed side, goes
into `namespace.muxedId`; the namespace `id` is always the base address.

### 5.3 `content`

A memo belongs to the transaction, not to the operation. **Decision (contract
section 14, first open point): one `content` observation per (transaction,
followed namespace), with `ref: "tx:<hash>"`.** Producing one per payment
operation would emit the same text once per operation and the tagging
pipeline would count one memo as several. The fixture pairs `content.json`
with `volume.json` on one `op:` reference; the fixture was written before the
question was settled, and this is proposed to Kerem as the contract's answer.
Cost if wrong: a re-key of content observations, which is cheap while the
sink is a file.

Only `memo_type: "text"` produces an observation: `payload: { text, field:
"memo" }`. `id`, `hash` and `return` memos carry no free text; they are
counted as `memo_non_text`, not mapped. An empty text memo is counted as
`memo_empty` and not mapped, because `content.text` is the evidence and an
empty string is not evidence.

The namespace is every followed account that is a party (`from` or `to`) to
a payment in that transaction. The payload has no field for who wrote the
memo; that is raised as an open point in section 12.

### 5.4 `protocol`

`payload.event` is Horizon's effect type name, verbatim. `kind` is ours.

| Effect | Observation |
|---|---|
| `trustline_created` | **state**, `kind: "trustline_open"`, `validFrom: created_at`, no `validUntil`, `ref: "op:<operation id>"`, namespace = `account`; payload `event`, `assetCode`, `assetIssuer`, `issuerKnown` |
| `trustline_removed` | **event**, `kind: "trustline_closed"`, `observedAt: created_at`, the closing operation's own ref; same asset fields. The state is never rewritten |
| `trustline_updated` | no observation; counted `trustline_updated_skipped` |
| `claimable_balance_claimant_created` | **event**, `kind: "claimable_balance_offered"`, namespace = the claimant (`account`), asset fields from the effect's `asset` (`CODE:ISSUER` or `native`), `issuerKnown` |
| `account_flags_updated` | **event**, `kind: "account_flags_changed"`, namespace = `account`, no asset fields; which flag changed is not carried (section 12) |

`issuerKnown` is filled on every observation that carries an `assetCode`:
`true` when the issuer is on the known-issuer list, `false` otherwise, never
absent. The list lives in `mapper/issuers.ts`, short, with a comment naming
each entry's source; issuer addresses are Stellar account ids, so **the list
cannot contain them literally** (section 8). It holds `sha256(issuer)` hex
digests instead, with the asset code and home domain beside each for a human
reader; the mapper hashes the effect's issuer and looks it up. Cost: a reader
cannot eyeball the list; the test that builds it from a run-time key proves
the lookup works.

### 5.5 Identity: muxed addresses and the checksum

The contract leaves two rules to the indexer and says so (section 11, item 1).
Both are gated here.

- **Muxed to base.** Horizon already reports the base address in `to`/`from`
  and the muxed form separately (`to_muxed`, `to_muxed_id`). The mapper takes
  `to`/`from` for `id` and `*_muxed_id` for `muxedId`, and additionally
  refuses to emit if `id` decodes as a muxed StrKey, using
  `StrKey.isValidMed25519PublicKey`. Two gates: a synthetic record with a
  muxed base address is refused; a record with `to_muxed_id` yields the base
  `id` and the numeric `muxedId`.
- **Checksum.** Every namespace `id` the mapper emits must satisfy
  `StrKey.isValidEd25519PublicKey`. A failure is a counted drop
  (`invalid_account_id`), because Horizon does not emit invalid ids and one
  arriving means the reader or the mapper corrupted it.

### 5.6 One observation per (ref, channel, namespace)

The key admits at most one observation per `(ref, channel, namespace)`
(contract section 9). Two places would violate it:

- A Soroban invocation carrying several `transfer` entries to the same
  account. **Ruling:** the entries are summed into one `volume` observation
  per (operation, namespace, direction), `kind: "sac_transfer"`, with
  `payload.amount` the sum and the count recorded in counters as
  `sac_transfers_merged`. Summing is a mapping choice, not a contract
  change, and the operation id stays the ref. If a single invocation moves
  two different assets to one account, the second asset is dropped with
  reason `sac_multi_asset` and the case is reported; it is not invented
  around.
- A self-payment (followed account is both `from` and `to`): one observation,
  `direction: "in"`, counted `self_payment`.

Any other collision is a defect: the dedupe layer records it as
`duplicate_key_in_run` with both records' Horizon ids, and the run's exit
code is non-zero when the count is above zero. Reason: a collision the
mapper did not foresee is a contract question, not something to paper over.

---

## 6. Deduplication and the re-run guarantee

The acceptance test is the contract's: process the same range twice, collect
`idempotencyKey` from each line of both files, the two sets are identical.

- Within a run, `dedupe.ts` keeps the set of emitted keys; a repeat is
  `duplicate_key_in_run` (section 5.6).
- Across runs, `backfill --compare <previous.ndjson>` loads the previous
  file's keys and reports `keys_only_in_previous` and `keys_only_in_current`,
  both expected to be zero. This is the 16 September measurement, and it
  runs against real Horizon, not against fixtures.
- Nothing in the key depends on `fetchedAt` or the run time, so a repeat read
  of the same operation cannot produce a new key by construction (schema
  gate `idempotency.test.ts`); the indexer's own gate is that its `ref` is
  stable, which the two-run comparison measures.

---

## 7. State and resumability

`state.json`, one per network, holds for each followed account the last
paging token consumed for payments and for effects, and the list of
completed ranges. A run:

1. reads the state, skips accounts whose range is complete,
2. resumes each account from its stored cursor,
3. writes the state after every page, so a kill between pages loses at most
   one page of work and never produces a gap,
4. marks the range complete for the account when the source returns a
   record past `range.to` or an empty page.

Re-running a completed range with `--force` ignores the state; this is how the
two-run comparison is produced. The state file contains account ids and is
therefore gitignored (section 8).

Horizon's raw responses are cached on disk under `cache/` keyed by the
request URL's sha256, written only on HTTP 200, as the backtest did: the
cache-file count equals the successful request count, which is the request
cost in the report. The cache is gitignored.

---

## 8. Privacy: the address gate and this package

`gates/no-stellar-address.test.ts` refuses any G+55 or M+68 base32 shape in a
tracked file. Consequences for the indexer, each decided rather than
discovered:

- The followed-account list, the state file, the cache and the NDJSON output
  are untracked (`packages/indexer/{accounts.txt,state*.json,cache/,out/}` in
  `.gitignore`). The **selection rule** is tracked (section 9), so anyone
  regenerates the same list.
- Test fixtures are built at run time from `Keypair.random()`; no Horizon
  response is ever recorded into the repository. `test/horizon-fixtures.ts`
  is the one builder, so a future recording tool has one place to be refused.
- The known-issuer list stores digests, not addresses (section 5.4).
- The report (`report.json`, `report.md`) carries counts only, never an
  account id; a gate greps the rendered report for the address shape.

---

## 9. Selecting the followed accounts

The 100-account backfill needs accounts that look like the shadow-mode
population, ordinary active wallets, and the selection must be reproducible
without committing the list. `select-accounts` implements this rule, and the
rule is the only thing that is tracked:

1. Fix a ledger range `[L0, L1]` by argument (the report records it).
2. Read `/payments?order=asc` from `L0`'s first paging token to `L1`'s last,
   collecting `from` and `to` of every `payment`, `path_payment_*` and
   `create_account` record, with a count of appearances per account.
3. Drop accounts appearing more than `max_appearances` times in the sample
   (default 50: the exchange and service profile the backtest excluded with
   its 2,000-transactions-per-90-days filter, scaled to the sample window).
4. Drop accounts that Horizon reports as not found (never funded or merged).
5. Order the rest by `sha256(account id)` and take the first `n`.

The rule is deterministic given `[L0, L1]`; the test proves that two runs over
a synthetic payment set select the same accounts in the same order and that a
high-frequency account is excluded. Cost if wrong: the population differs
from the pilots' real counterparties, which is true of any selection made
before a pilot exists, and is written as a limit in the report.

---

## 10. Counters and the report

Every counter has a name, a definition, and the section that makes it a
delivery metric.

| Counter | Definition |
|---|---|
| `accounts_followed`, `days_covered` | the coverage row: >= 100 x 30 |
| `records_read` per type | payment-family records and effects the reader returned |
| `observations_written` per channel | lines in the NDJSON |
| `dropped` per reason | `validation_failed`, `memo_non_text`, `memo_empty`, `trustline_updated_skipped`, `claimable_creator_unresolved`, `sac_multi_asset`, `invalid_account_id`, `self_payment`, `unsupported_type` and any reason section 5 names; a drop without a reason is a bug and the run fails |
| `coverage_ratio` | `observations_written.volume / records_read.payment_family` |
| `muxed_records`, `muxed_resolved` | records with a muxed side, and how many were mapped with `muxedId` set |
| `requests`, `cache_hits`, `pages_truncated`, `retention_refusals` | request cost, and the traps' footprint |
| `duplicate_key_in_run`, `keys_only_in_previous`, `keys_only_in_current` | the deduplication row |
| `wall_clock_ms` | the cost row |

`report.md` renders the delivery table of the brief's section 7 with these
numbers filled in and the limits stated (Horizon dependency, selection rule,
SAC transfers summed, memos text-only).

---

## 11. Traps, and the test each one gets

| Trap (measured in the backtest, confirmed against the docs) | Handling | Gate |
|---|---|---|
| History before the retention wall returns HTTP 410 | `RetentionBoundary` error naming the ledger; the run records `retention_refusals` and marks the account's range as `unreachable_before <ledger>`, never as empty | a stubbed 410 produces the error class and the counter, and no "empty range" completion |
| Page caps and `limit` silently truncate | The client requests `limit=200`, follows `next` until an empty page, and counts `pages_truncated` when a page returns fewer than requested while `next` still yields records | a stubbed short page followed by a non-empty page increments the counter and loses nothing |
| Path payments are absent from plain payment views | The reader takes the whole payment family from `/payments`, which returns them; the mapper handles both strict types | a synthetic strict-send record yields two correctly sided observations |
| Soroban asset transfers appear in `/payments` as `invoke_host_function` | Section 5.2 and 5.6 | a synthetic invocation with two transfers to one account yields one summed observation |
| Claimable-balance creator not always resolvable | v0 maps the claimant side from the effect and needs no creator; if a later channel needs it, the resolution failure is a counted drop | the counter exists and the effect maps without an operation lookup |
| Account merges invisible | Documented; `--merges` reads `/operations` for `account_merge` and counts them, off by default | a synthetic merge is counted and not mapped |
| Muxed addresses | Section 5.5 | two gates in 5.5 |
| Rate limit 3600 per hour | Token bucket at 0.8 requests per second; 429 backs off exponentially and is counted | the limiter never issues more than one request in any 1250 ms window under a fake clock |
| Retention wall moves | The report records the retention floor observed at run time and the run date, so a reader knows what was reachable then | `retentionFloor()` is called once per run and written into the report |

Each gate is proved to fire before it is trusted: the implementation plan
plants the violation, watches the test fail, and reverts.

---

## 12. Open points for Kerem, with the indexer's proposal

1. **Memo reference.** `tx:<hash>` for `content`, one observation per
   (transaction, namespace). The fixture pair `volume.json`/`content.json`
   would carry different refs.
2. **Memo author.** `content` payload has no direction or author field; an
   incoming lure memo and the followed account's own outgoing memo look the
   same. Proposal: add `direction: "in" | "out"` to the content payload,
   mirroring `volume`. Until then the indexer records the memo for every
   followed party of the transaction.
3. **Soroban asset transfers.** `/payments` returns them; the brief's
   "payment family is three types" is four on today's Horizon. Proposal:
   `kind: "sac_transfer"`, summed per (operation, namespace, direction).
4. **Account flags.** No field for which flag changed; the indexer records
   only that they changed, as the contract says.
5. **Horizon end-of-life.** Issue #3.

None of these blocks the 16 September delivery; each is implemented as
proposed and reported, so the report shows what the decision changes.

---

## 13. Acceptance criteria

The brief's section 7 table, as tests and measurements:

1. **Coverage.** `report.json` shows >= 100 accounts and a 30-day range; the
   run completed without an unexplained stop.
2. **Deduplication.** `backfill --force --compare` over the same range
   reports zero keys on either side. Measured against live Horizon.
3. **Dropped records with reasons.** `dropped` sums to
   `records_read - observations_written` (per channel), and every reason is
   one of the named ones. A test asserts the identity on synthetic input;
   the run asserts it at exit.
4. **Coverage ratio.** Reported, with the drop reasons that explain the
   remainder.
5. **Muxed share.** `muxed_records / records_read.payment_family`, and
   `muxed_resolved == muxed_records`.
6. **Cost.** `requests` per observation and `wall_clock_ms` for the run.

And the gates of sections 5.5, 5.6, 6, 8, 9 and 11, each failing the suite on
its own.

---

## 14. What could still move

- If Kerem rules for `op:` references on memos, `content.ts` changes and the
  first-run keys are discarded; nothing else moves.
- If the 100-account run shows `sac_multi_asset` above a handful, the summing
  rule is wrong for real traffic and the schema needs a per-asset key part,
  which is a contract change and is raised, not worked around.
- If Horizon's public instance rate-limits below 0.8 per second in practice,
  the 100-account run takes longer than a day; the report says so and the
  limiter setting is a flag.
