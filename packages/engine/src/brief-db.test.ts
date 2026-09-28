import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { CALIBRATION_V0, POLICY_V0 } from "@nonametrust/tagging";
import {
  fixedClock,
  keyRingFromEnv,
  migrate,
  openDb,
  RETENTION_V0,
  type Db,
  type FixedClock,
  type StoredTag,
} from "@nonametrust/store";
import { ADMITTED_PATHS } from "./audit-body.js";
import { compose, type Composed } from "./compose.js";
import { brief, type BriefInput } from "./brief.js";
import { thresholdFor, type ThresholdReads } from "./threshold.js";
import { briefDeps, runBrief, type BriefRequest } from "./run-brief.js";
import { BRIEF_POLICY_V0 } from "./policy.js";
import type { IdSource } from "./ids.js";

// G9, G10, G12, G20 and R43 against a REAL database.
//
// WHY THIS FILE EXISTS RATHER THAN MORE STUBS. "The core writes nothing" is a
// claim about a database, and a stub that records no write proves only that the
// stub was not called. G9 measures every table's `xmin`, which Postgres rewrites on
// any UPDATE including one that sets a column to the value it already had -- a row
// COUNT would miss an in-place rewrite, and "no write" has to mean no write.
//
// AND IT NEEDS NO GATE CHANGE, which was measured before it was written: the
// store's public surface alone is enough. `openDb` gives a handle whose schema
// builder creates and drops a schema, `migrate` applies the store's own migrations
// from a path, and `db.dynamic.ref<string>("xmin")` reads the version column. The
// engine's boundary gate refuses the driver by name, refuses a deep import into the
// store, and refuses the store's test harness -- so none of those is used, and the
// small amount of setup duplicated from that harness is the price of the boundary
// holding.

const SCHEMA = "engine_brief_test";
const DAY = 24 * 60 * 60 * 1000;
const AT = new Date("2026-09-21T00:00:00.000Z");
/** Seeding happens ten days after `at`, so a tag stamped AFTER `at` is openable. */
const SEED_NOW = new Date(AT.getTime() + 10 * DAY);

const MIGRATIONS = fileURLToPath(new URL("../../store/migrations/", import.meta.url));

/**
 * Every table the migrations create, plus the bookkeeping table `migrate` keeps.
 *
 * Pinned, and held equal to what the live database actually contains by a test
 * below: a snapshot over a list someone forgot to extend is a snapshot that is
 * green because it measured nothing.
 */
const TABLES = [
  "audit_day",
  "audit_entry",
  "baseline",
  "hot_window",
  "namespace",
  "namespace_key",
  "observation",
  "permanent_record",
  "schema_migration",
  "tag",
  "trigger_event",
  "volatility",
] as const;

const ring = keyRingFromEnv({
  NNT_MASTER_KEY: randomBytes(32).toString("base64"),
} as NodeJS.ProcessEnv);

let db: Db;
let clock: FixedClock;
let composed: Composed;
let nsId: string;
let intentObs: string;
let tags: Record<string, StoredTag>;

function requireBaseUrl(): string {
  const url = process.env.NNT_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "NNT_TEST_DATABASE_URL is not set. Run `pnpm --filter @nonametrust/store db:up` and " +
        "export what it prints. This suite fails rather than skips, on purpose: a DB-backed " +
        "gate that skips is a gate that is green on every machine that cannot run it.",
    );
  }
  return url;
}

/** Every session this handle opens confined to one schema. */
function urlForSchema(base: string, schema: string): string {
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}options=-c%20search_path%3D${schema}`;
}

const source = {
  producer: "engine-brief-test",
  producerVersion: "0.1.0",
  network: "testnet",
  fetchedAt: "2026-09-30T00:00:00.000Z",
  ref: "op:0",
};

function wire(over: Record<string, unknown>): WireObservation {
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "ENGINEBRIEF" },
    channel: "price",
    evidenceKind: "event",
    kind: "quote",
    observedAt: "2026-09-25T00:00:00.000Z",
    source,
    payload: { amount: "1.0000000" },
    salienceHints: { amount: "1.0000000" },
    ...over,
  } as WireObservation;
}

async function append(ref: string, channel: string, kind: string): Promise<string> {
  const result = await composed.observations.append(
    wire({ source: { ...source, ref }, channel, kind }),
  );
  if (!result.created) {
    throw new Error(`fixture ${ref} did not create an observation; the seed is not what it says`);
  }
  return result.observation.observationId;
}

/**
 * The version of every row in the database, as one comparable string.
 *
 * `xmin` is the transaction that last wrote each row, so it moves on an UPDATE
 * that changes nothing. Sorted rather than keyed by primary key, because a
 * multiset of versions changes under an insert, a delete and an update alike, and
 * this needs no table's key layout to say so.
 *
 * `db.dynamic.ref<string>("xmin")` is the spelling that works.
 * `db.dynamic.ref("xmin as xmin")` does not: the whole string gets quoted as one
 * identifier.
 */
async function rowVersions(): Promise<string> {
  const parts: string[] = [];
  for (const table of TABLES) {
    const rows = await db.selectFrom(table).select(db.dynamic.ref<string>("xmin")).execute();
    const versions = rows
      .map((r) => String((r as unknown as Record<string, unknown>)["xmin"]))
      .sort();
    parts.push(`${table}:${versions.join(",")}`);
  }
  return parts.join("|");
}

const ids = (): IdSource => {
  let n = 0;
  return { next: (): string => `55555555-0000-4000-8000-00000000000${++n}` };
};

const request = (over: Partial<BriefRequest> = {}): BriefRequest => ({
  intent: { namespaceId: nsId, channel: "price", aspect: "quoted/USDC" },
  observationId: intentObs,
  amount: 100,
  unit: "USDC",
  riskTier: "high",
  ownTagIds: [],
  surprise: null,
  policies: {
    retention: RETENTION_V0,
    tagging: POLICY_V0,
    calibration: CALIBRATION_V0,
    brief: BRIEF_POLICY_V0,
  },
  ...over,
});

const coreInput = (over: Partial<BriefInput> = {}): BriefInput => ({
  at: AT,
  briefId: "66666666-0000-4000-8000-000000000001",
  triggerId: "66666666-0000-4000-8000-000000000002",
  ...request(),
  ...over,
});

beforeAll(async () => {
  const base = requireBaseUrl();
  const admin = openDb(base);
  await admin.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
  await admin.schema.createSchema(SCHEMA).execute();
  await admin.destroy();

  db = openDb(urlForSchema(base, SCHEMA));
  await migrate(db, MIGRATIONS);

  clock = fixedClock(SEED_NOW);
  composed = compose(db, clock, ring, RETENTION_V0);

  intentObs = await append("op:intent", "price", "quote");
  const priceObs = await append("op:price", "price", "quote");
  const addressObs = await append("op:address", "address_integrity", "transition_observed");
  const found = await composed.namespaces.find("wallet", "ENGINEBRIEF");
  nsId = found!.namespaceId;

  // Four tags: one on the same aspect as the intent, one on another aspect of the
  // same channel, one on another channel, and one opened on the INTENT's own
  // observation. Each (channel, aspect) pair is distinct, because the table holds
  // one live tag per pair.
  tags = {
    sameAspect: await composed.tags.open({
      namespaceId: nsId,
      observationId: priceObs,
      channel: "price",
      aspect: "quoted/USDC",
      g0: 1,
      taggedAt: new Date(AT.getTime() - DAY),
    }),
    sameChannel: await composed.tags.open({
      namespaceId: nsId,
      observationId: priceObs,
      channel: "price",
      aspect: "quoted/XLM",
      g0: 1,
      taggedAt: new Date(AT.getTime() - 2 * DAY),
    }),
    sameNamespace: await composed.tags.open({
      namespaceId: nsId,
      observationId: addressObs,
      channel: "address_integrity",
      aspect: "transition",
      g0: 1,
      taggedAt: new Date(AT.getTime() - 3 * DAY),
    }),
    own: await composed.tags.open({
      namespaceId: nsId,
      observationId: intentObs,
      channel: "price",
      aspect: "quoted/OWN",
      g0: 1,
      taggedAt: new Date(AT.getTime() - DAY),
    }),
    // Stamped AFTER the brief's instant, which R43 excludes. Openable because the
    // seeding clock is ten days ahead of `at`.
    future: await composed.tags.open({
      namespaceId: nsId,
      observationId: priceObs,
      channel: "price",
      aspect: "quoted/FUTURE",
      g0: 1,
      taggedAt: new Date(AT.getTime() + 5 * DAY),
    }),
  };
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await db.destroy();
    const cleanup = openDb(requireBaseUrl());
    await cleanup.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
    await cleanup.destroy();
  }
});

describe("the fixture itself", () => {
  it("covers every table the database really has, so the snapshot measures all of them", async () => {
    // SCOPED TO THIS SCHEMA. `getTables()` is not limited by `search_path`, so an
    // unrelated schema left behind by a crashed store run -- or the store's own
    // suites sharing this database -- turned this row red for a reason that has
    // nothing to do with the brief. A review measured exactly that.
    const live = (await db.introspection.getTables())
      .filter((t) => t.schema === SCHEMA)
      .map((t) => t.name)
      .sort();
    expect(live, "a table exists in this schema that rowVersions() does not read").toEqual(
      [...TABLES].sort(),
    );
  });

  it("seeded five live tags under one namespace", async () => {
    const live = await composed.tags.listLive(nsId);
    expect(live).toHaveLength(5);
  });
});

describe("G9: the core writes nothing", () => {
  it("leaves every row's version untouched", async () => {
    const before = await rowVersions();
    const out = await brief(coreInput(), briefDeps(composed, ids()).reads);
    const after = await rowVersions();
    expect(out.reasons.length, "the brief found nothing, so this measures an idle call").toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it("and the measurement can SEE a write, which is what makes the row above mean something", async () => {
    // The control. A snapshot that could not detect a write would satisfy the test
    // above whether the core wrote or not, which is the shape of the green
    // verification this branch has already paid for three times.
    const before = await rowVersions();
    await runBrief(briefDeps(composed, ids()), request({ surprise: 2.5 }));
    const after = await rowVersions();
    expect(after).not.toBe(before);
  });

  it("sees an UPDATE that changes no value, which a row count would miss", async () => {
    // The measurement's own claim, held rather than asserted. Degrading
    // `rowVersions` to a row COUNT survived the first mutation run, because the only
    // write any other row performs is an INSERT and a count catches that too -- so
    // nothing distinguished `xmin` from `length`, while the comment above claimed it
    // did.
    //
    // `suppress` writes the suppression factor the row already carries. The row's
    // contents are identical afterwards and its `xmin` is not, which is the whole
    // reason "no write" is measured this way. Run on the tag R43 excludes, so it
    // cannot change any other row's answer.
    const target = tags["future"]!;
    const countBefore = (await composed.tags.listLive(nsId)).length;
    const before = await rowVersions();

    await composed.tags.suppress(target.tagId, target.suppressionFactor);

    const after = await rowVersions();
    const countAfter = (await composed.tags.listLive(nsId)).length;
    expect(countAfter, "the row count is unchanged, which is the point").toBe(countBefore);
    expect(await composed.tags.get(target.tagId)).toEqual(target);
    expect(after, "xmin did not move on an in-place rewrite").not.toBe(before);
  });

  it("is still true on a brief that finds no reasons at all", async () => {
    const before = await rowVersions();
    await brief(
      coreInput({ intent: { namespaceId: nsId, channel: "latency", aspect: "nothing/here" } }),
      briefDeps(composed, ids()).reads,
    );
    expect(await rowVersions()).toBe(before);
  });
});

describe("G13: the audit row as the chain really stored it", () => {
  it("carries no forbidden key in its RENDERED canonical JSON", async () => {
    // G13 as the plan words it: "asserted over the rendered canonical JSON". R48
    // replaced the regex with a path WALK for a measured reason -- a string value
    // containing `":` fools a regex -- but the walk runs in the engine BEFORE the
    // append, so it cannot see what the chain actually hashed. This reads the row
    // back.
    //
    // It also closes, for the brief path, the one limit the walk has: a `toJSON` on
    // the body or its prototype renders something the walker never saw. `brief()`
    // builds its body from literals so none exists, and this is where that would show.
    const out = await runBrief(briefDeps(composed, ids()), request({ surprise: 2.5 }));
    const stored = await composed.audit.head();
    expect(stored, "the chain has no head, so nothing was appended").not.toBeNull();
    expect(stored!.kind).toBe("brief");

    const canonical = stored!.canonical;
    // Keys, not substrings: a unit or a producer may legitimately contain any text,
    // which is why R48 refused the regex in the first place.
    const keys = [...canonical.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g)].map((m) => m[1]!);
    for (const forbidden of ["payload", "source", "ref", "sourceRef", "evidence", "ciphertext"]) {
      expect(keys, `${forbidden} reached the chain`).not.toContain(forbidden);
    }
    // And every key it DOES carry is one the whitelist admits, at some path.
    const admitted = new Set(
      [...ADMITTED_PATHS].flatMap((path) => path.split(".").map((seg) => seg.replace("[]", ""))),
    );
    for (const key of keys) {
      if (["occurredAt", "policyVersion", "kind", "body"].includes(key)) continue;
      expect(admitted.has(key), `the chain carries a key nobody admitted: ${key}`).toBe(true);
    }
    // The row describes the brief it came from.
    expect(canonical).toContain(out.effects.audit.policyVersion);
  });

  it("stamps its OWN occurredAt, which is why the body carries `at` itself", async () => {
    // `AuditChain.append` takes no instant, so the brief's own `at` has to travel in
    // the body. Under this fixed clock the two are equal; in production `occurredAt`
    // trails `at` by milliseconds, so the property outside a test is `at <= occurredAt`.
    const out = await runBrief(briefDeps(composed, ids()), request());
    const stored = await composed.audit.head();
    const bodyAt = (out.effects.audit.body as { at: string }).at;
    expect(stored!.occurredAt.getTime()).toBeGreaterThanOrEqual(Date.parse(bodyAt));
  });
});

describe("G10: the same inputs replay to the same output", () => {
  it("with the clock ADVANCED between the two runs, and no write between them", async () => {
    // The clock advance is the whole point. A frozen test clock would let a planted
    // `clock.now()` inside the core return the same instant twice, and the first
    // version of this test would have passed with the plant in place.
    //
    // NO WRITE BETWEEN THEM, which is R42: `refresh` overwrites `g0`, `tagged_at`,
    // `refresh_count` and `saturation_state` and keeps no history, so the same
    // inputs against a CHANGED store are not the same question. R1's claim is the
    // same inputs against the same store state.
    const reads = briefDeps(composed, ids()).reads;
    const before = await rowVersions();
    const one = await brief(coreInput(), reads);
    clock.advance(7 * DAY);
    const two = await brief(coreInput(), reads);
    expect(await rowVersions(), "the store changed between the runs, so this proves nothing").toBe(
      before,
    );
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it("replays the audit body byte for byte, including its instant", async () => {
    const reads = briefDeps(composed, ids()).reads;
    const one = await brief(coreInput(), reads);
    clock.advance(DAY);
    const two = await brief(coreInput(), reads);
    expect(JSON.stringify(two.effects.audit.body)).toBe(JSON.stringify(one.effects.audit.body));
    expect((one.effects.audit.body as { at: string }).at).toBe("2026-09-21T00:00:00.000Z");
  });

  it("advances a clock that anything reading one WOULD see, which is what makes the row above mean something", async () => {
    // Deleting `clock.advance(...)` from the replay row SURVIVED the first mutation
    // run. Of course it did: the core has no clock to read, so advancing one cannot
    // change its answer. But that makes the advance an unheld claim -- and the plan
    // requires it precisely because a frozen clock would let a PLANTED `clock.now()`
    // inside the core return the same instant twice.
    //
    // So the advance is shown to be potent against something that does read the
    // clock. `runBrief` reads it, and its two bodies differ by exactly the advance.
    // The core's two bodies, across the same advance, are identical.
    const first = await runBrief(briefDeps(composed, ids()), request());
    const before = (first.effects.audit.body as { at: string }).at;
    clock.advance(3 * DAY);
    const second = await runBrief(briefDeps(composed, ids()), request());
    const after = (second.effects.audit.body as { at: string }).at;

    expect(after, "the clock advance is invisible even to a reader of the clock").not.toBe(before);
    expect(Date.parse(after) - Date.parse(before)).toBe(3 * DAY);
  });

  it("gives a DIFFERENT answer at a different instant, so the replay is not a constant", async () => {
    // The other control. Two identical outputs prove replay only if the function is
    // capable of answering differently.
    const reads = briefDeps(composed, ids()).reads;
    const atSeed = await brief(coreInput({ at: SEED_NOW }), reads);
    const atStart = await brief(coreInput(), reads);
    expect(JSON.stringify(atSeed)).not.toBe(JSON.stringify(atStart));
  });
});

describe("G14: the threshold query and the brief, on real rows", () => {
  /** The same question asked both ways, at one instant. */
  const bothWays = async (at: Date, ownTagIds: readonly string[] = []) => {
    const input = coreInput({ at, ownTagIds });
    const out = await brief(input, briefDeps(composed, ids()).reads);
    const q = await thresholdFor(
      {
        at,
        intent: input.intent,
        observationId: input.observationId,
        ownTagIds,
        policy: input.policies.brief,
        halfLifeMs: input.policies.calibration.halfLifeMs,
      },
      { listLive: (namespaceId: string) => composed.tags.listLive(namespaceId) },
    );
    return { out, q };
  };

  it("read ONE value and name the SAME tags, at the brief's instant", async () => {
    const { out, q } = await bothWays(AT);
    expect(q.base).toBe(out.threshold.base);
    expect(q.applied).toBe(out.threshold.applied);
    expect(q.loweredBy).toEqual(out.threshold.loweredBy);
    expect(out.reasons.length, "an empty agreement is not an agreement").toBeGreaterThan(0);
  });

  it("agree at a LATER instant, where R43 admits a tag the earlier one excluded", async () => {
    const { out, q } = await bothWays(SEED_NOW);
    expect(q.applied).toBe(out.threshold.applied);
    expect(q.loweredBy).toEqual(out.threshold.loweredBy);
    // The instant really does change the answer, so the agreement is not a constant.
    const earlier = await bothWays(AT);
    expect(q.loweredBy.length).toBeGreaterThan(earlier.q.loweredBy.length);
  });

  it("agree when the caller filters a tag out", async () => {
    const { out, q } = await bothWays(AT, [tags["sameAspect"]!.tagId]);
    expect(q.applied).toBe(out.threshold.applied);
    expect(q.loweredBy).toEqual(out.threshold.loweredBy);
    expect(q.loweredBy).not.toContain(tags["sameAspect"]!.tagId);
  });

  it("costs the query ONE read where the brief pays one per reason", async () => {
    // The type says the query needs no `readClear`; this measures it. The brief opens
    // a clear row per reason because a reason reports its dated instant and its source
    // code, and a threshold reports neither.
    const calls: string[] = [];
    const counted: ThresholdReads = {
      listLive: async (namespaceId: string) => {
        calls.push("listLive");
        return composed.tags.listLive(namespaceId);
      },
    };
    const input = coreInput();
    await thresholdFor(
      {
        at: AT,
        intent: input.intent,
        observationId: input.observationId,
        ownTagIds: [],
        policy: input.policies.brief,
        halfLifeMs: input.policies.calibration.halfLifeMs,
      },
      counted,
    );
    expect(calls).toEqual(["listLive"]);
  });

  it("writes nothing, either of them", async () => {
    const before = await rowVersions();
    await bothWays(AT);
    expect(await rowVersions()).toBe(before);
  });
});

describe("R43: a tag stamped after the brief's instant", () => {
  it("is not counted, though the store returns it as live and full strength", async () => {
    // `strengthAt` returns `g0` for every non-positive elapsed, so this tag reads
    // 1.0 at `at` -- evidence that did not exist yet, at a strength it never had.
    const live = await composed.tags.listLive(nsId);
    expect(live.map((t) => t.tagId)).toContain(tags["future"]!.tagId);

    const out = await brief(coreInput(), briefDeps(composed, ids()).reads);
    expect(out.reasons.map((r) => r.tagId)).not.toContain(tags["future"]!.tagId);
  });

  it("IS counted at an instant after it was stamped, so the exclusion is about the instant", async () => {
    const out = await brief(coreInput({ at: SEED_NOW }), briefDeps(composed, ids()).reads);
    expect(out.reasons.map((r) => r.tagId)).toContain(tags["future"]!.tagId);
  });
});

describe("G12: the intent's own tag", () => {
  it("is excluded by its OBSERVATION even when the caller's list is empty (R22)", async () => {
    // `tags.own` was opened on the intent's own observation. An earlier version of
    // this row asserted it COUNTED when `ownTagIds` was empty -- asserting as correct
    // the very failure the plan's acceptance forbids in bold. Two review lenses
    // converged on it independently.
    const out = await brief(coreInput({ ownTagIds: [] }), briefDeps(composed, ids()).reads);
    expect(out.reasons.map((r) => r.tagId)).not.toContain(tags["own"]!.tagId);
  });

  it("is excluded by IDENTITY when its observation is someone else's (R41)", async () => {
    // The case only the identity filter catches: a tag the intent REFRESHED keeps
    // its opening observation's id, so R22's filter cannot see it. `sameAspect` was
    // opened on `priceObs`, which is not the intent's observation, so it stands in
    // for a refreshed tag here.
    const reads = briefDeps(composed, ids()).reads;
    const counted = await brief(coreInput(), reads);
    const filtered = await brief(coreInput({ ownTagIds: [tags["sameAspect"]!.tagId] }), reads);

    expect(counted.reasons.map((r) => r.tagId)).toContain(tags["sameAspect"]!.tagId);
    expect(filtered.reasons.map((r) => r.tagId)).not.toContain(tags["sameAspect"]!.tagId);
    expect(filtered.threshold.applied).toBeGreaterThan(counted.threshold.applied);
  });

  it("keeps its OPENING observation, which is why one filter is not enough", async () => {
    // The measured hole R41 closes, stated on the real rows: a refresh does not move
    // `observation_id`. The intent's own tag really does carry the intent's
    // observation, so R22's filter sees it; a refreshed one would not, which is why
    // the core applies both.
    expect(tags["own"]!.observationId).toBe(intentObs);
    expect(tags["sameAspect"]!.observationId).not.toBe(intentObs);
  });
});

describe("G20: a brief on an erased namespace", () => {
  it("is refused by name, and writes nothing", async () => {
    // Runs LAST and on its own namespace, because a shred is not undoable.
    const otherObs = await append("op:other", "price", "quote");
    const other = await composed.namespaces.find("wallet", "ENGINEBRIEF");
    expect(other!.namespaceId).toBe(nsId);

    // A second namespace, so the shred does not take the fixture with it.
    const secondResult = await composed.observations.append(
      wire({
        source: { ...source, ref: "op:second" },
        namespace: { kind: "wallet", id: "ENGINEBRIEFERASED" },
      }),
    );
    if (!secondResult.created) throw new Error("the second namespace's fixture did not create");
    const secondNs = (await composed.namespaces.find("wallet", "ENGINEBRIEFERASED"))!.namespaceId;
    const secondObs = secondResult.observation.observationId;
    void otherObs;

    await composed.namespaces.shred(secondNs);

    const before = await rowVersions();
    await expect(
      runBrief(
        briefDeps(composed, ids()),
        request({
          intent: { namespaceId: secondNs, channel: "price", aspect: "quoted/USDC" },
          observationId: secondObs,
          surprise: 2.5,
        }),
      ),
    ).rejects.toThrow(new RegExp(`namespace ${secondNs} has been erased`));
    expect(await rowVersions(), "a refused brief wrote something").toBe(before);
  });
});
