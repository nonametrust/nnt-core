# MVP v0 Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the smallest core engine that runs the whitepaper's day-12 / day-21 scenario with the real mechanism, tagged `v0` by 30 September 2026.

**Architecture:** Two paths over one Postgres store. `brief` reads live tags synchronously for the decision at hand; a deterministic nightly job runs the capture competition and promotes winners durably. Decay is computed from `g0` and elapsed time rather than stored, and the clock is injected everywhere, so twenty-one simulated days run in milliseconds.

**Tech Stack:** TypeScript on Node 22, pnpm workspaces, Postgres 16, zod for schema validation, vitest for tests, Apache-2.0.

**Spec:** `docs/superpowers/specs/2026-09-05-mvp-v0-core-engine-design.md`

## Global Constraints

- Node 22 LTS. pnpm workspaces. TypeScript strict mode on, with
  `isolatedModules` (amended after the Task 1 review: vitest transpiles per
  file and cannot tell a type re-export from a value one, so the flag turns a
  module-link failure into a compile error).
- The build config excludes `src/**/*.test.ts` so tests never reach `dist/`;
  a second config typechecks them. Added in Task 2 for the same reason.
- Licence Apache-2.0 on every package, matching D1.1.
- `Date.now()` never appears inside `packages/engine`, `packages/tagging` or `packages/store`. Time enters through an injected `Clock`.
- Tag strength is never persisted. It is derived from `g0`, elapsed time and the channel half-life.
- Observations are append-only. No `UPDATE` on the `observation` table.
- Suppression lowers strength through accelerated decay. Nothing is deleted.
- Every number taken from the backtest lives in `packages/engine/src/calibration.ts` with the study file and line it came from. Every mechanism parameter lives in `packages/engine/src/policy.ts` with a version string.
- All code, comments, identifiers and documentation in English. Board items and messages to collaborators in Turkish.

---

## Milestone map

The engine has twenty-three working days available across twenty-six calendar days, because the thesis defence falls on 18 September and three days around it are not engine days. There is no buffer. If a milestone slips, the cut list in order is: t-digest quantiles (MAD alone carries v0), the `price` and `latency` channel detectors (the Stellar indexer produces neither in v0), and champion-challenger support beyond the policy version field.

| Milestone | Dates | Deliverable | Acceptance |
|---|---|---|---|
| **M0 - A0 schema** | 5-6 Sep | `packages/schema` in-repo, contract document written | Atahan imports one package and writes the mapper; the same source event twice yields one observation; every channel has a validator and a golden fixture |
| **M1 - Stores** | 7-10 Sep | Postgres schema, migrations, limbo and permanent repositories, audit chain | An observation round-trips; a tag's strength is derivable at an arbitrary instant; a promotion preserves the original timestamp; the audit chain verifies |
| **M2 - Tagging** | 11-15 Sep | Welford and MAD baselines, rule layer, surprise to `g0`, noise-adaptive threshold, cold start, refresh under saturation | No tag below the minimum observation count; a repeated deviation refreshes rather than stacks; one extreme observation cannot move a baseline past its bound |
| *(thesis defence)* | 16-18 Sep | *engine paused* | - |
| **M3 - Synchronous path** | 19-22 Sep | relatedness, `brief`, brief threshold with the active-tag effect, tiered failure policy | `brief` returns a graded result with reasons and sources; an active tag lowers the threshold; unreachable-store behaviour differs by risk tier |
| **M4 - Night consolidation** | 23-27 Sep | trigger grades, volatility, capture competition, graded promotion, suppression, hot window, daily root | Determinism test passes; locality tests pass; the quota is respected; suppression decays rather than deletes |
| **M5 - Scenario and tag** | 28-30 Sep | the day-12 / day-21 acceptance test, calibration and policy files with their gates, quickstart, tag `v0` | The scenario test is green; the calibration gate is green; quickstart reaches a first `brief` in under an hour |

Only M0 is decomposed into steps below. M1 through M5 get their own plans as they are reached, so that each is written with what the previous milestone actually taught us rather than with what we guessed today.

---

## File structure for M0

| File | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | workspace root |
| `.github/workflows/ci.yml` | typecheck and test on every push |
| `LICENSE` | Apache-2.0 |
| `packages/schema/src/channel.ts` | the channel list and its type |
| `packages/schema/src/namespace.ts` | namespace reference and continuity assertion |
| `packages/schema/src/source.ts` | provenance of an observation |
| `packages/schema/src/observation.ts` | the observation type and its validator |
| `packages/schema/src/payloads.ts` | per-channel payload validators |
| `packages/schema/src/idempotency.ts` | deterministic key derivation |
| `packages/schema/src/timing.ts` | `datedAt`, the one place timing may read a date |
| `packages/schema/src/index.ts` | public surface |
| `packages/schema/fixtures/*.json` | one golden fixture per channel |
| `docs/observation-contract.md` | the one-page contract for the indexer developer |

---

### Task 1: Workspace bootstrap

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `LICENSE`, `.github/workflows/ci.yml`
- Create: `packages/schema/package.json`, `packages/schema/tsconfig.json`

**Interfaces:**
- Consumes: nothing
- Produces: a workspace where `pnpm -r test` runs, and the package name `@nonametrust/schema`

- [ ] **Step 1: Create the workspace root**

```json
{
  "name": "nnt-core",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml` lists `packages/*`. `tsconfig.base.json` sets target ES2023, module NodeNext, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `declaration`, `skipLibCheck`.

- [ ] **Step 2: Create the schema package manifest**

```json
{
  "name": "@nonametrust/schema",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "zod": "^3.23.0" }
}
```

`packages/schema/tsconfig.json` extends the base, sets `outDir` to `dist` and `rootDir` to `src`, and includes `src`.

- [ ] **Step 3: Add the Apache-2.0 licence and the CI workflow**

`LICENSE` carries the standard Apache-2.0 text with the copyright line `Copyright 2026 NonameTrust`. The workflow runs on push and pull request: checkout, pnpm setup at version 9, Node 22 with the pnpm cache, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`.

- [ ] **Step 4: Verify the workspace installs**

Run: `pnpm install && pnpm -r typecheck`
Expected: install completes and typecheck reports no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Bootstrap: pnpm workspace, TypeScript strict, CI, Apache-2.0"
```

---

### Task 2: Channels and evidence kind

**Files:**
- Create: `packages/schema/src/channel.ts`
- Test: `packages/schema/src/channel.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CHANNELS`, `type Channel`, `channelSchema`, `EVIDENCE_KINDS`, `type EvidenceKind`, `evidenceKindSchema`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { CHANNELS, channelSchema, evidenceKindSchema } from "./channel.js";

describe("channels", () => {
  it("carries exactly the seven agreed channels", () => {
    expect([...CHANNELS]).toEqual([
      "address_integrity",
      "latency",
      "price",
      "protocol",
      "volume",
      "cluster_proximity",
      "content",
    ]);
  });

  it("rejects a channel that is not on the list", () => {
    expect(channelSchema.safeParse("memo").success).toBe(false);
  });

  it("accepts only event and state as evidence kinds", () => {
    expect(evidenceKindSchema.safeParse("event").success).toBe(true);
    expect(evidenceKindSchema.safeParse("state").success).toBe(true);
    expect(evidenceKindSchema.safeParse("fact").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @nonametrust/schema test`
Expected: FAIL, cannot resolve `./channel.js`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from "zod";

/**
 * The seven channels an observation may bear on.
 *
 * Five come from the developer brief: address integrity, latency, price,
 * protocol, volume. Two were added when the frozen study catalog was mapped
 * onto them and did not fit. The dust channel is graph proximity to an
 * operation cluster rather than a counterparty aspect, and it is what the
 * fleet consolidation of whitepaper section 5.1 attaches to. The memo channel
 * is free-text content rather than a protocol event.
 */
export const CHANNELS = [
  "address_integrity",
  "latency",
  "price",
  "protocol",
  "volume",
  "cluster_proximity",
  "content",
] as const;

export type Channel = (typeof CHANNELS)[number];
export const channelSchema = z.enum(CHANNELS);

/**
 * An event happened at an instant and decays from it. A state holds over an
 * interval, is refreshed while it holds, and never enters a timing
 * computation. The distinction exists because the study's S3 signal is a
 * standing condition that was credited to every window including the
 * seven-day one, while controls could not measure it at all, which inflated
 * the headline in one direction by three points.
 */
export const EVIDENCE_KINDS = ["event", "state"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @nonametrust/schema test`
Expected: PASS, three tests.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/channel.ts packages/schema/src/channel.test.ts
git commit -m "Schema: the seven channels, and the event/state distinction"
```

---

### Task 3: Namespace reference and source provenance

**Files:**
- Create: `packages/schema/src/namespace.ts`, `packages/schema/src/source.ts`
- Test: `packages/schema/src/namespace.test.ts`, `packages/schema/src/source.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `namespaceRefSchema`, `type NamespaceRef`, `continuityAssertionSchema`, `sourceSchema`, `type Source`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { namespaceRefSchema } from "./namespace.js";

describe("namespace reference", () => {
  it("accepts a wallet namespace with no continuity claim", () => {
    expect(namespaceRefSchema.safeParse({ kind: "wallet", id: "GABC" }).success).toBe(true);
  });

  it("records a continuity assertion with its asserter and reason", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "endpoint",
      id: "https://data.example/x402",
      continuity: {
        assertedBy: "integrator:acme",
        assertedAt: "2026-09-05T10:00:00.000Z",
        reason: "same merchant id across address rotation",
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a continuity assertion with no asserter", () => {
    const r = namespaceRefSchema.safeParse({
      kind: "wallet",
      id: "GABC",
      continuity: { assertedAt: "2026-09-05T10:00:00.000Z", reason: "x" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown namespace kind", () => {
    expect(namespaceRefSchema.safeParse({ kind: "email", id: "a@b" }).success).toBe(false);
  });
});
```

```ts
import { describe, it, expect } from "vitest";
import { sourceSchema } from "./source.js";

describe("source", () => {
  it("separates the producer name from its version", () => {
    const r = sourceSchema.safeParse({
      producer: "stellar-indexer",
      producerVersion: "0.1.0",
      network: "stellar:pubnet",
      ref: "op:214748367361",
      fetchedAt: "2026-09-05T10:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a producer name carrying a version", () => {
    const r = sourceSchema.safeParse({
      producer: "stellar-indexer@0.1.0",
      producerVersion: "0.1.0",
      ref: "op:1",
      fetchedAt: "2026-09-05T10:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @nonametrust/schema test`
Expected: FAIL, cannot resolve `./namespace.js` and `./source.js`.

- [ ] **Step 3: Write the implementations**

```ts
import { z } from "zod";

/**
 * Continuity is an integration assertion, never an inference. The engine does
 * not resolve entities and never silently merges identities, so a claim that
 * two addresses are the same counterparty arrives with an asserter and a
 * reason, and is stored as provenance.
 */
export const continuityAssertionSchema = z.object({
  assertedBy: z.string().min(1),
  assertedAt: z.string().datetime(),
  reason: z.string().min(1),
});
export type ContinuityAssertion = z.infer<typeof continuityAssertionSchema>;

/**
 * Addresses, domains and endpoints are attributes of a namespace, not the
 * namespace itself. Where the integration supplies nothing richer, a wallet
 * address is the anchor. Muxed addresses resolve to the base address before
 * they reach this type; the muxed identifier is an attribute.
 */
export const namespaceRefSchema = z.object({
  kind: z.enum(["wallet", "domain", "endpoint", "merchant"]),
  id: z.string().min(1),
  continuity: continuityAssertionSchema.optional(),
});
export type NamespaceRef = z.infer<typeof namespaceRefSchema>;
```

```ts
import { z } from "zod";

/**
 * The producer name and its version are separate fields on purpose. The
 * idempotency key is derived from the producer name, the source reference and
 * the channel; folding the version into the name would change every key on a
 * version bump and silently break deduplication, which is a correctness
 * property rather than a performance one.
 */
export const sourceSchema = z.object({
  producer: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "producer is a bare name; put the version in producerVersion",
  }),
  producerVersion: z.string().min(1),
  network: z.string().min(1).optional(),
  ref: z.string().min(1),
  fetchedAt: z.string().datetime(),
});
export type Source = z.infer<typeof sourceSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @nonametrust/schema test`
Expected: PASS, six new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/namespace.ts packages/schema/src/source.ts packages/schema/src/namespace.test.ts packages/schema/src/source.test.ts
git commit -m "Schema: namespace reference with asserted continuity, and source provenance"
```

---

### Task 4: The observation type

**Files:**
- Create: `packages/schema/src/observation.ts`, `packages/schema/src/timing.ts`
- Test: `packages/schema/src/observation.test.ts`, `packages/schema/src/timing.test.ts`

**Interfaces:**
- Consumes: `channelSchema` from `./channel.js`, `namespaceRefSchema` from `./namespace.js`, `sourceSchema` from `./source.js`
- Produces: `observationSchema`, `type Observation`, `OBSERVATION_SCHEMA_VERSION`, `datedAt(o: Observation): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { observationSchema } from "./observation.js";

const base = {
  schemaVersion: "0.1.0",
  namespace: { kind: "wallet", id: "GABC" },
  channel: "address_integrity",
  kind: "payment_address_changed",
  source: {
    producer: "stellar-indexer",
    producerVersion: "0.1.0",
    network: "stellar:pubnet",
    ref: "op:1",
    fetchedAt: "2026-09-05T10:00:00.000Z",
  },
  payload: { previous: "GOLD", current: "GNEW" },
};

describe("observation", () => {
  it("accepts an event carrying observedAt", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event", observedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an event with no observedAt", () => {
    expect(observationSchema.safeParse({ ...base, evidenceKind: "event" }).success).toBe(false);
  });

  it("rejects an event carrying a validity interval", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event",
      observedAt: "2026-09-05T09:00:00.000Z",
      validFrom: "2026-09-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a state carrying validFrom and an open validUntil", () => {
    const r = observationSchema.safeParse({
      ...base, channel: "protocol", evidenceKind: "state",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a state carrying observedAt", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-01T00:00:00.000Z",
      observedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a state whose interval ends before it starts", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "state",
      validFrom: "2026-09-05T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("treats the signature as optional in v0", () => {
    const r = observationSchema.safeParse({
      ...base, evidenceKind: "event",
      observedAt: "2026-09-05T09:00:00.000Z", signature: null,
    });
    expect(r.success).toBe(true);
  });
});
```

```ts
import { describe, it, expect } from "vitest";
import { datedAt } from "./timing.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

describe("datedAt", () => {
  it("returns the instant for an event", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a state, so a state can never be dated", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "account_young",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
      source: src, payload: {},
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @nonametrust/schema test`
Expected: FAIL, cannot resolve `./observation.js` and `./timing.js`.

- [ ] **Step 3: Write the implementations**

```ts
import { z } from "zod";
import { channelSchema } from "./channel.js";
import { namespaceRefSchema } from "./namespace.js";
import { sourceSchema } from "./source.js";

export const OBSERVATION_SCHEMA_VERSION = "0.1.0";

const common = {
  schemaVersion: z.string().min(1),
  namespace: namespaceRefSchema,
  channel: channelSchema,
  /** What happened at the source, for example "payment". Not the channel. */
  kind: z.string().min(1),
  source: sourceSchema,
  payload: z.unknown(),
  salienceHints: z
    .object({
      amount: z.string().optional(),
      latencyMs: z.number().nonnegative().optional(),
    })
    .optional(),
  /** Present from v0 so that enabling verification is not a migration. */
  signature: z.string().nullable().optional(),
  /** Assigned by the engine on ingest, absent on the wire. */
  observationId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
  ingestedAt: z.string().datetime().optional(),
};

const eventSchema = z
  .object({
    ...common,
    evidenceKind: z.literal("event"),
    observedAt: z.string().datetime(),
  })
  .strict();

const stateSchema = z
  .object({
    ...common,
    evidenceKind: z.literal("state"),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime().nullable().default(null),
  })
  .strict();

/**
 * An event carries an instant and no interval; a state carries an interval and
 * no instant. The union is strict in both directions so that a state can never
 * acquire a date by accident, which is the defect the study's S3 signal
 * exhibited.
 *
 * The interval check sits on the union rather than on the state member because
 * `z.discriminatedUnion` accepts plain objects only: a member ending in
 * `.refine` is a `ZodEffects` and the union throws while it is being built.
 */
export const observationSchema = z
  .discriminatedUnion("evidenceKind", [eventSchema, stateSchema])
  .superRefine((o, ctx) => {
    if (o.evidenceKind !== "state") return;
    if (o.validUntil === null) return;
    if (Date.parse(o.validUntil) < Date.parse(o.validFrom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: "validUntil precedes validFrom",
      });
    }
  });

export type Observation = z.infer<typeof observationSchema>;
```

```ts
import type { Observation } from "./observation.js";

/**
 * The only place in the system permitted to read a date off an observation for
 * a timing computation. States return null, so no distance, window or decay
 * calculation can silently credit a standing condition as a dated hit.
 */
export function datedAt(o: Observation): string | null {
  return o.evidenceKind === "event" ? o.observedAt : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @nonametrust/schema test`
Expected: PASS, nine new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/observation.ts packages/schema/src/timing.ts packages/schema/src/observation.test.ts packages/schema/src/timing.test.ts
git commit -m "Schema: the observation, with events and states kept strictly apart"
```

---

### Task 5: Deterministic idempotency keys

**Files:**
- Create: `packages/schema/src/idempotency.ts`
- Test: `packages/schema/src/idempotency.test.ts`

**Interfaces:**
- Consumes: `type Source` from `./source.js`, `type Channel` from `./channel.js`
- Produces: `deriveIdempotencyKey(source: Source, channel: Channel): string`, keyed on producer, network, ref and channel

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { deriveIdempotencyKey } from "./idempotency.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "stellar:pubnet", ref: "op:214748367361",
  fetchedAt: "2026-09-05T10:00:00.000Z",
};

describe("idempotency key", () => {
  it("is stable across repeated derivation", () => {
    expect(deriveIdempotencyKey(src, "volume")).toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("does not change when the producer version changes", () => {
    expect(deriveIdempotencyKey({ ...src, producerVersion: "9.9.9" }, "volume"))
      .toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("does not change when the fetch time changes", () => {
    expect(deriveIdempotencyKey({ ...src, fetchedAt: "2027-01-01T00:00:00.000Z" }, "volume"))
      .toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("differs per channel, so one event may yield several observations", () => {
    expect(deriveIdempotencyKey(src, "volume")).not.toBe(deriveIdempotencyKey(src, "content"));
  });

  it("differs per source reference", () => {
    expect(deriveIdempotencyKey({ ...src, ref: "op:2" }, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("differs per producer", () => {
    expect(deriveIdempotencyKey({ ...src, producer: "other-indexer" }, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("differs per network, because operation ids repeat across them", () => {
    expect(deriveIdempotencyKey({ ...src, network: "stellar:testnet" }, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("is stable for a producer that declares no network", () => {
    const { network: _drop, ...noNetwork } = src;
    expect(deriveIdempotencyKey(noNetwork, "volume"))
      .toBe(deriveIdempotencyKey(noNetwork, "volume"));
    expect(deriveIdempotencyKey(noNetwork, "volume"))
      .not.toBe(deriveIdempotencyKey(src, "volume"));
  });

  it("does not let a field boundary shift without changing the key", () => {
    // With a space separator these two concatenate identically. The test fails
    // if the separator is anything a field can contain.
    const a = { ...src, network: "a", ref: "b c" };
    const b = { ...src, network: "a b", ref: "c" };
    expect(deriveIdempotencyKey(a, "volume")).not.toBe(deriveIdempotencyKey(b, "volume"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @nonametrust/schema test`
Expected: FAIL, cannot resolve `./idempotency.js`.

- [ ] **Step 3: Write the implementation**

```ts
import { createHash } from "node:crypto";
import type { Channel } from "./channel.js";
import type { Source } from "./source.js";

/**
 * Deduplication is a correctness property, not a performance one: a duplicated
 * trace makes the tagging pipeline believe the evidence is twice as strong.
 *
 * The key is derived from the producer name, the network, the source reference
 * and the channel, and from nothing else.
 *
 * The producer version is excluded so that a version bump does not silently
 * mint duplicates of everything already stored. The fetch time is excluded so
 * that a re-read of the same range produces no new observations, which is the
 * indexer's own acceptance criterion. The network is included because Horizon
 * operation ids repeat across pubnet and testnet, and one producer reading both
 * is the expected configuration once the testnet demo runs alongside mainnet
 * shadow observation.
 *
 * The parts are joined with a NUL rather than a space because `ref` is
 * unconstrained: without a separator that cannot occur inside a field, a
 * producer and reference could be re-partitioned into a different pair with the
 * same concatenation.
 */
export function deriveIdempotencyKey(source: Source, channel: Channel): string {
  return createHash("sha256")
    .update([source.producer, source.network ?? "", source.ref, channel].join("\u0000"))
    .digest("hex");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @nonametrust/schema test`
Expected: PASS, nine new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/idempotency.ts packages/schema/src/idempotency.test.ts
git commit -m "Schema: idempotency keys that survive a producer version bump"
```

---

### Task 6: Per-channel payload validators and golden fixtures

**Files:**
- Create: `packages/schema/src/payloads.ts`, `packages/schema/src/index.ts`
- Create: one fixture per channel under `packages/schema/fixtures/`
- Test: `packages/schema/src/payloads.test.ts`, `packages/schema/src/fixtures.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `payloadSchemaFor(channel: Channel)`, `validateObservation(input: unknown): ValidationResult`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { CHANNELS } from "./channel.js";
import { payloadSchemaFor, validateObservation } from "./payloads.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

describe("payload validators", () => {
  it("has a validator for every channel", () => {
    for (const c of CHANNELS) expect(payloadSchemaFor(c)).toBeDefined();
  });

  it("rejects an address change with no previous address", () => {
    const r = validateObservation({
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "address_integrity",
      evidenceKind: "event",
      kind: "payment_address_changed",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { current: "GNEW" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an observation declaring an unsupported schema version", () => {
    const r = validateObservation({
      schemaVersion: "0.0.1",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "volume",
      evidenceKind: "event",
      kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { amount: "1", assetCode: "XLM", direction: "in" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("schemaVersion");
  });

  it("assigns an idempotency key when the observation is valid", () => {
    const r = validateObservation({
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id: "GABC" },
      channel: "volume",
      evidenceKind: "event",
      kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z",
      source: src,
      payload: { amount: "12.5", assetCode: "XLM", direction: "in" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "./channel.js";
import { validateObservation } from "./payloads.js";

const dir = new URL("../fixtures/", import.meta.url).pathname;

describe("golden fixtures", () => {
  it("has one fixture per channel", () => {
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    expect(names.sort()).toEqual([...CHANNELS].sort());
  });

  it("every fixture validates", () => {
    for (const c of CHANNELS) {
      const raw = JSON.parse(readFileSync(join(dir, `${c}.json`), "utf8"));
      expect(validateObservation(raw).ok, `${c} fixture failed`).toBe(true);
    }
  });

  it("re-reading the same source event yields the same key", () => {
    const raw = JSON.parse(readFileSync(join(dir, "volume.json"), "utf8"));
    const a = validateObservation(raw);
    const b = validateObservation({
      ...raw,
      source: { ...raw.source, fetchedAt: "2027-01-01T00:00:00.000Z" },
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.idempotencyKey).toBe(b.value.idempotencyKey);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @nonametrust/schema test`
Expected: FAIL, cannot resolve `./payloads.js`, and the fixtures directory is missing.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from "zod";
import { type Channel } from "./channel.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  observationSchema,
  type Observation,
} from "./observation.js";
import { deriveIdempotencyKey } from "./idempotency.js";

const addressIntegrity = z.object({
  previous: z.string().min(1),
  current: z.string().min(1),
  reverted: z.boolean().optional(),
  muxedId: z.string().optional(),
});

const latency = z.object({ latencyMs: z.number().nonnegative() });

const price = z.object({ quoted: z.string(), unit: z.string().min(1) });

const protocol = z.object({
  event: z.string().min(1),
  assetCode: z.string().optional(),
  assetIssuer: z.string().optional(),
  issuerKnown: z.boolean().optional(),
});

const volume = z.object({
  amount: z.string(),
  assetCode: z.string().min(1),
  direction: z.enum(["in", "out"]),
});

const clusterProximity = z.object({
  clusterId: z.string().min(1),
  hops: z.number().int().positive(),
  amount: z.string().optional(),
});

const content = z.object({
  text: z.string(),
  field: z.enum(["memo", "error", "response"]),
});

const BY_CHANNEL: Record<Channel, z.ZodTypeAny> = {
  address_integrity: addressIntegrity,
  latency,
  price,
  protocol,
  volume,
  cluster_proximity: clusterProximity,
  content,
};

export function payloadSchemaFor(channel: Channel): z.ZodTypeAny {
  return BY_CHANNEL[channel];
}

export type ValidationResult =
  | { ok: true; value: Observation & { idempotencyKey: string } }
  | { ok: false; errors: string[] };

/**
 * Validates the schema version, then the envelope, then the channel-specific
 * payload, then assigns the deterministic idempotency key. Every layer must
 * pass; a valid envelope with a malformed payload is a rejection, because a
 * half-understood observation that reaches the tagging pipeline is worse than
 * one that never arrives.
 *
 * The version is checked first and exactly. Both sides of this contract live in
 * one repository and move together, so a producer declaring a version we do not
 * implement is telling us its shape was written against a different schema, and
 * accepting it half-understood is the worse failure. The check exists because
 * an exported version constant that nothing reads is a claim with no gate.
 */
export function validateObservation(input: unknown): ValidationResult {
  const declared = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (declared !== OBSERVATION_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `schemaVersion: expected ${OBSERVATION_SCHEMA_VERSION}, received ${String(declared)}`,
      ],
    };
  }
  const envelope = observationSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      errors: envelope.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const o = envelope.data;
  const payload = payloadSchemaFor(o.channel).safeParse(o.payload);
  if (!payload.success) {
    return {
      ok: false,
      errors: payload.error.issues.map((i) => `payload.${i.path.join(".")}: ${i.message}`),
    };
  }
  return {
    ok: true,
    value: { ...o, idempotencyKey: deriveIdempotencyKey(o.source, o.channel) },
  };
}
```

`payloads.ts` does not re-export `CHANNELS`. It imports it to build the record
and to let callers iterate, but `channel.ts` stays the single origin, because
the index re-exports both files and two origins for one name fails to
typecheck.

- [ ] **Step 4: Write the seven fixtures**

All seven share one namespace so that they read as a single counterparty
history. The `address_integrity` fixture is the day-twelve observation of the
whitepaper's scenario and must read as that scenario describes it, one address
change that reverts:

```json
{
  "schemaVersion": "0.1.0",
  "namespace": { "kind": "endpoint", "id": "https://data.example/x402" },
  "channel": "address_integrity",
  "evidenceKind": "event",
  "kind": "payment_address_changed",
  "observedAt": "2026-09-12T08:14:00.000Z",
  "source": {
    "producer": "stellar-indexer",
    "producerVersion": "0.1.0",
    "network": "stellar:pubnet",
    "ref": "op:214748367361",
    "fetchedAt": "2026-09-12T08:20:00.000Z"
  },
  "payload": { "previous": "GOLDADDRESS", "current": "GNEWADDRESS", "reverted": true }
}
```

The remaining six follow their validators. `protocol` is the one state fixture,
carrying `validFrom` and a null `validUntil`, so that the fixture suite
exercises both arms of the union.

```ts
export * from "./channel.js";
export * from "./namespace.js";
export * from "./source.js";
export * from "./observation.js";
export * from "./timing.js";
export * from "./idempotency.js";
export * from "./payloads.js";
```

Two constraints on this file. Under `isolatedModules` a type re-export needs
`export type`, and `export *` is fine. And the single-reader gate added in Task
4 scans every non-test source file in the package, so `index.ts` must not name
`observedAt`, `validFrom` or `validUntil`, in code or in a comment.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @nonametrust/schema test`
Expected: PASS, the whole schema suite.

- [ ] **Step 6: Commit**

```bash
git add packages/schema
git commit -m "Schema: per-channel payload validators, golden fixtures, and the public surface"
```

---

### Task 7: The contract document, and hand the package to the indexer

**Files:**
- Create: `docs/observation-contract.md`
- Create: `README.md`

**Interfaces:**
- Consumes: the whole schema package
- Produces: the one-page contract the founder brief asks for

- [ ] **Step 1: Write the contract document**

One page, in Turkish, addressed to the indexer developer. It covers the seven
channels and what belongs in each; the event and state distinction and why a
state must never carry a date; the namespace rules including muxed resolution
to the base address; the source fields and why the producer version is
separate; how the idempotency key is derived and what the re-run guarantee
means in practice; and one worked example per channel pointing at its golden
fixture.

- [ ] **Step 2: Write the repository README**

State what the repository holds, that the engine and the indexer share it
because the observation schema must live in one place, that `packages/schema`
is the only package the indexer depends on, and how to run the tests.

- [ ] **Step 3: Harden the three gates the reviews left open**

Each of these is a property the repository already states and nothing yet
enforces. All three are one-liners and they belong here, in the task that first
pushes and therefore first runs CI.

- Add `pnpm build` to the CI workflow, after `typecheck` and before or after
  `test`, and follow it with a step that fails if any file under
  `packages/*/dist` matches `*.test.*`. Until now "the build emits no test
  files" has been checked only by hand.
- Widen the build config's exclusion from `src/**/*.test.ts` to cover `.mts`,
  `.cts` and `.tsx` as well. The date-field gate already skips every test
  extension, so a `.test.mts` would today be compiled into `dist` while the gate
  correctly ignored it.
- Close the one bypass the date-field gate has. It calls `isFile()` on the
  directory entry, which is false for a symlink, so a symlinked module inside
  `src` is skipped by the gate while the compiler still includes it and it
  still ships. Use a stat that follows the link instead. Prove it: create a
  symlink in `src` pointing at a file that reads one of the three date fields,
  show the gate now reports it, remove the symlink, and paste both runs.

- [ ] **Step 4: Verify the whole suite and the build**

Run: `pnpm install && pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "Contract: the observation schema, written for the indexer"
git push -u origin feature/mvp-v0
```

- [ ] **Step 6: Move A0 to Done on the board and tell the developer**

Move the A0 item to Done, write into its body what the schema finally settled
on, and send the developer a message naming the package, the contract document
and the fixtures.

---

## Self-review

**Spec coverage.** M0 implements section 3 of the spec in full. Sections 4
through 9 map to milestones M1 through M5, each listed with its acceptance
criteria, and each gets its own plan when reached. Section 10 needs no task; it
is a standing caution.

**Placeholders.** Task 7 steps 1 and 2 describe documents rather than showing
them, which is deliberate: prose written to one named reader should not be
drafted blind two days ahead. Every code step carries its code. Six of the
seven fixtures are specified by their validators and by the scenario rather
than written out, and the seventh is given in full.

**Type consistency.** `Source` gains `producerVersion` in task 3 and every
later use carries it. `deriveIdempotencyKey` takes a source and a channel in
tasks 5 and 6 alike. `validateObservation` returns the same discriminated
`ValidationResult` in its tests and its implementation. `datedAt` is the single
reader of dates and is exported from the index.
