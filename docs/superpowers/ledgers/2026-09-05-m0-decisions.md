# M0 decision ledger

The rulings made while milestone M0 was executed, in the order they were made.
Kept because the reasoning is richer than the commit messages that carry the
outcomes, and because this project's discipline is that a decision nobody can
read is a decision made in secret.

# SDD ledger — plan: docs/superpowers/plans/2026-09-05-mvp-v0-core-engine.md

Spec: docs/superpowers/specs/2026-09-05-mvp-v0-core-engine-design.md (read)
Scope this run: milestone M0 only, tasks 1 through 7.
Branch: feature/mvp-v0. All subagents on model fable.

Ruling: work on branch `feature/mvp-v0` in the primary working directory
rather than a separate worktree — the repository holds no other work to
isolate from, and a second path would confuse the human partner, who will
open ~/Desktop/firma/nnt-core to read the result. Cost if wrong: none
beyond a branch that must be merged rather than a worktree removed.

## Pre-flight conflict scan

Pairs sharing a file or an interface:

| Pair | Produced vs consumed | Finding |
|---|---|---|
| T1 → T2..T6 | workspace and `@nonametrust/schema` manifest vs every `src/*.ts` | clean; every later file lands under the package T1 creates |
| T2 → T4 | `channelSchema` vs `observation.ts` import | clean |
| T2 → T5 | `type Channel` vs `deriveIdempotencyKey` signature | clean |
| T2 → T6 | `CHANNELS`, `type Channel` vs `BY_CHANNEL` record and fixture test | **conflict, ruled below (duplicate export)** |
| T3 → T4 | `namespaceRefSchema`, `sourceSchema` vs the observation envelope | clean |
| T3 → T5 | `type Source` with `producerVersion` vs key derivation | clean; the key reads `producer` and `ref` only, which is the point of the split |
| T3 → T6 | `sourceSchema` regex vs fixture `producer` values | clean; every fixture uses the bare name `stellar-indexer` |
| T4 → T5 | none | clean; `idempotency.ts` imports types only |
| T4 → T6 | `observationSchema`, `type Observation` vs `validateObservation` | clean; the envelope parses first, the payload second |
| T4 → T6 | `.strict()` envelope vs `validateObservation` spreading `idempotencyKey` onto the result | clean; `idempotencyKey` is a declared optional key in `common`, so strict mode admits it |
| T5 → T6 | `deriveIdempotencyKey(Source, Channel)` vs its call site | clean |
| T6 → T7 | the public surface vs the contract document | clean |

Each task against itself:

| Task | Finding |
|---|---|
| T1 | clean; the manifest it writes is the one every later task builds |
| T2 | clean; the test asserts the seven-channel order the implementation declares |
| T3 | clean; the source regex rejects exactly the string the test rejects |
| T4 | **conflict, ruled below (discriminated union member)**; otherwise the tests match the schema, both arms of the union are exercised, and `datedAt` is the only date reader |
| T5 | clean; six tests cover stability, version independence, fetch-time independence, and the three axes that must differ |
| T6 | clean; every channel has a validator, a fixture and a test that walks `CHANNELS` rather than a hand-written list, so adding a channel later fails loudly |
| T7 | clean; prose and push only |

Ruling: `z.discriminatedUnion` accepts `ZodObject` members only, and the
plan's `stateSchema` ends in `.refine(...)`, which yields a `ZodEffects` and
throws at schema construction — every test in tasks 4 and 6 would fail before
asserting anything. The interval check moves to a `.superRefine` on the union
itself, which is legal because the wrapper may be a `ZodEffects`. Behaviour is
unchanged: a state whose `validUntil` precedes its `validFrom` is still
rejected, which is what the test asserts. Cost if wrong: the state interval
goes unchecked, and a malformed validity window reaches the store.

Ruling: `payloads.ts` re-exports `CHANNELS`, and `index.ts` already re-exports
it from `channel.ts`, so `export * from` both files collides on one name and
the package fails to typecheck. The re-export is dropped from `payloads.ts`;
`channel.ts` remains the single origin. Cost if wrong: none, the symbol is
reachable either way.

Note: `evidenceKindSchema` is exported by task 2 and no other module imports
it, because task 4 discriminates on `z.literal` instead. It stays exported and
is not dead code — it is part of the contract the indexer validates against.
Not a finding.

## Progress

Ruling: the plan pins `packageManager: "pnpm@9.12.0"`, but the machine has
pnpm 10.14.0 and Node 24.1.0. Corepack would fetch 9.12.0 on every command,
which needs the network and buys nothing. The pin becomes `pnpm@10.14.0`, and
the CI action reads its version from `packageManager` rather than hardcoding a
major. Node stays at `>=22`, which 24.1.0 satisfies, and CI still installs 22
so the floor is exercised rather than assumed. Cost if wrong: a lockfile
written by pnpm 10 that a pnpm 9 CI would refuse, which CI would surface on the
first push rather than silently.

## Task 1: dispatched (base 71ca50d)
## Task 1: implementer returned DONE_WITH_CONCERNS (commits 71ca50d..fe1474c), three deviations, review dispatched.

Ruling: the implementer replaced the planned `src/.gitkeep` with
`src/index.ts` holding `export {};`, because TypeScript errors TS18003 when a
project matches no input files and a .gitkeep is not an input. Accepted. Task 6
overwrites this file with the real public surface, so the placeholder lives for
five commits. Cost if wrong: none, the file is replaced by design.

Ruling: `--passWithNoTests` was added to the schema package's test script so
the bootstrap commit does not leave CI red. Accepted for this commit only, and
## Task 2 must remove it in the same commit that lands the first test. The flag's
real danger is not today's empty package but a later silent break in test
discovery reporting green over zero tests, which is precisely the kind of
unenforced claim this project has repeatedly found to be false. Carried into
the Task 2 dispatch. Cost if wrong: a window of one commit in which an empty
suite passes.

Ruling: a `license` field was added to the root `package.json`, which the
brief's verbatim JSON omitted. Accepted; the global constraint asks for
Apache-2.0 on every package and the root is a package. Cost if wrong: none.
## Task 1: review returned spec met except the test-script flag, quality approved with 3 Important and 5 Minor. Rulings below; no fix loop.

Ruling: the reviewer marks `--passWithNoTests` a spec miss and says the
implementer's "can stay or go" is wrong. Agreed on the danger, and the earlier
ruling stands rather than opening a fix round: removing it inside Task 1 leaves
a commit whose CI is red because no test exists yet, and Task 2 lands the first
test in the very next commit. Task 2 removes the flag in the same commit as the
test. Cost if wrong: one commit in which an empty suite reports green.

Ruling: the build tsconfig has `include: ["src"]` and no `exclude`, so the
first `*.test.ts` under `src/` would be compiled into `dist/` and ship as part
of the package's public surface, with declaration files for tests. This lands
in Task 2, not later. Task 2 splits the configuration: the build config excludes
test files, a second config includes everything for typecheck only. Typecheck
coverage of the tests is preserved, which a bare exclude would have lost. Cost
if wrong: tests ship inside the published package.

Ruling: amend the Global Constraints to add `isolatedModules: true` to
`tsconfig.base.json`. The reviewer notes that vitest transpiles per file and
cannot tell a type re-export from a value one, so a type exported without the
`type` keyword fails at module link time rather than at compile time. This
project's whole discipline is that a property nobody enforces turns out false,
and `isolatedModules` is that property's gate. Task 2 adds it. Cost if wrong:
none; it only forbids what already breaks at runtime.

Ruling: `@types/node` is absent and Task 5 imports `node:crypto`, so it would
fail to typecheck two tasks from now. Task 2 adds it to the schema package's dev
dependencies rather than waiting for the failure. Cost if wrong: an unused dev
dependency.

## Task 1: deferred (Important): CI has no build step while the package resolves
through `dist/`, so the first package that imports `@nonametrust/schema` fails
on a fresh checkout. Cannot bite inside M0, which has one package. Carry into
the M1 plan, whose first act is a second package.
## Task 1: minor (deferred): CI runs every pull request twice, has no permissions
block, and pins actions to major tags rather than commit SHAs.
## Task 1: minor (deferred): the Node floor in CI is the latest 22.x rather than
22.0, so "CI exercises the floor" is approximately rather than exactly true.
## Task 1: complete (commits 71ca50d..fe1474c, review clean after rulings)
## Task 2: dispatched (base fe1474c)
## Task 2: implementer returned DONE (commits e98c398..adde5d8; base corrected from fe1474c to e98c398 because the controller committed a plan-only change in between). Review dispatched.

Process note: do not commit into the working tree while an implementer is
running there. The plan-only commit e98c398 landed mid-task and shifted the
review base. It swept nothing in, verified by `git show --stat`, but the next
one might. Batch controller commits between tasks.

## Task 2: carry into the M1 plan: `vitest run` now exits 1 on zero test files, so
every new package under `packages/` must ship at least one test in the commit
that creates it.
## Task 2: review returned spec met in full including all five controller changes; two Important routed to the controller, three Minor. Rulings below; no fix loop.

Ruling: the doc comment on EVIDENCE_KINDS asserts three behaviours that nothing
yet enforces — events decay, states are refreshed while they hold, and a state
never enters a timing computation. Under this project's own rule that is an
unenforced claim, and the reviewer is right to call it. The third claim gets its
gate in Task 4, whose timing test asserts exactly that a state has no date; Task
4 also amends the comment so each remaining claim names the milestone that will
enforce it rather than stating it flatly. Decay is M2, refresh under saturation
is M2. Cost if wrong: a comment that promises more than the package delivers,
which is the failure mode this repository keeps rediscovering.

Ruling: CI never runs `build`, so "the build emits no test files" is a stated
property with no gate. The fix belongs in Task 7 rather than now, because
nothing is pushed until Task 7 and CI therefore executes for the first time
there; adding the step earlier gates nothing. Task 7 adds `pnpm build` to the
workflow and a check that `dist/` contains no file matching `*.test.*`. Cost if
wrong: four tasks in which a build regression would be caught only locally.

## Task 2: carry into Task 6: under `isolatedModules`, `index.ts` must re-export
types with `export type` or `export *`, or TS1205 fires.
## Task 2: carry into the M1 plan: `extends` inherits the parent's `exclude`, and
omitting `exclude: []` in a test config silently drops the tests from
typechecking while `tsc` still exits 0. Any package scaffolded later inherits
this trap.
## Task 2: minor (deferred): `tsconfig.test.json` carries JSONC comments, which
strict-JSON tooling would reject.
## Task 2: minor (deferred): a test named `*.spec.ts` would still be emitted into
`dist/`; the exclude covers `*.test.ts` only, and the convention has no gate.
## Task 2: complete (commits e98c398..adde5d8, review clean after rulings)
## Task 3: dispatched (base adde5d8)
## Task 3: implementer returned DONE (commits adde5d8..94ccce8), four concerns. Review dispatched.

Ruling: the implementer is right that the idempotency key can collide across
networks. A producer named `stellar-indexer` reading both pubnet and testnet
emits the same Horizon operation id on each, and the key currently reads
producer, ref and channel only. This is not hypothetical: the mid-October plan
runs a testnet demo while mainnet shadow observation is already collecting, so
one producer over two networks is the expected configuration, not an edge case.
## Task 5 puts `network` into the key, with an absent network contributing an empty
segment so producers that never set it stay stable. Cost if wrong: nothing is
stored yet, so the change is free today and would be a re-keying migration
later.

Ruling: `z.string().datetime()` accepts UTC `Z` only and rejects offset forms
like `+02:00`. Keep it. The engine compares and stores instants, and one
canonical form removes an ambiguity class outright; Horizon already serves UTC.
## Task 7 states it in the contract document so an integrator meets it as a
documented rule rather than as a surprise rejection. Cost if wrong: a caller
sending an offset timestamp is rejected, with a message naming the field.

## Task 3: the implementer strengthened a weak test on its own initiative. The
brief's versioned-producer test asserted only that parsing failed, which would
have passed even if the failure came from an unrelated field, so it gated
nothing. The self-review commit asserts the sole issue sits at `producer` and
carries the exact message. This is the discipline the project asks for and it
came from the implementer, not the review.

## Task 3: minor (deferred): the producer regex cannot reject a hyphen-encoded
version such as `stellar-indexer-0-1-0`. A convention, not schema-enforceable.
## Task 3: review returned spec met, both rules enforced in the implementation, producer test verified to genuinely gate the regex. One Important, five Minor. Fix round 1 dispatched to the original implementer.

Ruling: the Important finding is real and enters the loop rather than being
parked. Of the three continuity fields only `assertedBy` has a rejection test,
so two thirds of "the engine never merges two identities on its own" is
unenforced, and that sentence is the entire reason this module exists. Fixing
it costs two tests. Cost if wrong: none.

Ruling: three Minor findings join the same round because each is cheap and each
gates a property the code already claims. Whitespace-only strings pass `min(1)`,
so a `reason` of three spaces satisfies a field whose job is to record why.
The UTC-only timestamp contract is real but untested, and zod's next major
changes `datetime()` defaults, so an upgrade could loosen it in silence. The
producer regex admits a trailing hyphen, a double hyphen and an unbounded
length; tightening it rejects nothing we would ever name. Cost if wrong: a
slightly stricter schema than the brief specified, recorded here.

Ruling: `namespace.id` gets no trimming and no per-kind shape in v0. The
whitepaper's identity model makes the id an opaque handle the integrator
chooses, so validating it per kind would contradict the model the moment a
richer integration supplies a merchant-level anchor, and trimming would rewrite
a caller's handle without being asked. Normalisation questions — case, trailing
slashes on endpoint URLs — belong to key derivation and are carried to Task 5.
Cost if wrong: two spellings of one endpoint open two namespaces, which the
integrator can see and correct.

## Task 3: carry into Task 5: `namespace.id` is unnormalised, so decide there
whether the key normalises case and trailing slashes, or documents that it
does not.
## Task 3: fix round 1/5 (all 5 findings addressed by the implementer's account, 17/17 tests; commits 94ccce8..bef7a20, of which 5dd3822 is the controller's docs-only commit that landed concurrently). Scoped re-review dispatched.

## Task 3: carry into Tasks 4 and 5: `.trim()` on `assertedBy` and `reason` means
a parsed continuity assertion carries trimmed strings rather than the caller's
raw input, so the parsed value can differ from what arrived.
## Task 3: re-review verdicted all five findings ADDRESSED, each verified by probe to go red on regression, no new breakage.
## Task 3: complete (commits adde5d8..bef7a20, review clean)
## Task 4: dispatched (base bef7a20)
## Task 4: implementer returned DONE_WITH_CONCERNS (commits bef7a20..fcefa2e), 34/34 tests, two concerns. Review dispatched with the payload question put to the reviewer rather than pre-judged.
## Task 4: review returned spec met, core invariant verified unbreakable by every parse route, two Important and six Minor. Fix round 1 dispatched.

Ruling: the highest-value finding of the run. `datedAt` is documented as the
only place permitted to read a date off an observation, and nothing enforces
it — after narrowing on the discriminant, both `observedAt` and `validFrom` are
readable with full type support and no warning, which is precisely the
substitution that produced the study's one-sided inflation. The gate is a test
that reads every source file outside `observation.ts` and `timing.ts` and fails
on any mention of the three date fields. This project's own history says an
unenforced property turns out false, so the claim either gets its gate or comes
out of the comment; it gets its gate. Cost if wrong: a lint-shaped test that
someone must update when a legitimate reader appears, which is the point.

Ruling: `payload: z.unknown()` makes the key optional in both the type and the
runtime, so `Observation` would carry `payload?: unknown` forever and every
consumer would handle a case the runtime never produces once Task 6 lands. A
type that lies about an invariant is this repository's recurring defect shape.
Adopting the reviewer's `z.record(z.string(), z.unknown())`, which commits the
envelope to "a payload is a JSON object" — already true of all seven channels.
The reviewer's warning that `z.unknown().refine(...)` collapses the inferred
type to `{} | null` under TS 5.5 is carried into the fix message. Cost if
wrong: a future channel wanting a non-object payload needs a schema change.

Ruling: nested objects strip unknown keys rather than rejecting them. For a
package whose entire purpose is the contract the indexer writes against, silent
stripping is worse than rejection, because the author believes a field is
flowing when it is not. The four nested schemas become strict. Cost if wrong:
an integrator sending a field we do not model gets a rejection naming it.

Ruling: the two origins for the evidence-kind list get a test tying the union's
discriminants to `EVIDENCE_KINDS`, so a third kind fails loudly rather than
going unhandled. Cost if wrong: none.

Ruling: `OBSERVATION_SCHEMA_VERSION` has no reader and an observation declaring
any version string parses. The gate belongs in Task 6, where `validateObservation`
is the real entry point: it will reject an unsupported schema version with a
message naming it, and the contract document will say so. Within one repository
both sides move together, so lockstep is correct and an explicit rejection beats
silently accepting data written against a different shape. Cost if wrong: an
indexer pinned to an older schema is rejected rather than half-understood.

## Task 4: deferred (Minor): `observationSchema.innerType()` reaches the union
members but skips the interval refinement; if a later task needs the members,
export them for typing and keep parsing through `observationSchema`.
## Task 4: fix round 1/5 (5 addressed, 0 open; commits fcefa2e..6ef61ff, 42/42 tests, single-reader gate confirmed red with a planted read then green). Re-review found one new gap inside the gate itself; fix round 2 dispatched.

Ruling: the gate exempts by basename while scanning recursively, so any file
named `timing.ts` or `observation.ts` at any depth is exempt. The reviewer
demonstrated it with a planted `src/sub/timing.ts`. Nothing escapes today
because the directory is flat, but `src/windows/timing.ts` is exactly the file a
later author writing window arithmetic would create, and it would inherit the
exemption for free. A gate with a free bypass is worse than no gate because the
confidence it produces is unearned. One-token fix, so it gets a round rather
than a deferral. Cost if wrong: none.

Ruling: the reviewer argued the gate should keep scanning comments rather than
stripping them, on failure asymmetry — a false positive fails loudly and is
fixed by a rephrase or a review-visible exemption, while a false negative is
silent and is the defect class the gate exists for, and every cheap comment
stripper misclassifies delimiters inside strings, regexes and template
literals. Accepted, and it settles the question the implementer raised about
## Task 6's index file: that file re-exports and does not need to name the fields.

## Task 4: carry into the M1 and M2 plans: the single-reader gate covers
`packages/schema/src` only. The code most likely to violate the claim is the
window and decay arithmetic, which lands in a different package, where nothing
enforces it yet. Extend the gate when that package is created.
## Task 4: deferred (Minor): the discriminant test reads `optionsMap`, a Zod 3
surface that Zod 4 removes. Fine while the package pins `^3.23`.
## Task 4: fix round 2/5 (2 addressed, 0 open; commit 6ef61ff..4a10f9e, one file). The re-reviewer planted nine files to break the gate; eight were reported, one slipped.

Ruling: the one bypass is a symlinked source file inside `src`. `readdirSync`
with file types reports a symlink as not-a-file, so the gate skips it, yet the
compiler still includes it and it would ship in `dist`. Real, unlikely, and a
one-line fix with `statSync`. Not worth a third round on a task that is
otherwise finished; it goes to Task 7, which is already the hardening task.
Cost if wrong: someone commits a symlinked module in `src` that reads a date
field unnoticed.

Ruling: the reviewer also found the build config excludes `src/**/*.test.ts`
only, while the gate now skips every test extension, so a `.test.mts` would be
compiled into `dist` while the gate correctly ignored it. Task 7 tightens the
exclude to all four extensions, and its `dist` check catches the case anyway.
Cost if wrong: a test file ships inside the published package.

## Task 4: complete (commits bef7a20..4a10f9e, review clean after two rounds)
## Task 5: dispatched (base 4a10f9e)
## Task 5: implementer returned DONE_WITH_CONCERNS (commits 4a10f9e..db82c65), 55/55 tests, four concerns, one of them a real defect it found on its own. Fix round 1 dispatched.

Ruling: the defect is that a payment has two sides. An observation emitted for
the sender's namespace and another for the receiver's share producer, network,
ref and channel, so the second is dropped as a duplicate and one counterparty's
evidence disappears silently. The implementer proposed a contract rule making
`ref` differ per side; I ruled the other way and put the namespace kind and id
into the key. A convention a human must remember, with nothing enforcing it and
no error when broken, is the exact defect class this repository keeps finding in
itself. An observation is evidence about a counterparty, so two observations
concerning different counterparties are different observations even when one
chain event produced both, and the key should say that by construction. Cost if
wrong: the key is sensitive to how an integrator spells a namespace id, which
is already true of the namespace itself.

Ruling: accept the implementer's unrequested addition rejecting a NUL byte in
the source fields. The brief's comment claimed a separator no field could
contain, and that claim was false until it was gated. Extended to the namespace
id in the same round. Cost if wrong: none.

Ruling: the first commit wrote a raw NUL byte, so git treats that blob as
binary and the diff is unreviewable; the next commit replaced it with an escape.
History stays. Rewriting it to tidy one diff costs the record of what happened,
and the branch is small enough that the fix commit is the better explanation.
Cost if wrong: one commit in the history whose diff must be read as a file
rather than as a patch.

Ruling: the spec claims muxed addresses resolve to a base address and nothing
enforces it. The implementer's suggested shape gate on wallet ids is the right
enforcement and does not land in M0: it would rewrite every test and fixture id
in the package on the milestone's last day, and the data it gates does not exist
until the indexer runs. It moves to M1, and Task 7's contract document states
plainly that the rule is the indexer's to follow and is not yet checked by the
schema. An ungated claim that says so out loud is honest; one that does not is
the failure. Cost if wrong: a muxed address reaches the store as a namespace
during M1 before the gate exists.

## Task 5: carry into the M1 plan: add the wallet-id shape gate, and give the
fixtures ids that are shape-valid but not checksum-valid, since real addresses
must never enter a tracked file.
## Task 5: fix round 1/5 (5 addressed, 0 open; commits db82c65..8897820, 61/61 tests). The re-reviewer found the implementer's verification weaker than described, re-derived it with two probes, and confirmed the conclusion holds.
## Task 5: complete (commits 4a10f9e..8897820, review clean)

Ruling: one boundary assertion pair is inert — the two inputs cannot collide
under any separator, and the comment above them describes a shift they do not
perform. A test that asserts something true but unrelated, under a comment
saying otherwise, is a false claim in the same family as the ones this project
keeps finding. Cheap to fix, so it rides along with Task 6 rather than opening
another round on a finished task. Cost if wrong: a test that looks like a gate
and is not, beside a real one that is.

## Task 5: carry into the M1 plan, and it is load-bearing: namespace identity in
storage must be byte-exact, exactly as the key is. If a storage layer ever
compares ids more loosely — a case-insensitive collation, a trimmed column —
two distinct keys land in one logical namespace and the evidence is
double-counted, which is the failure this key exists to prevent.
## Task 5: deferred (Minor): the separator guard's message names NUL regardless of
what the separator constant holds.
## Task 6: dispatched (base 8897820 plus the controller's docs commit)

Ruling (to land in Task 7): `nnt-core` goes public at the v0 tag, so it needs
the same gate the study repository carries — no checksum-valid Stellar account
id in any tracked file. The discriminator is the strkey checksum: 56 base32
characters whose decoded payload ends in a little-endian CRC16-XModem of the
preceding bytes. Real ids pass it, synthetic fixture ids fail it, and no
allowlist exists or should. Without this gate the fixtures are one careless
copy-paste away from publishing an address, and the artefacts behind this
project identify defrauded accounts that scammers actively re-target.

Ruling: the gate must be proven to scan its own file. The equivalent gate in the
study repository reported a false green on the day it was added, because it
enumerates tracked files and had not yet been tracked, so it never scanned
itself. Verification: generate a fresh random keypair, put its public key in a
file, `git add` it so it becomes tracked, run the gate and watch it fail, then
unstage and delete. Never a key from the study data, and never committed.

Authorisation: the user approved pushing `feature/mvp-v0` to the shared private
repository ("push et gitsin"). The push happens once, at the end of Task 7, so
the developer finds a working validator, the fixtures and the contract document
together rather than a package without its contract.
## Task 6: review accepted the task, verified the address gate independently including that it scans its own file, and found three Important plus eight Minor. Fix round 1 dispatched with seven changes.

Ruling: the address-integrity observation was ambiguous and the fault is mine,
not the implementer's — I wrote that fixture into the plan. `reverted: true`
beside a `current` address cannot be read one way: either the address is back to
the old one, or this observation is the revert and the two fields are the wrong
way round. A change and a revert are also two events with two source
references. `reverted` comes out; each observation records one transition and
the revert is a second observation. That is also what the mechanism wants,
because two address transitions inside one day is the anomaly, and folding them
into a single record with a flag hides exactly the signal the day-twelve
scenario turns on. Cost if wrong: a producer that can only see an end state has
no transition to report, which is the correct outcome anyway.

Ruling: the same fixture named the chain indexer as its producer, but a data
provider's advertised pay-to address lives in its 402 response, which the
gateway sees; the indexer sees only payments landing somewhere new. The fixture
moves to the gateway producer, making the seven internally consistent about who
observes what. Cost if wrong: the contract points the indexer developer at a
channel he does not populate, which the contract document will state.

Ruling: engine-assigned fields were gated inconsistently — a disagreeing wire
`idempotencyKey` was rejected while `observationId` and `ingestedAt` were kept
as sent. The implementer's own report says all three should be omitted, so two
thirds of that claim had no gate. All three are now rejected on the wire. Cost
if wrong: a producer that wants to assign its own identifier is refused, which
is the intended contract.

Ruling: the two errors a real mapper author hits first were both misleading. A
JSON string rather than a parsed object was blamed on the schema version, and an
offset timestamp returned `Invalid datetime` without saying UTC is required.
Both are one-liners and both land now, because this package's error messages are
part of the deliverable rather than polish: the indexer developer debugs against
them without reading our source.

## Task 6: carry into Task 7: move the address gate to the repository root. It
currently scans `packages/schema` only, so a second package or a root document
would be unscanned.
## Task 6: deferred (Minor): the validated payload is not narrowed per channel, so
engine code will cast; errors are flat strings rather than path and message
pairs.
## Task 6: fix round 1/5 (9 addressed, 0 open; commits bb25c8e..dc23d44, 88 tests). Re-review found three follow-ups and one contract question.
## Task 6: fix round 2/5 (4 addressed by the implementer's account; commit dc23d44..9d513ba, 94 tests). Scoped re-review dispatched.

Ruling: `kind` stays a free string. The reviewer is right that a mapper could
spell a revert two ways and both would validate, but the vocabulary the indexer
needs is not known yet and freezing it now would churn through M1. It goes into
the contract document as a rule the developer follows and the schema does not
check, stated as plainly as the muxed-address rule. An ungated claim that says
out loud that it is ungated is honest; one that does not is the failure.
## Task 6: round 2 re-review verdicted all four ADDRESSED, each verified independently — the type-equality gate was broken and restored, the key difference was traced to the source reference rather than to timing, and the engine-field messages were read off the built module.
## Task 6: complete (commits 381cd23..9d513ba, review clean after two rounds)
## Task 6: deferred (Minor): the presence check uses an `in` test, so an explicit
`observationId: undefined` from a direct TypeScript caller is also refused. The
project compiles with `exactOptionalPropertyTypes`, so a value typed as an
observation cannot hold it; worth one sentence in the doc comment, which Task 7
can add while it writes the contract.
## Task 7: dispatched (base 9d513ba)
## Task 7: review verified all four gates by running them, including generating a fresh key and staging it to prove the address gate fires and scans its own file. Code approved. Four Important gaps in the contract document, eleven Minor. Fix round 1 dispatched.

Ruling: the contract never said where an observation goes. For 16 September
there is no ingest and the developer's own brief already says to write to disk
while the engine does not exist. Specified as newline-delimited JSON, one
validated observation per line, one file per backfill run. His re-run acceptance
test needs no store of ours: run the range twice, compare the two sets of
idempotency keys. Cost if wrong: a file format we replace when the ingest lands,
which is cheaper than blocking him for a week.

Ruling: the 16 September scope is `volume`, `content` and `protocol`. Those are
what his own acceptance metrics measure. `cluster_proximity` is out: it needs a
cluster list and a dust threshold that come from the measurement study and are a
decision nobody has made. Saying so stops him building it and stops him worrying
about it. Cost if wrong: the cluster channel arrives in M1 rather than with the
first delivery, which is where the fleet consolidation it feeds already sits.

Ruling: a state cannot be closed by re-emission, because the same source
reference is a duplicate by construction. The standing condition is a state
whose reference is the operation that established it; the ending is a separate
event on the same channel with the closing operation's own reference. Same shape
as the address rule, where a transition is an event and never a flag on an
existing record. Whether the engine reconciles the pair automatically is M1's
work. Cost if wrong: the store holds an open interval and a closing event that
nothing joins until M1, which is visible rather than silent.

Ruling: delete the `op:<id>#2` escape from the contract. It contradicts the rule
two sections earlier that a reference is the stable identifier of a source
event, and it is an unenforced convention of exactly the kind the document's own
strongest section warns against. The question stays in the open-points list
without a proposed mechanism. Cost if wrong: one more thing to decide together,
which is the honest state.
## Task 7: fix round 1/5 (all items addressed, verified by running: spec files planted and kept out of dist, the CI scan shown to fail on one; commits 46bae9e..25eecc7). Round 2 dispatched for one leftover string and a corrected rationale.

Ruling: `event` carries Horizon's effect type name verbatim while `kind` stays
our own word. The developer can check an effect name against Horizon's own
endpoint rather than against a spelling we would have to freeze, and our
vocabulary stays insulated from Horizon renames. The implementer reached the
same conclusion and then justified it as "code wins on disagreement", which is
backwards — that rule is for divergence someone finds, whereas here the document
introduced a rule and the fixture was aligned to it. The outcome stands, the
reasoning is corrected in the record. Cost if wrong: Horizon renames an effect
and our stored values carry the old name, which is visible in the data.

Ruling: the protocol payload has no field naming which account flag changed, and
it stays that way in v0. Widening a strict payload on a guess is the same error
as freezing the `kind` vocabulary before the mapper has run; it goes to the open
points and firms up once the indexer shows what Horizon actually emits. Cost if
wrong: a flag change is recorded as having happened without saying which, which
is still more than nothing and is visible in the contract as an open point.

Deviation from the standard, recorded rather than left silent: the
subagent-driven-development skill prescribes the most capable available model
for the final whole-branch review. The user's standing instruction is that every
subagent runs on fable, so the final review runs on fable like every other agent
in this session.
## Task 7: fix round 2/5 (1 addressed; commit 25eecc7..95d8723). 
## Task 7: complete (commits 9d513ba..95d8723, review clean after two rounds)
All seven tasks of M0 complete. Final whole-branch review dispatched.
Final whole-branch review: fit to push after three small fixes; no Critical. Independently confirmed no Stellar account id in the working tree, in any of the 29 commits, or in any commit message. One fix dispatch covering all thirteen findings.

Ruling: the muxed identifier gets an optional field on the namespace reference,
which is where the spec already says it belongs. Today the indexer resolves a
muxed address to its base address as required and the muxed identifier is then
dropped on the wire, so the datum the developer is asked to measure never
reaches us, and adding it later would force a re-map because the payloads are
strict. The address-integrity payload keeps its own muxed field, because that
one describes an advertised address inside a transition rather than the
subject's identity, and the contract now says which is which. Cost if wrong: one
optional field the engine ignores in v0.

Ruling: the key's frozen part order gets a test pinning two literal hashes.
Every existing key test is relational, so swapping two parts or changing the
separator passes all 93. The indexer starts writing keys to disk on 16 September
and his acceptance test compares key sets across runs, so a silent re-derivation
later would re-key everything with no error anywhere. Cost if wrong: a test that
must be updated deliberately when the derivation changes, which is the point.

Ruling: the two carry-forwards for M1 contradict each other and M1 must pick
one. Task 5 says to give fixtures ids that are shape-valid but not
checksum-valid; the root address gate rejects the shape regardless of checksum,
so a shape-valid fixture id is impossible under it. Either the gate becomes
checksum-based, as the sibling repository's is, or the fixtures keep short
obviously-synthetic ids and the wallet shape check applies only to data the
indexer produces. Recorded here rather than decided, because it belongs with the
milestone that adds the wallet gate.

Not fixed, and it is the user's call rather than mine: every commit is authored
under a personal address and carries a session trailer, and both become public
at the v0 tag. Rewriting twenty-nine commits is expensive and the information is
honest, so I am raising it rather than acting.
