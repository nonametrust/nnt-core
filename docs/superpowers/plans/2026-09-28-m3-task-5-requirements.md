# M3 Task 5: what the brief must be built on

> **EXECUTED, 28 September 2026.** Commits `ad5a3fe`..`a9bc1a6`. Counts after:
> schema 117, tagging 329, indexer 122, store 532, **engine 384**, root gates 64 —
> the "state Task 5 starts from" block below is therefore pre-execution and is left
> as it was written.
>
> **Four things in this file turned out to be wrong, and the ledger says why:** the
> `effects` tuple (R51 — it makes R24's inconsistency typecheck), `policies` as four
> versions (R52 — it needs the objects), "`listLive` needs an upper bound" (R54 — its
> `since` is a LOWER bound, so the exclusion is engine-side), and the `Reason` shape,
> which had quietly dropped `evidenceKind` from R13's clear columns. The core also
> takes a narrow read port rather than repositories (R50).
>
> **Read `docs/superpowers/ledgers/2026-09-27-m3-decisions.md` sections "Task 5" and
> "Task 5's review round" before trusting anything below.** R60 in particular: the
> lowered threshold underflows to zero and the brief used to throw rather than grade.

> **Why this file exists.** Task 5's text in
> `docs/superpowers/plans/2026-09-27-m3-sync-path.md` was written before Tasks 1-4
> ran and before four review rounds. Seventeen rulings the plan does not have (R33-R49)
> now constrain it, four of them change its shape, and two make its acceptance
> criteria unbuildable as written. This file is the delta: read the plan for
> R1-R32 and the general constraints, read this for what changed and why.
>
> **Where this file and the plan disagree, this file is newer and says why.** The
> full reasoning with measurements is in
> `docs/superpowers/ledgers/2026-09-27-m3-decisions.md`; this is the implementable
> summary.

## The state Task 5 starts from

Branch `m3-sync-path`. Counts: schema 117, tagging 329, indexer 122, store 532,
engine 190, root gates 64. Green under `Pacific/Kiritimati`, `Etc/GMT+12`,
`America/St_Johns`, a changed database session timezone, and `LC_ALL=tr_TR.UTF-8`.

Already in `packages/engine`: `policy.ts` (`BriefPolicy`, ten fields),
`relatedness.ts` (`relatedness`, `relatednessCase`, `clearsRelatednessFloor`,
`isReason`, `TagFacts`), `grade.ts` (`GRADES`, `gradeFor`),
`composite-version.ts` (`compositePolicyVersion`), `ids.ts` (`IdSource`), and
three gates.

Already in the store, added by Task 2 for this task: `openDb` and the `Db` type
exported; `readClear(observationId)`; `BaselineRepository.upsert(state,
expectedCount)` raising `BaselineStale`; `TriggerEventRepository.record` taking
`triggerId` and `at`; `readonly clock` public on six classes.

## The four rulings that change Task 5's shape

**R39 — one predicate decides both what lowers the threshold and what the brief
may cite.** `isReason(tag, intent, policy)` requires `strength >= activeFloor` AND
`relatedness >= relatednessFloor`. Use it for both; do not compute the lowering
set separately. Consequence for Task 6: `thresholdFor` cannot be intent-free, so
design §6's "the engine exposes the current threshold as a query" either goes or
becomes a second query no brief uses.

**R40 — the intent's reading is carried from `observe`, not decrypted in the
core.** Relatedness needs the intent's `(channel, aspect)`; `readClear` returns the
channel and not the aspect. Opening the payload to get it means a brief cannot be
replayed after the month expires, which would undermine R13. So `observe` returns
the derived reading and `brief` takes it.

**R41 — R22's filter is on the tags the intent TOUCHED.** A refresh keeps the
opening observation's `observation_id`, so filtering on that id lets a tag the
intent itself refreshed lower the intent's own threshold. `observe` returns the tag
ids it opened OR refreshed; `brief` takes them as `ownTagIds`.

**R42 — R1's determinism is "the same inputs AND the same store state".** A
refresh overwrites `g0`, `tagged_at`, `refresh_count` and `saturation_state` and
keeps no history, so a past `at` cannot be reconstructed by any filter. G10's two
runs must not write between them, and a reason's `refreshCount` at a past `at` is a
post-refresh value.

## What Task 5 must build

1. **A composition root.** `compose(handle, clock, ring, retention)` where `handle`
   is a `Db` **or a `Transaction`** — Task 8 rebuilds repositories per transaction
   under R10. Returns every repository. Two tests: each one's `clock` is `===` the
   one object, and a lexical rule refusing `new *Repository(` / `new AuditChain(`
   outside that module, with an "exemption is doing work" pair. `HotWindowRepository`
   takes no clock and is correctly absent from the identity check.
   *This closes the gate §3 and §8 require and that the plan gives to no task: 7 of
   8 repository classes take an unchecked clock, and §8's claim that the store
   refuses a foreign one is false.*

2. **The brief core**, pure. **THE WHOLE SHAPE IS HERE**, because a review
   assembling it from the plan and five ledger entries had to guess — the plan's
   input is stale (it predates R39-R42) and `ownTagIds` appears once in the entire
   docs tree.

```ts
interface BriefInput {
  at: Date;                      // the wrapper's clock.now(); the core never reads one
  briefId: string;               // from IdSource, minted by the wrapper (R1)
  triggerId: string;             // likewise
  intent: Related;               // carried from observe (R40): namespaceId, channel, aspect
  observationId: string;         // the intent's own, for readClear and R22
  amount: number;                // R8; 0 admissible, negative refused
  unit: string;                  // refused unless === policies.brief.thresholdUnit (R27, R44)
  riskTier: "low" | "medium" | "high";   // refused at runtime too (R45)
  ownTagIds: readonly string[];  // tags this intent opened OR refreshed (R41)
  surprise: number | null;       // from observe; null => no trigger effect (R18, R29)
  policies: { retention; tagging; calibration; brief };  // four versions, R26
}

interface BriefOutput {
  grade: Grade;                                  // clear | watch | hold (R38)
  reasons: readonly Reason[];
  threshold: { base: number; applied: number; loweredBy: readonly string[] };  // R39
  effects: readonly [TriggerToRecord?, AuditBodyToAppend?];  // in that order (R1)
}

interface Reason {
  tagId: string;
  observationId: string;         // the tag's OPENING observation (R30)
  channel: string;
  aspect: string;
  datedAt: Date | null;          // null for a state (R19)
  strength: number;              // strengthAt(tag, at), from the store
  relatedness: number;
  relatednessCase: RelatednessCase;
  refreshCount: number;          // R30; a post-refresh value at any past at (R42)
  source:
    | { code: "SOURCE_PRESENT" }
    | { code: "SOURCE_UNREADABLE"; periodExpired: boolean; namespaceErased: boolean };
}                                // no source.ref in M3 (R47)
```

   Two notes the types cannot carry. `loweredBy` is redundant with
   `reasons[].tagId` under R39 — they are the same set — and a test should assert
   that equality rather than let the two drift. And `surprise` is `null` rather than
   recomputed because it lives only on `trigger_event`, the tag row has none, and
   recomputing it would judge against a baseline that already holds the intent's own
   fold, which R10 forbids.

   The effects are existing store types: `TriggerToRecord` is
   `RecordTriggerEvent` (which already takes `triggerId` and `at`) and
   `AuditBodyToAppend` is `AuditEntryInput`, whose `kind` is `"brief"` and whose
   `policyVersion` is `compositePolicyVersion(...)`. `occurredAt` is stamped by the
   chain and cannot be carried, which is why the body holds `at` itself.

3. **A thin wrapper that performs the effects**, and is the supported entry point.
   It reads `at` from the clock and mints ids; the core does neither.

4. **The gates the ledger lists, with what each needs.**
   - **R25 must be a WHITELIST at every depth, not a blacklist.** `AuditChain.append`
     accepted `{ payload, source, evidence: { ref } }`; a `payload`/`source` key
     check passes `evidence.ref`. Closed body type plus a runtime whitelist over the
     rendered canonical JSON (`canonicalForm` is exported).
   - **`at === clock.now()` is plantable and must be gated in the wrapper.** `record`
     bounds only the future (R34) and `AuditChain.append` stamps its own
     `occurredAt`; measured with `at = now − 3d`, the trigger landed at day 8 and the
     audit row at day 11 with no error. Rule it: the replay entry point performs NO
     effects.
   - **R14 needs an observer.** "Before any tag is read" cannot be seen from outside;
     count `listLive` calls. The refusal can only name a uuid, so the check sits on
     the first read, `readClear(intentObservationId)`, whose `namespaceErased` flag
     is what it acts on. A brief on an erased namespace is refused WHOLE, not served
     as `SOURCE_UNREADABLE` reasons.
   - **G10's replay test must advance the clock between runs** and must not write
     between them (R42).
   - **G9's "the core writes nothing"** by comparing every table's `xmin` before and
     after. `db.selectFrom(...).select(db.dynamic.ref<string>("xmin"))` works;
     `db.dynamic.ref("xmin as xmin")` does not — kysely quotes the whole string.

5. **`listLive` needs an upper bound on the instant.** `strengthAt` returns `g0`
   for every non-positive elapsed, so a tag stamped after `at` reports full
   strength. Exclude `taggedAt > at` — necessary, and not sufficient (R42).

## What is already settled and needs no work

- **`maxReasons` is NOT needed** and §7's cap question dissolves. Measured at 200
  reasons: `listLive` 0.8 ms, `readClear` ×200 24 ms, `get` ×200 46 ms sequential
  and 33 ms parallel. Round trips dominate, not AEAD, and the one-to-two-second
  budget is about forty times away. What remains to decide is whether M3's reason
  carries `source.ref` at all, since that lives inside the payload and is the only
  thing needing a `get`.
- **A DB-backed engine test needs no gate change.** `kysely` and the store's test
  harness are both refused in engine test files, and the store's public surface
  alone suffices: `openDb(base).schema.createSchema(...)`, `migrate(db, <store
  migrations path>)`, and `.dropSchema(...).cascade()`.
- **`IdSource.next()` suffices** — two ids per brief; the audit `seq` is
  DB-assigned.
- **`AuditChain.append` can carry what R25 requires**, and `policyVersion` is the
  R26 composite, which `compositePolicyVersion` now builds and refuses.

## Settled since this file was first written (R43-R49 in the ledger)

- **The reason carries a CODE and no `source.ref`** (R47), with three measured
  reasons. Outward-facing: design §6:270-273 says each reason carries its sources,
  and in M3 it carries a code and the clear columns.
- **An intent with more than one reading is REFUSED by name** (R46).
  `cluster_proximity` yields two, so it cannot be briefed in M3 — also
  outward-facing.
- **Task 5 computes the threshold AND performs the unit refusal** (R44); Task 6
  becomes the intent-scoped query and its consistency test.
- **`riskTier` is `"low" | "medium" | "high"`, refused at runtime** (R45), because
  the value is hashed forever.
- **The audit body is a closed type whose whitelist WALKS the object** (R48), and it
  admits the named numbers a grade cannot be recomputed without.
- **The `taggedAt > at` exclusion stands** (R43).
- **R49 is owed before Task 6, not Task 5:** a lexical gate refusing `.activeFloor`
  and `.relatednessFloor` outside `relatedness.ts` and `policy.ts`, because nothing
  else stops Task 6 lowering the threshold by strength alone.

## Open questions this task still inherits

- **§7's grade vocabulary is provisional.** `clear | watch | hold` with R38's rule.
  Kerem has a veto and has not exercised it.
- **R12's other fifth cases** are stated limits, not rulings: unnormalised aspect
  strings (`usdc` against `USDC` are two aspects) and compound aspects with no
  partial-match term. Both M4's.

## Non-negotiables carried from the plan

§3's constraints all still apply. In particular: the engine computes nothing a
decision depends on; every refusal names its field or class; assert a refusal's
message and not only its class; override every `BriefPolicy` field in at least one
test with a number no other field shares; and §3b's mutation step is not optional —
after green, remove each rule one at a time and record WHICH test goes red.
