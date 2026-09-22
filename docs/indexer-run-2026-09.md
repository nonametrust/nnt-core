# Indexer run, September 2026

The measurement behind the A1 delivery (board card "A1 Indexer", due
16 September 2026). Aggregates only. No account identifier appears here and
the root gate checks that; no single account is profiled here either, which
no gate checks, because the selection rule below is reproducible and a
per-account figure tied to a position in that list re-identifies the
account. Reproduce with the commands in `packages/indexer/README.md`; the
selection rule and its parameters below regenerate the same account list.

Source: SDF public Horizon (`horizon.stellar.org`), which served ledgers from
58024801 on the run day (about fourteen months), rate-limited at one request
per second by default (`developers.stellar.org/docs/data/apis/horizon/api-reference/structure/rate-limiting`);
Horizon is "nearing end-of-life" per `developers.stellar.org/docs/data/apis`
(issue #3 carries the citations and the ruling that the reader sits behind
`SourceReader`).

## 1. Account selection

Rule (spec section 9, `packages/indexer/src/accounts.ts`): every `from` and
`to` of the classic payment family in a fixed ledger range; accounts appearing
more than `max-appearances` times dropped as the exchange and service profile;
accounts Horizon does not know dropped; the rest ordered by the byte order of
`sha256(account id)`; the first `n` kept.

| Parameter | Value |
|---|---|
| window | 2026-08-25T00:00:00Z to 2026-08-25T00:15:00Z (ledgers 64109909-64110066) |
| candidates seen | 4,804 |
| excluded as busy (> 50 appearances) | 47 |
| excluded as unknown to Horizon | 2 |
| selected | 100 |
| requests | 266 |

## 2. One wallet, thirty days

The first end-to-end run was a single account over 2026-08-01T00:00:00Z to
2026-08-31T23:59:59Z (ledgers 63741059-64216184), on 2026-09-08. **Its
per-account figures are withdrawn from this report, and so is its position
in the selection.**

The reason is section 1 of this document. It states the window, the
parameters and the ordering, and says the rule regenerates the same account
list — which is what makes the measurement reproducible, and is staying.
But a reader who reproduces that list and is then told which position in it
this section described would hold a month-long profile of one identifiable
wallet: how much value reached it, how many contract invocations touched
it, what kind of contract those came from. That is subject-level data about
a party who was never asked, this project does not publish it anywhere
else, and this repository goes public at v0.

What the run established is a property of the pipeline, not of the account,
and that part stands:

- **The hand check does not go through the indexer's own reader.** Paging
  `/accounts/{id}/operations?order=asc` over the same range returned the
  same `payment` operations as `/payments`, and exactly one more
  `invoke_host_function`: an invocation that moved no asset, which
  `/payments` omits and `/operations` returns. No difference was left
  unexplained.
- **The re-run is identical.** The same range processed a second time with
  `--force --compare` against the first file reported 0 keys only in the
  previous run, 0 only in the current, exit code 0. The second run came
  entirely from the page cache, so it proves the pipeline deterministic and
  says nothing about whether the source is stable (section 5).
- **A Soroban-heavy account produces almost nothing in these three
  channels**, and the report makes that visible as counted drops rather
  than as an empty file. Section 3 carries the same finding across 100
  accounts (`sac_non_transfer`, 2,597,025 entries), which is where a
  finding of this shape belongs.

## 3. One hundred accounts, thirty days

The 100 selected accounts, 2026-08-01T00:00:00Z to 2026-08-31T23:59:59Z
(ledgers 63741059-64216184). The pages were fetched between 2026-09-08 and
2026-09-15 across the interrupted runs of section 4a; the delivered file is a
single forced run on the delivered code (PR #6) on 2026-09-15, replayed
from the page cache (8,780 cache hits, 2 live requests, 70 s), so every line
comes from one build. The counters below are that run's
(`out100/stellar-pubnet_2026-08-01_2026-08-31.counters.json`, gitignored).

| Metric (brief section 7) | Measured |
|---|---|
| Coverage | 100 accounts x 31 days; 646,890 observations, 100 namespaces |
| Deduplication | same range run a second time with `--force --compare`: 0 keys only in the previous file, 0 only in the current, exit 0; the file itself holds 646,890 distinct keys |
| Dropped records with reason | 3,676,280, every one with a reason (table below); no `duplicate_key_in_run`, no `invalid_account_id` |
| Coverage ratio | 420,356 volume observations from 420,474 payment-family records read: 0.9997; the 118 records that did not become observations are Soroban transfer entries between two contracts inside an invocation the followed wallet took part in (`not_followed`) |
| Muxed share | 1 of 420,474 payment-family records carried a muxed side (`to_muxed_id`), and it was the counterparty's side: `muxed_followed` 0, `muxed_resolved` 0, so the criterion `muxed_resolved == muxed_followed` holds and no observation carries a `muxedId` |
| Cost | 8,782 distinct Horizon pages for the 100 accounts, 87.8 per account, 0.0136 per observation; at Horizon's pace (1.25 s per request) about 3 h 03 min of request time; the live fetch was spread over four days by the stops in section 4a (the last live run: 1,452 requests, 2,610 s wall for 12 accounts) |

Observations by channel and kind:

| Channel | Kind | Count |
|---|---|---|
| volume | `payment` | 418,571 |
| volume | `path_payment` | 832 |
| volume | `create_account` | 898 |
| volume | `sac_transfer` | 55 |
| content | `memo` | 220,668 |
| protocol | `trustline_open` (state) | 1,892 |
| protocol | `trustline_closed` | 435 |
| protocol | `claimable_balance_offered` | 3,539 |
| protocol | `account_flags_changed` | 0 |

Direction: 309,628 in, 110,728 out; 708 self-payments (one "in" each). Per
account the file ranges from 5 to 187,313 lines, median 1,307; 39 of the
100 accounts have at most 35 lines in the month.

Drops by reason:

| Reason | Count | What it is |
|---|---|---|
| `sac_non_transfer` | 2,597,025 | `asset_balance_changes` entries of kind `mint`, `burn` or `clawback` in the 248,818 `invoke_host_function` records `/payments` returned; contract farming traffic, outside the three channels |
| `effect_ignored` | 1,048,352 | effects of types the protocol channel does not map: `account_credited` 516,605, `account_debited` 336,325, `trade` 193,217, `liquidity_pool_trade` 1,109, `claimable_balance_claimed` 344, sponsorship effects 440, `contract_credited`/`contract_debited` 291, the rest under 10 each |
| `memo_non_text` | 30,734 | transactions whose memo is not `text` (type `none`, `id` or `hash`); the counter does not split by type |
| `not_followed` | 118 | Soroban transfer entries between two contract addresses in an invocation the followed wallet took part in |
| `trustline_updated_skipped` | 36 | contract rule: `trustline_updated` yields nothing in v0 |
| `memo_empty` | 15 | text memos of length zero |
| `failed_transaction` | 0 | records of a transaction Horizon returned with `transaction_successful: false`; the reader refuses them before they reach a stream. The counter is absent from this run's file, so the count is zero |

Identities that hold on the counters. They are structural, not a property of
this particular run: for each of the three streams the run asserts
`records_read.<stream> == written.<stream> + dropped.<stream>` at exit, and a
stream that does not balance aborts the run with `IdentityError` and exit
code 3 instead of producing a report (spec 13.3). Every record read into a
stream therefore ends as a written observation or as a drop with a reason
from the stream's closed list, and a resumed line — an observation the file
already held — counts as written, because it exists.

- **payments** 420,474 = 420,356 written + 118 dropped. The reasons that can
  enter `dropped.payments`: `not_followed` (118 here), `invalid_account_id`,
  `validation_failed`, `duplicate_key_in_run` (none here). `sac_non_transfer`,
  `failed_transaction`, `unsupported_type`, `sac_no_entries` and
  `amount_missing` are counted by the reader, before the record is read into
  the payments stream, so they say what Horizon returned and the indexer
  refused and sit outside this identity by construction. The list used to
  stop after the first two, which left `unsupported_type` documented nowhere
  although the code has always emitted it.
- **memos** 251,417 = 220,668 written + 30,749 dropped. The reasons that can
  enter `dropped.memos`: `memo_non_text` (30,734), `memo_empty` (15),
  `invalid_account_id`, `validation_failed`, `duplicate_key_in_run` (none).
- **effects** 5,902 = 5,866 written + 36 dropped. The reasons that can enter
  `dropped.effects`: `trustline_updated_skipped` (36), `invalid_account_id`,
  `validation_failed`, `duplicate_key_in_run` (none). `effect_ignored` is
  counted by the reader before the effects stream, like `sac_non_transfer`
  above.

Two reasons in `DROP_REASONS` are **reserved, not measured**, and this report
used to print one of them as a zero: `claimable_creator_unresolved` waits for
a channel that needs a claimable balance's creator rather than its claimant,
and `muxed_base_address` was superseded when muxed addresses began resolving
to their base with the id carried in `namespace.muxedId`. No code path emits
either, so "0" said the run met none where the truth is that none can occur.
They are listed in `RESERVED_DROP_REASONS` now, next to the reason they are
reserved.

`retries` 1, `page_limit_reduced` 1, `retention_refusals` 0.

## 4. Open points seen in the data

One line per open point of spec section 12, with what the run showed:

- **Soroban transfers.** 173 transfer entries involved the followed wallets:
  55 became `sac_transfer` observations (USDC 22, XTAR 9, AQUA 9, XLM 7, SHX
  4, XRP 2, PYUSD 2), 118 were contract-to-contract legs. In 16 of the 39
  (wallet, invocation) pairs the wallet had two movements in one invocation;
  the old summing rule would have folded those into one key, which is why
  the ref rule changed on 2026-09-15 (`op:<id>#<index>`). A contract address
  on the other side was dropped as `invalid_account_id` until the same day
  (173 drops in the first full run); a contract is a valid counterparty.
- **Memo ref `tx:<hash>`.** Held: 220,668 content observations, one per
  (transaction, wallet), no key collision with the volume observations of
  the same operations.
- **Non-text memos.** 30,734 of 251,417 transactions (12.2%); the counter is
  one reason and does not split `none` from `id` and `hash`, which the
  report would read better with (deferred).
- **Muxed.** 1 record in 420,474; below anything the backtest could have
  measured. Not a real-traffic concern for these accounts in this month.
- **`account_flags_updated`.** Not seen once; the `account_flags_changed`
  kind and its `event` value stay untested by live data.
- **`duplicate_key_in_run`.** 0, and this one is measured: the code emits it.

## 4a. Traps met during the run, not in the brief

- **A dropped connection.** The first 100-account run died after twelve
  accounts on a network-level `fetch failed`; the client retried only HTTP
  429 and 5xx. Network errors are now retried on the same ladder.
- **Horizon 503 as "query too slow", not "service down".** For a hot
  account, `/accounts/{id}/payments?limit=200&join=transactions` exceeds
  Horizon's query timeout (about ten seconds) and answers 503 on every try;
  `limit=50` with the join answers in 1.5 s. The client now halves the page
  on a 503 (floor 25) before running the retry ladder, and counts
  `page_limit_reduced`.
- **A resume that truncated.** Resuming a range reopened the output file
  with the write flag and discarded the completed accounts' lines; a resume
  now appends and only `--force` rewrites.
- **An interrupted account left its partial lines behind.** Resume appends
  and re-processes the interrupted account from its start, and the run that
  produced the numbers above wrote those first partial lines a second time:
  the old-code file had three accounts written twice (state is saved after
  an account's lines are flushed, never mid-account). The delivered file is
  the forced run, which is why the duplicates are not in it, and the key-set
  comparison is what would have shown them. The code no longer depends on
  either: a resumed run loads the output file's key set before it starts and
  skips an observation the file already holds, counting
  `resumed_line_skipped`; `duplicate_key_in_run` keeps its meaning, a key
  this process produced twice.
- **The retry ladder as a flag.** `--max-retries` defaults to 8 on the CLI
  (about ten minutes of backoff) since a minute-long public-Horizon outage
  is ordinary.

## 5. Limits

- Reads the SDF public Horizon: about a year of history, moving retention
  wall, end-of-life announced without a date. The reader is behind
  `SourceReader`; the second backend is chosen when SDF announces a date
  (issue #3).
- The followed accounts are chosen by the rule above, not by a pilot's real
  counterparties.
- A Soroban invocation yields one `volume` observation per transfer entry
  the followed account is party to, ref `op:<id>#<index>` (contract ruling of
  2026-09-15 on issue #3: a ref names a value movement, not an operation).
  Entries of kind `mint`, `burn` and `clawback` are counted
  `sac_non_transfer` and not observed.
- `sac_no_entries` and `amount_missing` did not exist when this run was
  made and so appear nowhere in its counters. The first names an
  `invoke_host_function` record whose `asset_balance_changes` is absent or
  empty: it was counted as read and then produced neither observation nor
  drop. The second names a payment-family record arriving without its
  `amount`, which `?? "0"` turned into an observation of a zero-value
  movement — written, and counted as coverage. **Whether this run contained
  either shape is not knowable from its counters**, so the coverage ratio
  below is an upper bound until a re-run reports the two reasons.
- Both deduplication figures — this section's and section 3's — were
  measured with the second run served from the page cache (8,780 cache hits,
  2 live requests). They establish that the pipeline maps identical input to
  identical keys, which is what contract section 1's re-run test asks for.
  They do **not** establish that Horizon returns the same records twice for
  the same closed range: that question needs a second run with the cache
  cold, and it has not been run.
- Memos are recorded for `text` memos only.
- Effects other than trustline, claimable-balance-claimant and account-flags
  are ignored by design and counted.

## 6. Source boundary (acceptance row "Kaynak sınırı", brief rev. 4, section 7)

The claim, as narrowed on issue #3 and in the brief: the Horizon dependency
is limited to three items, the thirty-day backfill, the `protocol` channel,
and an outage longer than seven days. It is not a permanent architectural
dependency. What each item rests on:

| Item | Why Horizon, and what replaces it | Source |
|---|---|---|
| Backfill (thirty days and older) | RPC keeps seven days of history for `getEvents` and `getTransactions`; older ledgers come from Horizon today (about a year, moving wall) or from the data lake (`getLedgers` reaches genesis) | `developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents` (retention), `developers.stellar.org/docs/data/apis/rpc/admin-guide/data-lake-integration` |
| `protocol` channel | Trustline open and close, claimable-balance claimants and account-flag changes are not among the CAP-67 unified events (`transfer`, `mint`, `burn`, `clawback`, `fee`, `set_authorized`); forward reading needs `getTransactions` plus ledger-meta parsing, which is not built | CAP-0067; `developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/events` |
| Outage longer than seven days | The forward reader polls `getEvents` inside the seven-day window; a longer gap is filled from Horizon or the data lake | same retention page |

`volume` and `content` can be read forward from RPC: classic `payment`,
path payment and `create_account` operations emit a `transfer` event under
the asset's SAC address since Protocol 23 (`developers.stellar.org/docs/build/guides/transactions/send-and-receive-payments`,
"Monitoring Payments as event stream"), with the transaction memo and the
muxed destination in the event metadata. The forward reader is not part of
this delivery (issue #3, rule 4: no second implementation before SDF
announces a sunset date); this delivery reads Horizon through the
`SourceReader` seam and the root gate `gates/no-horizon-outside-reader.test.ts`
keeps every Horizon type inside `packages/indexer/src/horizon/`.

**Provider check, classic events (measured 2026-09-15).** Classic events are
off by default (`EMIT_CLASSIC_EVENTS`, migration page
`developers.stellar.org/docs/data/apis/migrate-from-horizon-to-rpc`). Measured
with `getEvents` on the native asset's SAC contract, topic `transfer`, over
the last 200 ledgers, then each sampled event's transaction looked up on
Horizon to see whether the movement came from a classic operation or a
contract call:

| Provider | Protocol | `transfer` events in 200 ledgers | Sampled | From classic operations |
|---|---|---|---|---|
| SDF testnet RPC (`soroban-testnet.stellar.org`) | 28 | 50 (page cap) | 12 | 7 |
| `mainnet.sorobanrpc.com` | 27 | 50 (page cap) | 12 | 12 |

Both providers emit classic events. The check is a script, not a gate: it
must be repeated for the mainnet provider the shadow mode will actually use,
on the day that provider is chosen.

