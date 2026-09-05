# MVP v0 core engine — design

Date: 2026-09-05
Target: repo tag `v0`, end of September 2026
Status: design approved, spec under review

## 1. What v0 is, and what it is not

v0 is the smallest engine that runs the Section 9 scenario of the whitepaper
honestly, with the real mechanism rather than mocks. Its single acceptance
claim is one sentence: *a sub-threshold observation made on day twelve is
retrieved, with its original timestamp, by a brief requested on day
twenty-one.* That sentence is an executable test, not prose.

v0 is not v1.0. D1.1 of the SCF milestone plan (core engine v1.0, Apache-2.0,
published to npm, at least 300 tests) is a Tranche 1 deliverable and is
deliberately wider than this.

### In scope

- The `observe` and `brief` surface, transport-agnostic.
- Postgres limbo store and permanent store.
- Rule layer plus Welford/MAD baseline tagging.
- Strength-dependent decay, per channel, computed rather than stored.
- Nightly consolidation with the capture competition and graded promotion.
- Hash-chained audit log with a daily root.
- The day-12 / day-21 scenario as the acceptance test.

### Out of scope, with reasons

| Excluded | Reason |
|---|---|
| Language-model referee for ambiguous content | Section 4 assigns it to a batch pass over ambiguous cases only. The acceptance scenario never reaches it. The tagging pipeline carries the seam. |
| Fleet-wide consolidation broadcast (Section 5.1) | The milestone plan places the fleet pipeline in Tranche 3. Trigger grades and `cluster_id` are in the schema regardless, so enabling it later is not a migration. |
| Embedding proximity in relatedness | Heavy dependency, no measured contribution yet. Entity graph and aspect matching carry v0 behind the same `rel()` interface. |
| On-chain Merkle anchoring | Tranche 3, and it needs an audited Soroban contract. v0 computes and stores the daily root and leaves the anchor call as a seam. |
| Learned channel weights | Learning needs labelled production data that does not exist. v0 ships an initial weighting derived from the measured study table, marked provisional. |

## 2. Architecture

Two paths, separated because rescue that runs only in an offline job misses the
moment of decision.

**Synchronous retrospective recall.** `brief` re-reads and re-weighs the live
tags for one decision. Latency target one to two seconds. Called only for
above-threshold intents.

**Asynchronous capture.** The nightly job decides which observations outlive
the bounded window at all. Recall serves the current authorization; capture
serves every future one.

### Packages

| Package | Contains | Depends on |
|---|---|---|
| `schema` | A0 observation types, per-channel validators, golden fixtures | nothing |
| `store` | Postgres schema, migrations, repositories | `schema` |
| `tagging` | baselines, rule layer, surprise to `g0`, thresholds | `schema` |
| `engine` | `observe`, `brief`, relatedness, nightly consolidation | `store`, `tagging` |
| `nonametrust` | the `TrustMemory` facade of Section 9 | `engine` |

The `schema` package depends on nothing and is publishable on its own. That is
deliberate: it is the entire surface the Stellar indexer needs, so the
indexer's dependency on the engine is one package and one version.

### Cross-cutting rules

- **TypeScript and Node.** Fixed by the Section 9 code sample and by D1.1's
  npm requirement.
- **Postgres only.** No Redis in v0. Correctness is the constraint, not scale.
- **Decay is computed, never stored.** A tag's strength at any instant derives
  from `g0`, elapsed time and the channel half-life. No background writer
  updates strengths, so the nightly job is the only writer and any historical
  strength is reproducible from the audit log.
- **The clock is injected.** `Date.now()` does not appear inside the mechanism.
  Without this the day-12 / day-21 test cannot exist, because twenty-one
  simulated days must run in milliseconds.
- **Observations are append-only.** Every decision derives from observations
  plus a policy version, and history replays deterministically.
- **Suppression is accelerated decay, not deletion.** Required by the protocol
  brief.

## 3. The observation schema (A0)

This is the contract between the indexer and the engine, and the only thing the
indexer imports.

```ts
type Channel =
  | "address_integrity"
  | "latency"
  | "price"
  | "protocol"
  | "volume"
  | "cluster_proximity"
  | "content";

type EvidenceKind = "event" | "state";

interface Observation {
  observationId: string;      // engine-assigned, uuid v7
  idempotencyKey: string;     // deterministic from source; unique
  schemaVersion: string;

  namespace: NamespaceRef;
  channel: Channel;
  evidenceKind: EvidenceKind;
  kind: string;               // source event type, e.g. "payment"

  observedAt: string;         // ISO 8601 UTC; events
  validFrom?: string;         // states
  validUntil?: string | null; // states; null means still holding
  ingestedAt: string;         // engine-assigned

  source: Source;
  payload: unknown;           // channel-specific, validated per channel
  salienceHints?: SalienceHints;
  signature?: string | null;  // present in v0, unverified in v0
}
```

This interface is the **stored form**, after ingest. The code carries two types
under `packages/schema`: `Observation`, the stored form, in which the
engine-assigned fields are optional in the type because they are absent until
ingest runs; and `WireObservation`, the wire form a producer's mapper returns,
in which `observationId` and `ingestedAt` do not exist and the validator refuses
them, while `idempotencyKey` may be present only if it equals the derived one.
The payload is typed as a record in the code rather than `unknown`, because the
validator requires an object; `payload: unknown` here means only that the
envelope does not know the shape, the per-channel validator does.

```ts

interface NamespaceRef {
  kind: "wallet" | "domain" | "endpoint" | "merchant";
  id: string;
  continuity?: ContinuityAssertion;
}

interface Source {
  producer: string;         // bare name, "stellar-indexer"
  producerVersion: string;  // "0.1.0", deliberately a separate field
  network?: string;         // "stellar:pubnet"
  ref: string;              // Horizon operation id or paging token
  fetchedAt: string;
}
```

### Rulings

**Seven channels, not five.** The developer brief named five: address
integrity, latency, price, protocol, volume. Two of the study's six frozen
signals do not fit any of them. S1, dust from the operation cluster, is graph
proximity rather than a counterparty aspect. S6, memo anomaly, is free-text
content rather than a protocol event. Without `cluster_proximity` the fleet
consolidation of Section 5.1 has nothing to attach to, and the developer brief
itself warns that a schema closed too narrowly is rewritten together with the
indexer at calibration time.

**`kind` and `channel` are different fields.** `kind` is what happened at the
source. `channel` is which aspect it bears on. A single chain event may produce
several observations; each observation carries exactly one channel. This
matches the brief's mapper description, which speaks of one dimension per
observation.

**`event` and `state` are distinguished.** This comes from the audit. The
study's S3 is a standing condition, not a dated event: forty-six victims have
`found: true` with an empty distance list, and the analysis credited it to
every window including the seven-day one, while controls could not be measured
at all. The inflation was one-sided and moved the headline by three points. In
the engine, a state observation carries a validity interval, is refreshed while
it holds, and never enters timing analysis. Without this field the product
reproduces the same defect.

**Muxed addresses resolve to the base address.** The muxed identifier is stored
as an attribute of the namespace, never as the namespace. The brief left this
as "measure it"; the identity model of Section 5 settles it.

**The signature field exists and is unverified in v0.** The August brief
required signed observations; the September brief dropped the topic. The field
opens now so that enabling verification later is not a schema migration. In v0
the indexer runs in the same trust domain.

**`idempotencyKey` is deterministic from the source, and the producer version
is not part of it.** The key is derived from the producer's bare name, the
network, the source reference, the channel and the namespace, joined by a
separator no field can contain and which the schemas reject inside a field. Reprocessing the same range yields zero new
observations, which is the indexer's own acceptance criterion, and it is a
correctness requirement rather than a performance one: a duplicated trace makes
the tagging pipeline believe the evidence is twice as strong. The version is a
separate field because folding it into the producer name would change every key
the moment the indexer is upgraded, silently minting a duplicate of everything
already stored. The fetch time is excluded for the same reason. The network is
included because Horizon operation ids repeat across pubnet and testnet, and one
producer reading both is the expected configuration once the testnet demo runs
alongside mainnet shadow observation. The namespace is included because a
payment has two sides: one chain event yields an observation for the sender and
another for the receiver, and a key blind to the counterparty would discard the
second as a duplicate, losing one side's evidence with no error. The alternative
considered was a contract rule making the source reference differ per side, and
it was rejected because nothing would enforce it and nothing would complain when
it was forgotten.

**The engine never infers identity.** Continuity is an integration assertion,
recorded as provenance. Where no continuity is supplied, a new address opens a
new namespace under the cold-start prior.

## 4. Data model

| Table | Purpose | Notes |
|---|---|---|
| `namespace` | counterparty identity | encryption key per namespace, for crypto-shredding |
| `observation` | append-only evidence | unique on `idempotencyKey`; payload encrypted at rest |
| `baseline` | per `(namespace, channel, aspect)` | Welford state, median/MAD state, fast and slow estimators |
| `tag` | limbo entries | `g0`, `taggedAt`, channel, refresh count, saturation state; strength never stored |
| `trigger` | candidate, verified, harm-confirmed | tier for harm-confirmed, nullable `cluster_id`, surprise |
| `permanent_record` | promoted evidence | original `observedAt` preserved, `rescued_by`, confidence |
| `volatility` | per namespace | `q_hat`, mean-reverting |
| `hot_window` | forward window after a trigger | scaled by volatility |
| `audit_entry` | chained decisions | `prev_sha256`, entry hash, daily HMAC, policy version |

## 5. Tagging

A baseline per `(namespace, channel, aspect)`: Welford streaming mean and
variance, median and MAD for robust deviation, t-digest for heavy-tailed
quantities. Surprise is a robust z-score against that baseline. `g0` is a
calibrated function of the surprise and carries an uncertainty, so the same
deviation scores more cautiously for a counterparty with little history.

Three protections, all from Section 4:

- **Bounded influence.** An observation is winsorized at a multiple of MAD
  before it updates the baseline, so no single observation can shift it.
- **Two timescales.** A fast estimator is read against a slowly updated
  reference. An adversary cannot inflate variance faster than the divergence
  between the two exposes the attempt.
- **Noise-adaptive threshold.** Where a namespace's observed noise is high,
  `θ_tag` rises automatically.

Cold start is explicit. For continuous quantities no tag is produced below a
minimum observation count, and beneath it namespace statistics shrink toward a
fleet-wide prior for that kind of counterparty. Categorical events (an address
change, a new permission request, contact from a lookalike address) are
independent of any baseline and are taggable from day one.

Refresh under saturation: a repeated deviation on an already-tagged pair
refreshes rather than stacks. The new strength is the maximum of the decayed
current strength and the newly calibrated `g0`, plus a bounded increment that
saturates. This removes an attacker's ability to pump one tag to arbitrary
strength.

Precision and recall are allocated asymmetrically on purpose. Entry to the
limbo store is cheap and must not miss. Entry to the permanent store and
surfacing to the decision layer are expensive and run against a false-alarm
budget.

## 6. Synchronous path

`brief` is a pure function over the stores. No HTTP, no single call shape,
because the same core will later be wrapped by the library, the MCP server and
the x402 endpoint.

Flow: build the candidate trigger, read live limbo tags and recent permanent
records, keep those whose relatedness and decayed strength clear their
thresholds, note the trigger, and synthesize a graded brief. A candidate
trigger promotes nothing.

Output shape is fixed by the founder brief: a graded result, a list of reasons,
and source links. Structured and deterministic; error states are codes, not
prose. Each reason carries its channel, its original timestamp, its strength,
its relatedness and its sources.

Two behaviours attach here. An active tag lowers that counterparty's brief
threshold, and the engine exposes the current threshold as a query because the
policy module asks for it. When the memory service is unreachable, the failure
policy follows the intent's risk tier: low-stakes intents proceed and the
condition is logged, mid-tier intents proceed under a temporary amount cap, and
high-stakes intents are held for human approval, so degrading availability is
not a way to bypass the layer.

## 7. Asynchronous path

The nightly job takes a clock and a policy version. The same inputs produce the
same outputs and history replays deterministically.

For each verified trigger: update volatility with mean reversion; collect the
live tags inside the trigger's window; score each by capture strength, the
product of decayed tag strength, trigger salience, relatedness and a volatility
factor; lower the capture threshold in inverse proportion to volatility; take
the quota's worth of winners; promote them with their original timestamps, a
`rescued_by` link and a confidence proportional to the capture score; suppress
the unrelated by accelerating their decay; open the forward hot window; and
chain the outcome into the audit log. At the end of the pass, expired tags are
retired and the day's root is computed.

Trigger grades are load-bearing. A candidate trigger opens a brief and promotes
nothing. A verified trigger drives volatility updates and the nightly
competition. A harm-confirmed trigger additionally meets an evidence tier, and
only Tiers A and B would ever carry fleet publication rights. A Tier C report,
harm reported by a tenant, acts as an ordinary local trigger inside the
reporter's own namespace and never crosses it.

## 8. Calibration and provenance

Every number derived from the backtest lives in one calibration file, each with
the file and line it came from, and a test checks the file against the study.
If the audit moves a number, one file changes and the tests rerun.

Two entries need their status stated plainly.

**Limbo TTL.** The only defensible figure today is `ceil(d80)`, twenty-four
days, from the pooled distance distribution. It is provisional. The auditor
notes that the hit-weighted percentile is the wrong weighting for the product
question and that the subject-weighted curve is the right one; that curve is
W7's central figure and W7 has not started. The TTL's owner is W7, not d80.

**Per-channel half-lives.** Section 4 defines the tag time constant as a
channel parameter and Section 8.3 names per-channel decay learning as the
designated next analysis. That analysis does not exist. The study reports only
a pooled distribution, and the pooled figure is dominated by one channel: a
single victim record carries hundreds of S5 hits against single-digit S6 hits,
while S1, S2 and S4 fire in a small minority of victims. v0 therefore ships the
half-life as a per-channel parameter whose default is the pooled value for
every channel, marked in code and in documentation as not calibrated per
channel, pending D1.4. Inventing six different numbers would be exactly the
kind of unenforced claim this project has repeatedly found to be false.

**Mechanism parameters that the study does not speak to.** The relatedness
floor, the capture threshold and its volatility coefficient, the per-trigger
quota, the brief threshold and the factor an active tag applies to it, the
forward window length, and the minimum observation count before a continuous
channel may tag: none of these is derivable from the backtest, because the
backtest measured whether evidence exists, not how an engine should weigh it.
They live in a versioned policy file, separate from the calibration file, and
every audit entry records the policy version that produced it. Their v0 defaults
are chosen to make the Section 9 scenario behave as the whitepaper describes,
and that origin is written next to them. Tuning them against live traffic is the
shadow evaluation's job, and the champion-challenger arrangement the protocol
brief describes, two parametrizations scoring the same traffic side by side, is
what the policy version field exists to support.

**Channel weights.** Criterion 3 failed because the control base rate reached
47.5%, and the audit diagnosed the cause: the broad channels S5 and S6 fire
abundantly in controls and account for nearly all of that base rate, while the
targeted channels S1, S2 and S4 barely fire. Combining channels by OR is
therefore not available. v0 scores channels continuously with an initial
weighting derived from the measured per-channel table, weighted by precision
rather than by raw difference, and marked provisional.

## 9. Acceptance criteria

**The scenario test.** Forty counterparties receive small payments each
morning. On day twelve a frequently used data provider's payment address
changes once and reverts; the observation is sub-threshold, lands in limbo and
alerts nobody, while the live tag lowers that provider's brief threshold. On
day twenty-one the same provider requests a five hundred unit authorization and
the policy layer calls `brief` before signing. The test asserts that the brief
returns `hold`, that its reasons include the address change carrying its
original day-twelve timestamp, and that the call completes inside the latency
budget.

**Locality tests.** An unrelated counterparty's tags are not promoted by a
trigger. A namespace holding no related tags receives nothing from a trigger.

**Determinism test.** The nightly job over a fixed corpus and policy version
produces an identical audit chain on a second run.

**Idempotency test.** Feeding the same source event twice yields one
observation.

**State-channel test.** A state observation never appears as a dated hit and
never enters a timing computation.

## 10. What could still move

The audit is roughly a third done and two of its results bear on this design.

The headline was reproduced exactly, with zero discrepancies, and the timing
failure of criterion 4 was confirmed to the digit, so the long-window design
stands. What remains open is the expression of uncertainty: merging the
operation addresses through shared victims collapses forty-four clusters to
twenty-seven and drops the effective count to roughly two and a half, and the
auditor's own caveat is that at that count the percentile bootstrap is itself
unreliable. The coverage simulation that would settle it, W3.4, has not run.

None of that touches the mechanism. It touches the numbers and the language of
the claim, which is why every number in this design carries its provenance and
why none of them is compiled in.
