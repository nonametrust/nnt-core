import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { CALIBRATION_V0, POLICY_V0, emptyBaseline, updateBaseline, robustScale, scaleFloorFor } from "@nonametrust/tagging";
import {
  Deadlocked,
  NamespaceShredded,
  fixedClock,
  keyRingFromEnv,
  migrate,
  openDb,
  RETENTION_V0,
  type Db,
  type FixedClock,
} from "@nonametrust/store";
import { compose, type Composed } from "./compose.js";
import { BRIEF_POLICY_V0 } from "./policy.js";
import { observe, RefusedObservation } from "./observe.js";
import { AuditEntryMissing } from "./run-brief.js";
import type { BriefPolicies } from "./brief.js";

// Task 8b: R10, R21, R23, R24, R28 — the ingest path, against a real database.
//
// R10 IS WHY THIS FILE IS DB-BACKED AND NOT STUBBED. The ruling replaced a wrong one
// and carries its measurement: "baseline first, then tag, and the retry re-reads both"
// does not avoid the double fold, it CREATES a committed fold with no tag, and the
// retry then folds a second time because `tagReading` always computes
// `next = updateBaseline(before, value)` and the re-read baseline already holds the
// first fold. Measured with the real repositories: one writer retried once left
// `count = 12` for 11 observations, with the mean moved.
//
// So the witness is the MEAN as well as the count — a retry that re-reads without
// rolling back moves the mean while the count can still look right.

const SCHEMA = "engine_observe_test";
const MIGRATIONS = fileURLToPath(new URL("../../store/migrations/", import.meta.url));
const AT = new Date("2026-09-21T00:00:00.000Z");

const ring = keyRingFromEnv({
  NNT_MASTER_KEY: randomBytes(32).toString("base64"),
} as NodeJS.ProcessEnv);

let db: Db;
let clock: FixedClock;
let composed: Composed;
let base: string;

const policies: BriefPolicies = {
  retention: RETENTION_V0,
  tagging: POLICY_V0,
  calibration: CALIBRATION_V0,
  brief: BRIEF_POLICY_V0,
};

function requireBaseUrl(): string {
  const url = process.env.NNT_TEST_DATABASE_URL;
  if (!url) throw new Error("NNT_TEST_DATABASE_URL is not set; this suite fails rather than skips.");
  return url;
}

const urlFor = (schema: string): string =>
  `${base}${base.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;

const source = {
  producer: "engine-observe-test",
  producerVersion: "0.1.0",
  network: "testnet",
  fetchedAt: "2026-09-30T00:00:00.000Z",
  ref: "op:0",
};

const wire = (over: Record<string, unknown>): WireObservation =>
  ({
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "OBSERVEDB" },
    channel: "volume",
    evidenceKind: "event",
    kind: "payment",
    observedAt: "2026-09-20T00:00:00.000Z",
    source,
    payload: { amount: "10.0000000", assetCode: "USDC", direction: "in" },
    ...over,
  }) as WireObservation;

/** One observation per `ref`, so each is a distinct idempotency key. */
const payment = (ref: string, amount: string, nsId = "OBSERVEDB"): WireObservation =>
  wire({
    source: { ...source, ref },
    namespace: { kind: "wallet", id: nsId },
    payload: { amount, assetCode: "USDC", direction: "in" },
  });

beforeAll(async () => {
  base = requireBaseUrl();
  const admin = openDb(base);
  await admin.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
  await admin.schema.createSchema(SCHEMA).execute();
  await admin.destroy();

  db = openDb(urlFor(SCHEMA));
  await migrate(db, MIGRATIONS);
  clock = fixedClock(AT);
  composed = compose(db, clock, ring, RETENTION_V0);
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await db.destroy();
    const cleanup = openDb(base);
    await cleanup.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
    await cleanup.destroy();
  }
});

/** The baseline for one pair, or null. */
async function baselineOf(nsId: string, channel: string, aspect: string) {
  const all = await composed.baselines.forNamespace(nsId);
  return all.find((b) => b.channel === channel && b.aspect === aspect) ?? null;
}

const namespaceIdOf = async (id: string): Promise<string> =>
  (await composed.namespaces.find("wallet", id))!.namespaceId;

describe("observe: one observation", () => {
  it("folds it, tags nothing yet, and returns the reading a brief would be handed", async () => {
    const out = await observe(composed, payment("op:one", "10.0000000", "ONE"), policies);

    expect(out.created).toBe(true);
    expect(out.folded).toBe(true);
    expect(out.observationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.intent.briefable).toBe(true);
    expect(out.intent.briefable === true && out.intent.reading).toMatchObject({
      channel: "volume",
      aspect: "amount/USDC/in",
    });

    const nsId = await namespaceIdOf("ONE");
    const baseline = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(baseline!.count).toBe(1);
    expect(baseline!.mean).toBeCloseTo(10, 12);

    // A first observation is COLD, so no surprise and no tag (R29). That is the
    // commonest ingest and it must not be an error.
    expect(out.surprise).toBeNull();
    expect(out.ownTagIds).toEqual([]);
  }, 30_000);

  it("carries the namespace the STORE assigned, not one the caller invented", async () => {
    // The reading's namespace is what R57 compares against the observation's, so it has
    // to be the store's own id. `readingsOf` cannot derive it from the wire, which is
    // why `observe` takes it from the append result.
    const out = await observe(composed, payment("op:ns", "10.0000000", "NSCHECK"), policies);
    const nsId = await namespaceIdOf("NSCHECK");
    expect(out.intent.briefable === true && out.intent.reading.namespaceId).toBe(nsId);
  }, 30_000);
});

describe("R23: a re-delivery folds nothing and says so", () => {
  it("leaves the count at plus one and returns folded: false", async () => {
    // `append` answers `{created:false, readable:true}` on a repeat -- the indexer's
    // normal retry path. Nothing records which observations a baseline has absorbed, so
    // a re-delivery cannot tell whether the first fold landed, and folding again
    // double-counts.
    const observation = payment("op:redelivery", "42.0000000", "REDELIVER");
    const first = await observe(composed, observation, policies);
    expect(first.created).toBe(true);
    expect(first.folded).toBe(true);

    const nsId = await namespaceIdOf("REDELIVER");
    const after = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(after!.count).toBe(1);

    const again = await observe(composed, observation, policies);
    expect(again.created).toBe(false);
    expect(again.folded).toBe(false);
    expect(again.observationId).toBe(first.observationId);

    const unchanged = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(unchanged!.count, "the re-delivery folded").toBe(1);
    expect(unchanged!.mean).toBe(after!.mean);
  }, 30_000);

  it("still returns the reading, so a caller can brief on a re-delivered intent", async () => {
    const observation = payment("op:redeliver2", "7.0000000", "REDELIVER2");
    await observe(composed, observation, policies);
    const again = await observe(composed, observation, policies);
    expect(again.intent.briefable).toBe(true);
  }, 30_000);
});

describe("R10: the fold and the tag write are ONE transaction", () => {
  it("leaves n at forty AND the mean a serial fold's, under forty concurrent writers", async () => {
    // The plan's acceptance, and the witness is the MEAN as well as the count: a retry
    // that re-reads without rolling back moves the mean while the count can still look
    // right. Forty distinct amounts, so a lost or doubled fold moves it detectably.
    const amounts = Array.from({ length: 40 }, (_, i) => `${i + 1}.0000000`);
    const observations = amounts.map((a, i) => payment(`op:c${i}`, a, "CONCURRENT"));

    // THE SHIPPED `maxRetries` OF 5 IS NOT ENOUGH FOR FORTY-WAY CONTENTION ON ONE
    // PAIR, and that is measured rather than assumed: the first run of this row failed
    // with "observe gave up after 6 attempts". Optimistic concurrency means the Nth
    // writer loses to every writer that commits between its read and its own commit,
    // so the retries needed grow with the contention, and the bound is a policy number
    // nobody has calibrated against a fleet.
    //
    // The row uses a bound large enough to measure what it is about -- that the fold
    // is correct under concurrency -- and the fact that the default does not reach it
    // is a finding, recorded in the ledger rather than hidden by this line.
    const contended = { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 200 } };
    const results = await Promise.all(observations.map((o) => observe(composed, o, contended)));
    expect(results.filter((r) => r.folded).length, "not every writer folded").toBe(40);

    const nsId = await namespaceIdOf("CONCURRENT");
    const baseline = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(baseline!.count, "the count is not forty").toBe(40);

    // THE PLAN'S WITNESS IS NOT WELL-DEFINED, and that is measured rather than argued.
    // Its acceptance says "the mean equal to a serial fold's" -- but `updateBaseline`
    // WINSORIZES against the running median and MAD, so the fold is order-dependent and
    // there is no single serial mean to equal. Measured on exactly this fixture:
    // ascending gives 16.473, descending 24.527, a shuffle 15.334 -- a spread of 9.19,
    // where the plain arithmetic mean is 20.5. Forty concurrent writers commit in an
    // arbitrary order, so demanding one particular serial mean would be demanding one
    // particular interleaving.
    //
    // What IS well-defined, and still catches what the witness exists for: the result
    // must be a serial fold of THESE FORTY VALUES IN SOME ORDER. A lost fold, a doubled
    // fold, or a retry that re-read without rolling back all produce a state no
    // ordering of the forty can produce. The envelope is computed here from the same
    // arithmetic rather than hard-coded, so it moves with the policy.
    const floor = scaleFloorFor(POLICY_V0, "volume", "amount/USDC/in");
    const foldInOrder = (xs: readonly string[]) => {
      let state = emptyBaseline(nsId, "volume", "amount/USDC/in");
      for (const a of xs) {
        state = updateBaseline(state, Number(a), robustScale(state, floor), POLICY_V0);
      }
      return state;
    };

    const means: number[] = [];
    const ordered = [...amounts];
    means.push(foldInOrder(ordered).mean);
    means.push(foldInOrder([...ordered].reverse()).mean);
    for (let trial = 0; trial < 200; trial++) {
      const shuffled = [...ordered];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      means.push(foldInOrder(shuffled).mean);
    }
    const low = Math.min(...means);
    const high = Math.max(...means);
    expect(high - low, "the fixture is order-independent, so this envelope proves nothing").toBeGreaterThan(1);

    expect(
      baseline!.mean,
      `the mean ${baseline!.mean} is outside every ordering of these forty ` +
        `(${low.toFixed(3)}..${high.toFixed(3)}), so a fold was lost, doubled, or folded twice`,
    ).toBeGreaterThanOrEqual(low);
    expect(baseline!.mean).toBeLessThanOrEqual(high);

    // And the count is exact, which is the half an envelope cannot give.
    expect(baseline!.count).toBe(40);
  }, 120_000);
});

describe("R21: a refusal is recorded as a CODE and an observation id", () => {
  const huge = "9".repeat(309);

  it("refuses a 309-digit amount with its code, and the row exists to name it by", async () => {
    // Task 8's acceptance in as many words. The observation is APPENDED first, which is
    // what gives the refusal an id to carry -- `append` parses the envelope only, so a
    // payload this large reaches tagging and its RangeError names the whole value.
    const failure = await observe(
      composed,
      payment("op:huge", huge, "HUGEAMOUNT"),
      policies,
    ).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );

    expect(failure, "the 309-digit amount was accepted").not.toBeNull();
    expect(failure!.code).toBe("OBSERVATION_UNREADABLE");
    expect(failure!.observationId).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  it("keeps the refusal's MESSAGE TEXT out of everything it carries", async () => {
    // "the refusal's message text appears nowhere in the audit body" -- the acceptance's
    // own words. The value lives on `cause` for a human reading stderr and nowhere a
    // recorder would reach.
    // Narrowed rather than cast: `.catch` widens the union to include the success
    // value, and `pnpm typecheck` caught that while `pnpm test` was green -- the third
    // time those two have diverged on this branch.
    const failure = await observe(composed, payment("op:huge2", huge, "HUGEAMOUNT2"), policies).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(failure, "the 309-digit amount was accepted").not.toBeNull();

    expect(failure!.message).not.toContain(huge);
    expect(JSON.stringify(failure)).not.toContain("999999");
    expect(Object.values(failure!).join("|")).not.toContain("999999");
  }, 30_000);

  it("lets the NEXT observation proceed, so one refusal does not halt ingest", async () => {
    await observe(composed, payment("op:huge3", huge, "AFTERHUGE"), policies).catch(() => undefined);
    const out = await observe(composed, payment("op:after", "5.0000000", "AFTERHUGE"), policies);
    expect(out.folded).toBe(true);
  }, 30_000);
});

describe("an erased namespace", () => {
  it("refuses a NEW observation by name", async () => {
    await observe(composed, payment("op:erase1", "1.0000000", "TOERASE"), policies);
    const nsId = await namespaceIdOf("TOERASE");
    await composed.namespaces.shred(nsId);

    await expect(
      observe(composed, payment("op:erase2", "2.0000000", "TOERASE"), policies),
    ).rejects.toBeInstanceOf(NamespaceShredded);
  }, 30_000);
});

describe("R24: an audit row that never lands is NAMED, not rolled back", () => {
  it("leaves the fold and the tag committed, and says so by name", async () => {
    // The chain's job is to record what happened, not to be the transaction log. So an
    // exhausted append does NOT undo a committed fold -- it names the inconsistency and
    // writes the condition to structured stderr, because the chain cannot record its
    // own absence.
    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    // A composition whose audit chain always refuses. Everything else is the real one.
    const broken: Composed = {
      ...composed,
      audit: {
        ...composed.audit,
        append: async () => {
          throw new Deadlocked("deadlock detected");
        },
      } as unknown as Composed["audit"],
    };

    try {
      await expect(
        observe(broken, payment("op:noaudit", "11.0000000", "NOAUDIT"), {
          ...policies,
          brief: { ...BRIEF_POLICY_V0, maxRetries: 1 },
        }),
      ).rejects.toBeInstanceOf(AuditEntryMissing);
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }

    // NOT ROLLED BACK: the fold is there.
    const nsId = await namespaceIdOf("NOAUDIT");
    const baseline = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(baseline!.count, "the fold was rolled back to keep the chain tidy").toBe(1);

    // And the condition reached stderr, as one structured line carrying ids and a code.
    const reported = lines.map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    }).filter((l): l is Record<string, unknown> => l !== null);
    const missing = reported.find((l) => l["event"] === "engine.observe.audit_entry_missing");
    expect(missing, "the outage was never written to stderr").toBeDefined();
    expect(missing!["code"]).toBe("AUDIT_ENTRY_MISSING");
    expect(missing!["observationId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(missing!)).not.toContain("message");
  }, 60_000);
});

describe("R24: the audit row is written after the transaction commits", () => {
  it("appends one entry naming the observation, and the fold is already visible", async () => {
    const before = await composed.audit.head();
    const out = await observe(composed, payment("op:audit", "3.0000000", "AUDITED"), policies);
    const after = await composed.audit.head();

    expect(after).not.toBeNull();
    expect(after!.seq).not.toBe(before?.seq);
    expect(after!.kind).toBe("observe");
    expect(after!.canonical).toContain(out.observationId);
    // The chain records what happened; the fold is committed whether or not the row
    // followed, which is why R24 makes a missing one a named inconsistency.
    const nsId = await namespaceIdOf("AUDITED");
    expect((await baselineOf(nsId, "volume", "amount/USDC/in"))!.count).toBe(1);
  }, 30_000);
});
