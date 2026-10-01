import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { CALIBRATION_V0, POLICY_V0, emptyBaseline, judgeSurprise, updateBaseline, robustScale, scaleFloorFor } from "@nonametrust/tagging";
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
import { assertObserveBody } from "./audit-body.js";
import { compositePolicyVersion } from "./composite-version.js";
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
    // The plan's acceptance, satisfied LITERALLY. An earlier version of this row used
    // the amounts 1 through 40, found the fold order-dependent, and concluded the
    // plan's sentence could not be satisfied. That conclusion was wrong and the cause
    // was the fixture: `scaleFloor` for this pair is 0.05 and `winsorMadMultiple` is 3,
    // so the winsorising band is ±0.15 around the running location and 1..40 clips on
    // nearly every step.
    //
    // WITHIN THE BAND THE FOLD IS ORDER-INDEPENDENT. Measured over 2000 random orders
    // of the fixture below: the mean varies by 1.2e-14 and `m2` by 1.9e-15, and the
    // mean equals the arithmetic mean to fourteen digits. So there IS one serial fold
    // to equal, for any interleaving the database chooses.
    //
    // The envelope that replaced it detected nothing: it was 24.7 wide, and forty
    // copies of a single wrong value passed it, as did one-lost-plus-one-doubled in
    // 99.6% of orders. It is gone.
    const amounts = Array.from({ length: 40 }, (_, i) => (10 + i * 0.001).toFixed(7));
    const observations = amounts.map((a, i) => payment(`op:c${i}`, a, "CONCURRENT"));

    const contended = { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 200 } };
    const results = await Promise.all(observations.map((o) => observe(composed, o, contended)));
    expect(results.filter((r) => r.folded).length, "not every writer folded").toBe(40);

    const nsId = await namespaceIdOf("CONCURRENT");
    const baseline = await baselineOf(nsId, "volume", "amount/USDC/in");

    // The serial fold, through tagging's own arithmetic rather than assumed.
    const floor = scaleFloorFor(POLICY_V0, "volume", "amount/USDC/in");
    let serial = emptyBaseline(nsId, "volume", "amount/USDC/in");
    for (const a of amounts) {
      serial = updateBaseline(serial, Number(a), robustScale(serial, floor), POLICY_V0);
    }

    expect(baseline!.count, "the count is not forty").toBe(40);
    expect(baseline!.mean, "the mean moved, so a fold was lost or doubled").toBeCloseTo(
      serial.mean,
      9,
    );
    // `m2` is the second order-independent moment, and it moves where the mean might
    // not: one lost plus one doubled shifts it detectably while the count stays exact.
    expect(baseline!.m2, "the second moment moved").toBeCloseTo(serial.m2, 9);
  }, 120_000);

  it("would SEE a lost or doubled fold, which is what makes the row above mean something", async () => {
    // The control the envelope never had. A witness that passes forty wrong values is
    // not a witness, and this is how that is known rather than hoped: the same
    // assertions, against a baseline built from a deliberately wrong multiset.
    const amounts = Array.from({ length: 40 }, (_, i) => (10 + i * 0.001).toFixed(7));
    const floor = scaleFloorFor(POLICY_V0, "volume", "amount/USDC/in");
    const fold = (xs: readonly string[]) => {
      let state = emptyBaseline("ns", "volume", "amount/USDC/in");
      for (const a of xs) state = updateBaseline(state, Number(a), robustScale(state, floor), POLICY_V0);
      return state;
    };
    const honest = fold(amounts);
    const oneLostOneDoubled = fold([...amounts.slice(0, 39), amounts[0]!]);
    const allWrong = fold(Array.from({ length: 40 }, () => "10.0195000"));

    expect(oneLostOneDoubled.count, "the count alone cannot see this").toBe(honest.count);
    expect(allWrong.count).toBe(honest.count);
    // Both are caught by the assertions the row above makes, at the precision it uses.
    expect(Math.abs(oneLostOneDoubled.mean - honest.mean)).toBeGreaterThan(1e-9);
    expect(Math.abs(allWrong.m2 - honest.m2)).toBeGreaterThan(1e-9);
  });
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

describe("a state whose validity has passed", () => {
  it("is folded and opens NO tag", async () => {
    // The plan's acceptance clause, and a mutant deleting `|| !holds` SURVIVED the
    // whole suite before this row: no test drove a `state` observation through
    // `observe` at all. `holdsAt` is the single exempt date reader and an event always
    // holds, so only a state can exercise it.
    //
    // Categorical readings always produce a tag decision, so `protocol` is the channel
    // that makes the absence visible: a live state tags, an expired one must not.
    // A STATE CARRIES AN INTERVAL AND NO INSTANT. The union is strict in both
    // directions, so `observedAt` must be absent -- built from the fields rather than
    // spread over the event helper, which carries one.
    const state = (ref: string, validUntil: string, nsId: string): WireObservation =>
      ({
        schemaVersion: "0.1.0",
        namespace: { kind: "wallet", id: nsId },
        channel: "protocol",
        evidenceKind: "state",
        kind: "event_observed",
        validFrom: "2026-09-01T00:00:00.000Z",
        validUntil,
        source: { ...source, ref },
        payload: { event: "trustline_open" },
      }) as unknown as WireObservation;

    // Still valid at the clock's instant: it tags.
    const live = await observe(composed, state("op:live", "2026-12-01T00:00:00.000Z", "STATELIVE"), policies);
    expect(live.folded).toBe(true);
    expect(live.ownTagIds, "a live state opened no tag, so the row below proves nothing").toHaveLength(1);

    // Expired before it: same channel, same payload, no tag.
    const expired = await observe(composed, state("op:expired", "2026-09-05T00:00:00.000Z", "STATEDEAD"), policies);
    expect(expired.folded).toBe(true);
    expect(expired.ownTagIds, "a state past its validity opened a tag").toEqual([]);

    const nsId = await namespaceIdOf("STATEDEAD");
    expect(await composed.tags.listLive(nsId)).toEqual([]);
  }, 30_000);
});

describe("R25: the audit body carries no payload field", () => {
  it("keeps an address-shaped assetCode out of the chain", async () => {
    // A review measured this reaching `audit.head().canonical` verbatim: an aspect is
    // templated from the payload and the schema bounds none of those strings, so a
    // 56-character address-shaped `assetCode` went into a hash-chained row that
    // outlives every key.
    const address = `G${"A".repeat(55)}`;
    const out = await observe(
      composed,
      wire({
        source: { ...source, ref: "op:addr" },
        namespace: { kind: "wallet", id: "ADDRLEAK" },
        payload: { amount: "1.0000000", assetCode: address, direction: "in" },
      }),
      policies,
    );
    const head = await composed.audit.head();
    expect(head!.canonical, "an address reached the chain").not.toContain(address);
    expect(head!.canonical, "the aspect reached the chain").not.toContain("amount/");
    // What it DOES carry: ids, an instant, and a count.
    expect(head!.canonical).toContain(out.observationId);
  }, 30_000);
});

describe("the third append arm is NAMED, not collapsed into a re-delivery", () => {
  it("says the source will not open when the namespace was erased", async () => {
    // `append` has three arms. A re-delivery whose namespace was erased answers
    // `{created:false, readable:false}` with its own flags, and was returned as an
    // ordinary re-delivery with a briefable reading and nothing saying otherwise.
    const observation = payment("op:thirdarm", "1.0000000", "THIRDARM");
    const first = await observe(composed, observation, policies);
    expect(first.readable).toBe(true);
    expect(first.namespaceErased).toBe(false);

    const nsId = await namespaceIdOf("THIRDARM");
    await composed.namespaces.shred(nsId);

    const again = await observe(composed, observation, policies);
    expect(again.created).toBe(false);
    expect(again.folded).toBe(false);
    expect(again.readable, "an erased re-delivery was reported as readable").toBe(false);
    expect(again.namespaceErased).toBe(true);
  }, 30_000);
});

describe("R21: an envelope the schema rejects, before any row exists", () => {
  it("is wrapped in a code, with no id and no wire content", async () => {
    // `append` runs `observationSchema.parse` before any row exists, and a zod refusal
    // carries wire content -- a review measured an unknown key shaped like an address
    // arriving verbatim. No observation id exists to name it by, which is a reason to
    // omit the id and NOT a reason to let the message escape.
    const address = `G${"B".repeat(55)}`;
    const bad = { ...(payment("op:zod", "1.0000000", "ZODLEAK") as object), [address]: 1 };
    const failure = await observe(composed, bad as unknown as WireObservation, policies).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(failure, "the malformed envelope was accepted").not.toBeNull();
    expect(failure!.code).toBe("OBSERVATION_INVALID");
    expect(failure!.observationId, "an id was invented for a row that does not exist").toBeNull();
    expect(failure!.message).not.toContain(address);
    expect(JSON.stringify(failure)).not.toContain(address);
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

    let thrown: AuditEntryMissing | null = null;
    try {
      thrown = await observe(broken, payment("op:noaudit", "11.0000000", "NOAUDIT"), {
        ...policies,
        brief: { ...BRIEF_POLICY_V0, maxRetries: 1 },
      }).then(
        () => null,
        (e: unknown) => e as AuditEntryMissing,
      );
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }
    expect(thrown, "a lost chain entry was not named").toBeInstanceOf(AuditEntryMissing);

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

    // R28's SUBJECT ON THE AUDIT RETRY TOO. Dropping `subject: observationId`
    // from this `retrying` call survived the whole suite: this row asserted the
    // stderr line's id, which is written by hand a few lines later in the source,
    // and never the exhausted retry's own. They are different claims and the
    // second one was unheld.
    const cause = (thrown!.cause as Error | undefined);
    expect(cause, "the named inconsistency carried no cause").toBeDefined();
    expect(cause!.message, "the exhausted audit retry named no observation").toContain(
      String(missing!["observationId"]),
    );
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

// ===========================================================================
// What a mutation audit of this path measured, and the rows that hold it now.
//
// The audit ran 83 mutants and 17 of them SURVIVED the whole suite. Four groups:
// the tag write (R10's own named defect -- a committed fold with no tag -- turned
// nothing red), `holdsAt`, the `surprise` return, and every field of the audit
// body but two. Plus three properties held only indirectly: "every read is inside
// the transaction" was held in the narrower form "the retry re-reads", R9's
// `expectedCount` was held only by the R10 forty-writer row and only through
// retry exhaustion, and `at` coming from the composition clock was held only by a
// source scan.
//
// Each row below names the mutant it was written for, so a later task that
// disarms one is a red test rather than a silent loss.
// ===========================================================================

describe("R10: every read the fold makes is on the TRANSACTION's connection", () => {
  it("reaches for no repository outside the transaction", async () => {
    // THE DOCSTRING'S PROPERTY, HELD AT LAST. `observe` says "every read is
    // inside, so the retry re-runs them". The audit measured that moving the
    // baseline read OUTSIDE the transaction but inside `retrying` survived the
    // whole suite: what the suite held was only the second half of the sentence.
    //
    // A PROXY AND NOT A SCAN. The fold composes again onto `trx`, so its
    // repositories are the inner ones; a read through the OUTER composition is a
    // read on a different connection, and that is observable without any
    // arrangement of commits -- the outer object simply must not be touched.
    //
    // This also retires a mutant that previously "died" only by deadlocking the
    // pool: replacing `compose(trx, …)` with the outer `composed` inside the
    // transaction left all ten pool backends idle-in-transaction and took 340
    // seconds to fail on vitest's own timeouts. It now fails in milliseconds.
    const reached: string[] = [];
    const guarded = new Proxy(composed, {
      get(target, key, receiver): unknown {
        if (key === "baselines" || key === "tags") {
          reached.push(String(key));
          throw new Error(`observe reached composed.${String(key)} outside the transaction`);
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as Composed;

    const out = await observe(guarded, payment("op:proxy", "7.0000000", "PROXYNS"), policies);
    expect(out.folded).toBe(true);
    expect(reached, "the fold read a repository on the outer connection").toEqual([]);

    // And the fold really happened, so this is not a green over a path that did
    // nothing.
    const nsId = await namespaceIdOf("PROXYNS");
    expect((await baselineOf(nsId, "volume", "amount/USDC/in"))!.count).toBe(1);
  }, 30_000);

  it("writes BOTH the opened and the refreshed tag on the transaction, not only the baseline", async () => {
    // A SECOND SURVIVOR, found by mutating after the row above was green: moving
    // `inner.tags.refresh` to `composed.tags.refresh` survived everything,
    // INCLUDING the Proxy row -- because that row drives a cold volume event,
    // which opens no tag at all, so neither tag branch was ever reached through
    // the guard. R10's named defect is "a committed fold with no tag", and the tag
    // side of it was unheld.
    //
    // `protocol` is categorical, so it always produces a decision: the first
    // observation exercises `findLive` and `open`, the second `findLive` and
    // `refresh`. Both go through the guarded composition.
    const reached: string[] = [];
    let handleReads = 0;
    const guarded = new Proxy(composed, {
      get(target, key, receiver): unknown {
        if (key === "baselines" || key === "tags") {
          reached.push(String(key));
          throw new Error(`observe reached composed.${String(key)} outside the transaction`);
        }
        if (key === "handle") handleReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as Composed;

    const event = (ref: string, observedAt: string): WireObservation =>
      wire({
        source: { ...source, ref },
        namespace: { kind: "wallet", id: "PROXYTAGS" },
        channel: "protocol",
        kind: "event_observed",
        observedAt,
        payload: { event: "trustline_open" },
      });

    const opened = await observe(guarded, event("op:pt1", "2026-09-20T00:00:00.000Z"), policies);
    expect(opened.ownTagIds, "the guarded ingest opened no tag").toHaveLength(1);
    const refreshed = await observe(guarded, event("op:pt2", "2026-09-20T06:00:00.000Z"), policies);
    expect(refreshed.ownTagIds, "the guarded ingest refreshed no tag").toEqual(opened.ownTagIds);

    expect(reached, "a tag was written on the outer connection").toEqual([]);

    // AND `handle` IS TOUCHED EXACTLY TWICE -- once per `observe` call, for the one
    // `transaction()`. A review found the hole this closes: the guard traps the
    // IDENTIFIERS `composed.baselines` and `composed.tags`, so a nested
    // `compose(composed.handle, ...)` built inside the transaction reads on the
    // outer connection while touching neither name, and the control row below
    // positively asserts that `handle` passes. Counting it is what turns the
    // guard from a rule about spelling into a rule about the connection: a second
    // composition needs a second `handle` read.
    expect(handleReads, "the ingest path reached for the handle more than once per call").toBe(2);
    const nsId = await namespaceIdOf("PROXYTAGS");
    const live = await composed.tags.listLive(nsId);
    expect(live).toHaveLength(1);
    expect(live[0]!.refreshCount).toBe(1);
  }, 60_000);

  it("and the guard DOES trap, which is what makes the row above mean something", () => {
    // The control. A proxy whose trap never fires would make the assertion above
    // pass over a composition nothing was checking.
    const guarded = new Proxy(composed, {
      get(target, key, receiver): unknown {
        if (key === "baselines" || key === "tags") throw new Error(`trapped ${String(key)}`);
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as Composed;
    expect(() => guarded.baselines).toThrow(/trapped baselines/);
    expect(() => guarded.tags).toThrow(/trapped tags/);
    // And it lets through exactly what the ingest path legitimately needs.
    expect(guarded.clock).toBe(composed.clock);
    expect(guarded.ring).toBe(composed.ring);
    expect(guarded.handle).toBe(composed.handle);
    expect(guarded.observations).toBe(composed.observations);
    expect(guarded.namespaces).toBe(composed.namespaces);
  });
});

describe("the ingest entry's audit body, read BACK out of the chain", () => {
  it("carries the ids, the instant and the reading count, and nothing else", async () => {
    // FOUR MUTANTS SURVIVED HERE: `tagIds` dropped, `at` dropped, `aspects`
    // dropped (while it was still present), and `policyVersion` reduced to
    // tagging's version alone. Nothing read the body back and nothing typed it.
    //
    // `protocol` is the channel, because a categorical reading always produces a
    // tag decision -- so `tagIds` is NON-EMPTY here and dropping it is visible. A
    // volume event on a cold namespace opens nothing, and a row asserting `[]`
    // cannot tell an empty list from a missing field.
    const out = await observe(
      composed,
      wire({
        source: { ...source, ref: "op:bodyback" },
        namespace: { kind: "wallet", id: "BODYBACK" },
        channel: "protocol",
        kind: "event_observed",
        payload: { event: "trustline_open" },
      }),
      policies,
    );
    expect(out.ownTagIds, "no tag was opened, so this row would prove nothing").toHaveLength(1);

    const head = await composed.audit.head();
    const body = head!.body as Record<string, unknown>;
    const nsId = await namespaceIdOf("BODYBACK");

    // EXACTLY these keys. A sixth would be a field nothing refused.
    expect(Object.keys(body).sort()).toEqual(["at", "namespaceId", "observationId", "tagIds"]);
    expect(body["observationId"]).toBe(out.observationId);
    expect(body["namespaceId"]).toBe(nsId);
    // THE COMPOSITION CLOCK'S INSTANT, by value. `at` was held only by
    // `clock-gate.test.ts`, a source scan: swapping it for `new Date()` changed
    // the row and no behavioural test noticed.
    expect(body["at"]).toBe(AT.toISOString());
    expect(body["tagIds"]).toEqual(out.ownTagIds);
  }, 30_000);

  it("carries all FOUR policy versions, R26, and not one of them alone", async () => {
    const out = await observe(composed, payment("op:pv", "2.0000000", "POLICYVER"), policies);
    const head = await composed.audit.head();
    expect(head!.canonical).toContain(out.observationId);

    const expected = compositePolicyVersion({
      retention: RETENTION_V0.version,
      tagging: POLICY_V0.version,
      calibration: CALIBRATION_V0.version,
      brief: BRIEF_POLICY_V0.version,
    });
    expect(head!.policyVersion).toBe(expected);
    // The control: reducing it to tagging's version alone was the surviving
    // mutant, and that is a DIFFERENT string -- so the assertion above can tell.
    expect(head!.policyVersion).not.toBe(POLICY_V0.version);
    expect(head!.policyVersion.split("/")).toHaveLength(4);
  }, 30_000);

  it("refuses a body the chain must not carry, at the ingest path and not only in the brief", async () => {
    // The assertion is called on what the STORE handed back -- the tag ids are
    // `open`'s own return values and the namespace id came from a namespace row,
    // and none of the three was validated on the way in. Held here with the
    // shapes those values could really take.
    expect(() =>
      assertObserveBody({
        observationId: "obs-1",
        namespaceId: "ns-1",
        at: AT.toISOString(),
        tagIds: ["tag-1"],
      }),
    ).not.toThrow();
    expect(() =>
      assertObserveBody({
        observationId: "obs-1",
        namespaceId: "ns-1",
        at: AT.toISOString(),
        tagIds: [" "],
      }),
    ).toThrow(/tagIds\[\] must not be blank/);
  });
});

describe("R9: the fold's upsert carries the count it READ", () => {
  it("never leaves a baseline whose count is below the folds that committed", async () => {
    // HELD BY THE WRONG TEST BEFORE THIS ROW. The audit measured that replacing
    // `expectedCount` with `null` is caught only by the forty-writer R10 row, and
    // there only as `observe gave up after 201 attempts` -- retry exhaustion,
    // never an assertion about the count. No single-writer row folds a SECOND
    // observation onto the same pair at all, so outside forty-way contention a
    // dropped expected count is invisible.
    //
    // THE INVARIANT HOLDS UNDER EVERY INTERLEAVING, so this row cannot flake: a
    // writer that threw rolled back and folded nothing, and a writer that
    // returned committed exactly one fold. Whatever the database chooses, and
    // however many writers exhaust their retries, the count equals the folds.
    // Without the expected count the concurrent writers all read the same
    // baseline and all write count 2, so the count falls below the folds.
    //
    // ONE RETRY AND NOT ZERO, because `BRIEF_POLICY_V0` refuses a `maxRetries` of
    // 0 by name -- `maxRetries must be a positive integer` -- which my first
    // version of this row did not know and which made all eight writers fail for
    // a reason that had nothing to do with R9. A tight bound is still what this
    // row wants: it is the contention, not the retry, that exercises the
    // predicate.
    await observe(composed, payment("op:occ0", "10.0000000", "OCCNS"), policies);
    const tightBound = { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 1 } };

    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        observe(composed, payment(`op:occ${i + 1}`, "10.0010000", "OCCNS"), tightBound),
      ),
    );
    const folded = settled.filter((s) => s.status === "fulfilled").length;
    expect(folded, "no writer got through at all").toBeGreaterThanOrEqual(1);

    const nsId = await namespaceIdOf("OCCNS");
    const baseline = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(baseline!.count, "a fold committed without moving the count").toBe(1 + folded);

    // R28's subject, on the FOLD's retry and not only the audit's: dropping it
    // from this `retrying` call survived the whole suite. A refusal that does not
    // name its observation cannot be acted on.
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (refused.length > 0) {
      expect(
        (refused[0]!.reason as Error).message,
        "the exhausted fold named no observation",
      ).toMatch(/on [0-9a-f-]{36}$/);
    }
  }, 60_000);
});

describe("a baseline is matched on the channel AND the aspect", () => {
  it("folds a second asset onto its OWN baseline, not onto the first one found", async () => {
    // A surviving mutant: `baselines.find((b) => b.channel === reading.channel)`.
    // Two aspects of one channel is not exotic -- it is two assets -- and the
    // first volume baseline found would then absorb the second asset's value and
    // hand tagging the wrong history to judge it against.
    for (const [i, amount] of ["10.0000000", "10.0010000", "10.0020000"].entries()) {
      await observe(
        composed,
        wire({
          source: { ...source, ref: `op:usdc${i}` },
          namespace: { kind: "wallet", id: "TWOASSET" },
          payload: { amount, assetCode: "USDC", direction: "in" },
        }),
        policies,
      );
    }
    await observe(
      composed,
      wire({
        source: { ...source, ref: "op:eurc0" },
        namespace: { kind: "wallet", id: "TWOASSET" },
        payload: { amount: "100.0000000", assetCode: "EURC", direction: "in" },
      }),
      policies,
    );

    const nsId = await namespaceIdOf("TWOASSET");
    const usdc = await baselineOf(nsId, "volume", "amount/USDC/in");
    const eurc = await baselineOf(nsId, "volume", "amount/EURC/in");

    expect(usdc!.count, "the USDC baseline absorbed the EURC fold").toBe(3);
    expect(eurc!.count, "the EURC fold landed on another aspect's baseline").toBe(1);
    expect(eurc!.mean).toBeCloseTo(100, 9);
    // And the two really are different histories, which is what makes the mix-up
    // detectable at all.
    expect(Math.abs(usdc!.mean - eurc!.mean)).toBeGreaterThan(1);
  }, 60_000);
});

describe("the surprise an ingest returns", () => {
  it("is the INTENT reading's own, by value, once the baseline is warm", async () => {
    // TWO MUTANTS SURVIVED HERE: taking the first measured verdict instead of the
    // intended one, and `surprise * 2`. The only assertion anywhere was
    // `toBeNull()` on a cold baseline, so every warm value was unheld.
    //
    // COMPARED AGAINST TAGGING'S OWN ARITHMETIC, deliberately. The engine's job
    // in this field is a pass-through: the number is tagging's, computed by
    // `judgeSurprise`, which has its own tests over its own arithmetic. What this
    // row holds is that the engine returns THAT number, for the reading a brief
    // would be handed, unscaled and unswapped -- which a fitted literal would
    // hold no better and would re-fit on every calibration change.
    const floor = scaleFloorFor(POLICY_V0, "volume", "amount/USDC/in");
    for (let i = 0; i < POLICY_V0.minObservations; i += 1) {
      await observe(
        composed,
        payment(`op:surp${i}`, (10 + i * 0.001).toFixed(7), "SURPRISE"),
        policies,
      );
    }
    const nsId = await namespaceIdOf("SURPRISE");
    const before = await baselineOf(nsId, "volume", "amount/USDC/in");
    expect(before!.count).toBe(POLICY_V0.minObservations);

    const out = await observe(composed, payment("op:surpN", "40.0000000", "SURPRISE"), policies);
    const verdict = judgeSurprise(40, before!, "volume", floor, POLICY_V0);
    if (verdict.kind !== "measured") throw new Error("the fixture did not reach a measured verdict");

    expect(out.surprise, "the warm surprise was not returned").not.toBeNull();
    expect(out.surprise!).toBeCloseTo(verdict.surprise, 9);
    // The control: the value is far from zero and far from twice itself, so the
    // assertion above can tell a doubled one from an honest one.
    expect(Math.abs(verdict.surprise)).toBeGreaterThan(1);
    expect(verdict.surprise).toBeGreaterThan(0);
  }, 120_000);

  it("is NULL when the observation derives two readings, because a scalar names neither (R79)", async () => {
    // R46 refuses to brief a two-reading intent. The surprise field now agrees
    // with it: "the last measured verdict" made the answer depend on the order
    // `readObservation` returns its readings, and for a `cluster_proximity`
    // carrying an amount that order decides between two unrelated quantities.
    const dust = (ref: string, hops: number, amount: string): WireObservation =>
      wire({
        source: { ...source, ref },
        namespace: { kind: "wallet", id: "TWOREAD" },
        channel: "cluster_proximity",
        payload: { clusterId: "c-1", hops, amount },
      });

    for (let i = 0; i < POLICY_V0.minObservations; i += 1) {
      await observe(composed, dust(`op:dust${i}`, 3, (1 + i * 0.001).toFixed(7)), policies);
    }
    const out = await observe(composed, dust("op:dustN", 9, "500.0000000"), policies);

    expect(out.intent.briefable, "the fixture derived one reading, not two").toBe(false);
    expect(out.surprise, "a scalar surprise was returned for a two-reading intent").toBeNull();

    // AND BOTH READINGS WERE STILL FOLDED. The null is about what a brief may be
    // handed; deleting the channel's signal to enforce a rule about briefs is the
    // mistake R46's own correction was written against.
    const nsId = await namespaceIdOf("TWOREAD");
    expect((await baselineOf(nsId, "cluster_proximity", "hops"))!.count).toBe(11);
    expect((await baselineOf(nsId, "cluster_proximity", "amount"))!.count).toBe(11);
  }, 120_000);
});

describe("a second observation on an aspect that already has a live tag", () => {
  it("REFRESHES that tag and returns its id, rather than opening a second one", async () => {
    // THE REFRESH BRANCH WAS HELD BY NOTHING. Three mutants survived: skipping
    // the refresh entirely, dropping `ownTagIds.push(live.tagId)`, and -- before
    // this row -- nothing read a tag row back after an ingest at all. `observe`
    // is the first path in the engine that opens tags, which made it the largest
    // untested surface on the branch.
    const protocolEvent = (ref: string, observedAt: string): WireObservation =>
      wire({
        source: { ...source, ref },
        namespace: { kind: "wallet", id: "REFRESHNS" },
        channel: "protocol",
        kind: "event_observed",
        observedAt,
        payload: { event: "trustline_open" },
      });

    const first = await observe(
      composed,
      protocolEvent("op:ref1", "2026-09-20T00:00:00.000Z"),
      policies,
    );
    expect(first.ownTagIds).toHaveLength(1);
    const nsId = await namespaceIdOf("REFRESHNS");
    const opened = (await composed.tags.listLive(nsId)).find((t) => t.tagId === first.ownTagIds[0]);
    expect(opened, "the opened tag is not in the store").toBeDefined();
    expect(opened!.refreshCount).toBe(0);
    expect(opened!.observationId, "the tag does not name its opening observation (R30)").toBe(
      first.observationId,
    );

    // A DAY LATER, so the live tag's strength has decayed and the refresh has
    // something to compute from. The clock is the composition's, which is what
    // makes this observable at all.
    clock.advance(24 * 60 * 60 * 1000);
    const secondObservedAt = "2026-09-21T12:00:00.000Z";
    const second = await observe(
      composed,
      protocolEvent("op:ref2", secondObservedAt),
      policies,
    );

    expect(second.ownTagIds, "the refresh returned no tag id").toEqual([opened!.tagId]);
    const live = await composed.tags.listLive(nsId);
    expect(live, "a second tag was opened instead of refreshing the live one").toHaveLength(1);
    expect(live[0]!.tagId).toBe(opened!.tagId);
    expect(live[0]!.refreshCount, "the refresh count did not move").toBe(1);
    // R30: a refreshed tag keeps its OPENING observation and does not re-point at
    // the one that refreshed it.
    expect(live[0]!.observationId).toBe(first.observationId);
    // R19: A TAG IS DATED AT ITS EVIDENCE AND NOT AT THE CLOCK. Measured here
    // rather than assumed -- my first version of this row asserted the clock's
    // instant and was red, because `taggedAt` follows the observation's
    // `observedAt`. That is the correct behaviour and it was worth pinning: it is
    // what makes a backfilled observation decay from when it happened.
    expect(live[0]!.taggedAt.toISOString()).toBe(secondObservedAt);
    expect(live[0]!.taggedAt.getTime()).toBeGreaterThan(opened!.taggedAt.getTime());
    clock.advance(-24 * 60 * 60 * 1000);
  }, 60_000);
});

describe("R21: a refusal carries the code of the refusal that happened", () => {
  it("names OBSERVATION_INVALID for a payload the store accepted and the validator refuses", async () => {
    // A surviving mutant hard-coded the code to `OBSERVATION_UNREADABLE`, and no
    // row could tell: `append` parses the ENVELOPE only, so the only refusal any
    // test drove past it was the 309-digit amount, which really is unreadable.
    //
    // THE GAP BETWEEN THE TWO VALIDATIONS IS REAL AND THIS IS IT: the envelope
    // types the payload as `z.record(z.string(), z.unknown())`, so ANY object
    // passes `append`, and `validateObservation` is the only thing that checks the
    // payload against its CHANNEL's schema. A `volume` observation carrying a
    // `protocol` payload is therefore stored and then refused, with an observation
    // id to name it by -- which is exactly the case R21 is about.
    //
    // MEASURED, after a wrong first attempt. I first used a mismatched
    // `idempotencyKey`, which `append` itself refuses (observation.ts:198) as a
    // `StoreError` -- rethrown unwrapped and carrying no code at all, so the row
    // was red against a path that never reaches `readingsOf`.
    const wrongPayload = wire({
      source: { ...source, ref: "op:wrongpayload" },
      namespace: { kind: "wallet", id: "WRONGPAYLOAD" },
      channel: "volume",
      payload: { event: "trustline_open" },
    });

    const failure = await observe(composed, wrongPayload, policies).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(failure, "a payload from another channel was accepted").not.toBeNull();
    expect(failure!.code, "the refusal reported the wrong code").toBe("OBSERVATION_INVALID");
    // The row exists, which is what makes the id available -- the difference
    // between this and the envelope refusal, whose id is null.
    expect(failure!.observationId).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);
});

describe("R28: the audit append's retry obeys the policy it was given", () => {
  it("retries up to the policy's bound, so a chain that recovers on the fourth try lands", async () => {
    // A surviving mutant replaced `maxRetries: policies.brief.maxRetries` with a
    // literal 1. The R24 row cannot tell, because it uses maxRetries 1 itself.
    //
    // THE STUB HAS AN ESCAPE HATCH, and that is not decoration: an unbounded-retry
    // mutant on this branch once HUNG instead of failing, vitest aborted the test
    // while the promise kept spinning, and three mutation runs were lost.
    let calls = 0;
    const flaky: Composed = {
      ...composed,
      audit: {
        ...composed.audit,
        append: async (entry: Parameters<Composed["audit"]["append"]>[0]) => {
          calls += 1;
          if (calls <= 3) throw new Deadlocked("deadlock detected");
          if (calls > 10) throw new Error("the retry is unbounded");
          return composed.audit.append(entry);
        },
      } as unknown as Composed["audit"],
    };

    const out = await observe(flaky, payment("op:retry4", "6.0000000", "RETRY4"), {
      ...policies,
      brief: { ...BRIEF_POLICY_V0, maxRetries: 3 },
    });
    expect(out.folded).toBe(true);
    expect(calls, "the append was not retried to the policy's bound").toBe(4);
    const head = await composed.audit.head();
    expect(head!.canonical).toContain(out.observationId);
  }, 60_000);
});

describe("a refresh is computed from the tag's DECAYED strength", () => {
  it("applies the increment to what the tag decayed to, not to what it was opened at", async () => {
    // A SURVIVING MUTANT: `decayedStrength: live.g0` -- the refresh decision handed
    // the tag's undecayed strength. A tag would then never weaken: every refresh
    // would raise it from its old peak, so a counterparty quiet for a year would
    // refresh exactly as strongly as one seen yesterday.
    //
    // ONLY THE SECOND REFRESH CAN SEE IT, which is why no cheaper row works and
    // why this one is as long as it is. `refreshTag` takes
    // `held = max(decayedStrength, freshG0)`, and the fresh weight is a function
    // of the CHANNEL, not of the observation -- so on a tag's first refresh the
    // fresh weight is at least the opening strength and dominates either way. Only
    // once a crossing has raised g0 ABOVE the fresh weight does the decayed value
    // decide.
    //
    // MEASURED, both ways round, with a 60-second half-life and two one-hour gaps:
    //
    //   open   g0 0.4837000000000000
    //   first  g0 0.5567333333333334   (identical under the mutant)
    //   second g0 0.5776727272727273   <- honest
    //   second g0 0.6067333333333335   <- the mutant: 0.5567333 + 0.05 exactly
    //
    // So the assertion is the RELATION and not a fitted number: the second refresh
    // must land BELOW the previous strength plus the increment, because the
    // increment is applied to a decayed value. The mutant lands exactly on it.
    const quickDecay = {
      ...policies,
      calibration: { ...CALIBRATION_V0, halfLifeMs: 60_000 },
    };
    const nsName = "DECAYNS";
    for (let i = 0; i < POLICY_V0.minObservations; i += 1) {
      await observe(composed, payment(`op:dk${i}`, (10 + i * 0.001).toFixed(7), nsName), quickDecay);
    }
    const nsId = await namespaceIdOf(nsName);
    const g0Now = async (): Promise<number> => {
      const live = await composed.tags.listLive(nsId);
      expect(live, "the aspect does not hold exactly one live tag").toHaveLength(1);
      return live[0]!.g0;
    };

    // Three escalating crossings: the first opens, the second raises g0 above the
    // fresh weight, the third is the one that can tell.
    await observe(composed, payment("op:dkA", "40.0000000", nsName), quickDecay);
    const opened = await g0Now();
    clock.advance(60 * 60 * 1000);
    await observe(composed, payment("op:dkB", "400.0000000", nsName), quickDecay);
    const afterFirst = await g0Now();
    clock.advance(60 * 60 * 1000);
    await observe(composed, payment("op:dkC", "4000.0000000", nsName), quickDecay);
    const afterSecond = await g0Now();
    clock.advance(-2 * 60 * 60 * 1000);

    // The fixture really did raise g0 above the fresh weight, which is the
    // precondition for the assertion below being able to tell anything at all.
    expect(afterFirst, "the first refresh did not raise g0").toBeGreaterThan(opened);
    expect((await composed.tags.listLive(nsId))[0]!.refreshCount).toBe(2);

    // THE WITNESS. An hour at a 60-second half-life is sixty halvings, so the
    // decayed strength is effectively zero and `held` falls back to the fresh
    // weight; the undecayed path would hold the full previous strength instead.
    expect(
      afterSecond,
      "the refresh was computed from the tag's undecayed strength",
    ).toBeLessThan(afterFirst + POLICY_V0.refreshIncrement);
    // And it is strictly below the previous strength plus the increment by a
    // margin no rounding accounts for.
    expect(afterFirst + POLICY_V0.refreshIncrement - afterSecond).toBeGreaterThan(0.01);
  }, 120_000);
});

describe("R28: an exhausted FOLD retry names the observation it gave up on", () => {
  it("carries the observation id, not only the label and the attempt count", async () => {
    // A SURVIVING MUTANT dropped `subject: observationId` from the fold's
    // `retrying` call. R28 says an exhausted retry records its code AND the
    // observation id; a refusal that names no observation cannot be acted on.
    //
    // DETERMINISTIC, and that is the point. My first attempt read the subject off
    // whichever of eight contending writers happened to be refused, and with the
    // policy's tightest bound none of them was -- so the assertion never ran and
    // the mutant survived a row written for it. A handle whose transaction always
    // refuses exhausts every time.
    const alwaysDeadlocked: Composed = {
      ...composed,
      handle: {
        ...composed.handle,
        transaction: () => ({
          execute: async () => {
            throw new Deadlocked("deadlock detected");
          },
        }),
      } as unknown as Composed["handle"],
    };

    const failure = await observe(
      alwaysDeadlocked,
      payment("op:nofold", "9.0000000", "NOFOLD"),
      { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 2 } },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(failure, "a fold that never committed returned normally").not.toBeNull();
    expect(failure!.message).toMatch(/^observe gave up after 3 attempts on [0-9a-f-]{36}$/);

    // AND THE FOLD REALLY FOLDED NOTHING -- the plan's clause, which nothing held
    // either: an exhausted retry leaves the baseline absent, not half-written.
    const nsId = await namespaceIdOf("NOFOLD");
    expect(await baselineOf(nsId, "volume", "amount/USDC/in")).toBeNull();
    expect(await composed.tags.listLive(nsId)).toEqual([]);
  }, 60_000);
});

describe("the ingest path's body assertion runs on what the STORE handed back", () => {
  it("refuses a blank observation id from `append` BEFORE the chain sees it", async () => {
    // B22 OF TASK 5, AGAIN AND IN THE SAME SHAPE. Deleting `assertObserveBody`
    // from the ingest path SURVIVED the whole suite, because every field in the
    // body came from input the path had already refused. The uncovered direction
    // is what the store hands back: the tag ids are `open`'s own return values,
    // the namespace id came from a namespace row, and the observation id came from
    // `append` -- none of the three was validated on the way in.
    //
    // The chain is checked afterwards, because "refused" is only the right word if
    // nothing was written.
    const before = await composed.audit.head();
    const blanked: Composed = {
      ...composed,
      observations: {
        ...composed.observations,
        append: async (w: WireObservation) => {
          const real = await composed.observations.append(w);
          // NARROWED, NOT CAST. `AppendResult`'s third arm carries no
          // `observation` at all, and `pnpm typecheck` caught this while
          // `pnpm test` was green -- the FIFTH divergence on this branch.
          if (!("observation" in real)) return real;
          return { ...real, observation: { ...real.observation, observationId: "   " } };
        },
      } as unknown as Composed["observations"],
    };

    const failure = await observe(
      blanked,
      payment("op:blankid", "8.0000000", "BLANKID"),
      policies,
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(failure, "a blank observation id reached the chain").not.toBeNull();
    expect(failure!.message).toMatch(/auditBody\.observationId must not be blank/);

    const after = await composed.audit.head();
    expect(after?.seq, "an entry was appended before the body was checked").toBe(before?.seq);
  }, 30_000);
});

describe("R21: a per-observation refusal is RECORDED, and skipped", () => {
  it("writes an observe_refused entry naming the code and the id, with no message text", async () => {
    // THE HALF OF R21 THE CODE DID NOT DO. The ruling reads "a per-observation
    // refusal is RECORDED as a code and an observation id, never as the message",
    // and the plan's acceptance says such an observation "is recorded and skipped
    // rather than halting ingest". `observe` threw a `RefusedObservation` carrying
    // both -- which is how a CALLER learns of it -- and wrote nothing durable.
    const huge309 = "9".repeat(309);
    const before = await composed.audit.head();

    const failure = await observe(
      composed,
      payment("op:recorded", huge309, "RECORDED"),
      policies,
    ).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(failure!.code).toBe("OBSERVATION_UNREADABLE");

    const head = await composed.audit.head();
    expect(head!.seq, "the refusal was not recorded at all").not.toBe(before?.seq);
    expect(head!.kind).toBe("observe_refused");

    const body = head!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["at", "code", "observationId"]);
    expect(body["code"]).toBe("OBSERVATION_UNREADABLE");
    expect(body["observationId"]).toBe(failure!.observationId);
    expect(body["at"]).toBe(AT.toISOString());

    // "The refusal's message text appears nowhere in the audit body" -- the
    // acceptance's own words, now checked against what the chain really hashed
    // rather than against the error object.
    expect(head!.canonical, "the observed value reached the chain").not.toContain(huge309);
    expect(head!.canonical).not.toContain("999999");
    expect(head!.canonical).not.toContain("does not fit a double");
  }, 30_000);

  it("records OBSERVATION_INVALID for a payload the validator refuses, by its own code", async () => {
    // Two codes, two rows. A single row could not tell a recorded code from a
    // constant, which is the mutant that survived on the thrown code as well.
    const failure = await observe(
      composed,
      wire({
        source: { ...source, ref: "op:recinvalid" },
        namespace: { kind: "wallet", id: "RECINVALID" },
        channel: "volume",
        payload: { event: "trustline_open" },
      }),
      policies,
    ).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(failure!.code).toBe("OBSERVATION_INVALID");

    const head = await composed.audit.head();
    expect(head!.kind).toBe("observe_refused");
    expect((head!.body as Record<string, unknown>)["code"]).toBe("OBSERVATION_INVALID");
  }, 30_000);

  it("R83: an envelope refusal writes NO chain entry, because it has no row to name", async () => {
    // Recording this one would turn malformed wire input into permanent,
    // unerasable rows at whatever rate a producer chooses to send it -- an
    // amplification vector into the one table retention cannot reach. The
    // structured stderr line is the record, which is the same answer R7 gives for
    // every condition the chain cannot hold.
    const address = `G${"C".repeat(55)}`;
    const bad = { ...(payment("op:env", "1.0000000", "ENVREFUSE") as object), [address]: 1 };

    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    const before = await composed.audit.head();
    let failure: RefusedObservation | null = null;
    try {
      failure = await observe(composed, bad as unknown as WireObservation, policies).then(
        () => null,
        (e: unknown) => e as RefusedObservation,
      );
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }

    expect(failure!.observationId).toBeNull();
    const after = await composed.audit.head();
    expect(after?.seq, "an envelope refusal was written to the chain").toBe(before?.seq);

    const reported = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);
    const line = reported.find((l) => l["event"] === "engine.observe.envelope_refused");
    expect(line, "the envelope refusal was recorded nowhere at all").toBeDefined();
    expect(line!["code"]).toBe("OBSERVATION_INVALID");
    expect(line!["observationId"]).toBeNull();
    // And it carries no wire content, which is the reason the line exists in this
    // shape rather than as the message.
    expect(JSON.stringify(line)).not.toContain(address);
  }, 30_000);

  it("does not let a failed RECORDING replace the reason it refused", async () => {
    // An ingest that reported a lost audit row in place of the reason it refused
    // the observation would have replaced the fact with a fact about recording the
    // fact. The caller still gets the refusal; the lost row goes to stderr.
    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    const brokenChain: Composed = {
      ...composed,
      audit: {
        ...composed.audit,
        append: async () => {
          throw new Deadlocked("deadlock detected");
        },
      } as unknown as Composed["audit"],
    };
    let failure: RefusedObservation | null = null;
    try {
      failure = await observe(
        brokenChain,
        payment("op:recfail", "9".repeat(309), "RECFAIL"),
        { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 1 } },
      ).then(
        () => null,
        (e: unknown) => e as RefusedObservation,
      );
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }

    expect(failure, "the refusal was swallowed by its own recording").not.toBeNull();
    expect(failure!.code, "an audit failure replaced the refusal's code").toBe(
      "OBSERVATION_UNREADABLE",
    );
    const reported = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);
    const line = reported.find((l) => l["event"] === "engine.observe.refusal_unrecorded");
    expect(line, "an unrecorded refusal was reported nowhere").toBeDefined();
    expect(line!["code"]).toBe("REFUSAL_ENTRY_MISSING");
    expect(Object.keys(line!)).not.toContain("message");
  }, 60_000);
});

describe("R28: the refusal recording's retry obeys the policy too", () => {
  it("lands the refusal entry when the chain recovers on the fourth attempt", async () => {
    // A SURVIVING MUTANT bound this retry at a literal 1, and the rows above
    // could not tell: they either use the real chain or a chain that never
    // recovers. The escape hatch is the lesson an unbounded-retry mutant taught
    // this branch by HANGING instead of failing.
    let calls = 0;
    const flaky: Composed = {
      ...composed,
      audit: {
        ...composed.audit,
        append: async (entry: Parameters<Composed["audit"]["append"]>[0]) => {
          calls += 1;
          if (calls <= 3) throw new Deadlocked("deadlock detected");
          if (calls > 10) throw new Error("the retry is unbounded");
          return composed.audit.append(entry);
        },
      } as unknown as Composed["audit"],
    };

    const failure = await observe(
      flaky,
      payment("op:refretry", "9".repeat(309), "REFRETRY"),
      { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 3 } },
    ).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(failure!.code).toBe("OBSERVATION_UNREADABLE");
    expect(calls, "the refusal's append was not retried to the policy's bound").toBe(4);

    const head = await composed.audit.head();
    expect(head!.kind).toBe("observe_refused");
    expect((head!.body as Record<string, unknown>)["observationId"]).toBe(failure!.observationId);
  }, 60_000);
});

describe("R28: a retry bound is a bound in BOTH directions", () => {
  it("gives up at the policy's bound rather than retrying past it", async () => {
    // A SURVIVING MUTANT: `maxRetries: 50` hard-coded in the refusal recorder.
    // The row above asserts the append is retried to FOUR attempts under a policy
    // of three -- which a bound of fifty satisfies just as well, because the stub
    // recovers on the fourth call. The row could tell "too few" and not "too
    // many", and "too many" is the direction R28 exists for: an unbounded retry
    // is the denial of service on ourselves that the ruling names.
    //
    // A chain that NEVER recovers is what separates them: at a bound of one the
    // append must be attempted exactly twice and then abandoned.
    let calls = 0;
    const neverRecovers: Composed = {
      ...composed,
      audit: {
        ...composed.audit,
        append: async () => {
          calls += 1;
          if (calls > 10) throw new Error("the retry is unbounded");
          throw new Deadlocked("deadlock detected");
        },
      } as unknown as Composed["audit"],
    };

    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    let failure: RefusedObservation | null = null;
    try {
      failure = await observe(
        neverRecovers,
        payment("op:upperbound", "9".repeat(309), "UPPERBOUND"),
        { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 1 } },
      ).then(
        () => null,
        (e: unknown) => e as RefusedObservation,
      );
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }

    // The refusal still reaches the caller, and the recording gave up where the
    // policy said to: one retry means two attempts, not fifty.
    expect(failure!.code).toBe("OBSERVATION_UNREADABLE");
    expect(calls, "the refusal's append ignored the policy's bound upward").toBe(2);
    expect(
      lines.some((l) => l.includes("engine.observe.refusal_unrecorded")),
      "an abandoned refusal recording was reported nowhere",
    ).toBe(true);
  }, 60_000);
});

describe("R28: an exhausted FOLD is RECORDED, not only thrown", () => {
  it("writes a structured line naming the observation whose fold was abandoned", async () => {
    // R28 reads "an exhausted retry RECORDS its code and the observation id". A
    // review measured that this path recorded nothing at all: the audit-append
    // exhaustion and the refusal-recording exhaustion each write a structured
    // line, and the FOLD's exhaustion -- the one the ruling is literally about,
    // "and the observation is not folded" -- wrote none, so the fact lived only
    // in a thrown object.
    const alwaysDeadlocked: Composed = {
      ...composed,
      handle: {
        ...composed.handle,
        transaction: () => ({
          execute: async () => {
            throw new Deadlocked("deadlock detected");
          },
        }),
      } as unknown as Composed["handle"],
    };

    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
      lines.push(String(chunk));
      return true;
    };
    let failure: Error | null = null;
    try {
      failure = await observe(
        alwaysDeadlocked,
        payment("op:foldrec", "4.0000000", "FOLDREC"),
        { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 1 } },
      ).then(
        () => null,
        (e: unknown) => e as Error,
      );
    } finally {
      (process.stderr as { write: unknown }).write = realWrite;
    }
    expect(failure, "a fold that never committed returned normally").not.toBeNull();

    const reported = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);
    const line = reported.find((l) => l["event"] === "engine.observe.fold_abandoned");
    expect(line, "an abandoned fold was recorded nowhere").toBeDefined();
    expect(line!["code"]).toBe("FOLD_ABANDONED");
    expect(line!["observationId"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(line!["at"]).toBe(AT.toISOString());
    // R21 even here: a code and ids, never the message.
    expect(Object.keys(line!)).not.toContain("message");

    // AND THE CHAIN WAS NOT USED FOR IT, deliberately: the commonest cause of an
    // abandoned fold is the store being unavailable, which is the condition R7
    // answers with a line rather than a row -- and a row here would be one per
    // DELIVERY, which is the amplification R83 had to be corrected for once.
    const nsId = await namespaceIdOf("FOLDREC");
    expect(await baselineOf(nsId, "volume", "amount/USDC/in")).toBeNull();
  }, 60_000);
});

describe("R10: a concurrent REFRESH of one tag rolls back and the retry lands exactly one", () => {
  it("leaves one live tag whose refresh count is the number of observations that folded", async () => {
    // THE PLAN'S CLAUSE, AND NOTHING HELD IT. The R10 forty-writer row holds the
    // BASELINE side of "one transaction per fold"; the tag side has its own stale
    // predicate -- `TagRefreshStale` -- and no row made two writers refresh one
    // tag at the same time. A refresh that did not roll back with its fold would
    // leave the count and the tag disagreeing.
    const protocolEvent = (ref: string, observedAt: string): WireObservation =>
      wire({
        source: { ...source, ref },
        namespace: { kind: "wallet", id: "CONCREFRESH" },
        channel: "protocol",
        kind: "event_observed",
        observedAt,
        payload: { event: "trustline_open" },
      });

    const first = await observe(
      composed,
      protocolEvent("op:cr0", "2026-09-20T00:00:00.000Z"),
      policies,
    );
    expect(first.ownTagIds).toHaveLength(1);
    const nsId = await namespaceIdOf("CONCREFRESH");

    const contended = { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 50 } };
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        observe(composed, protocolEvent(`op:cr${i + 1}`, "2026-09-20T01:00:00.000Z"), contended),
      ),
    );
    expect(results.filter((r) => r.folded).length).toBe(6);

    const live = await composed.tags.listLive(nsId);
    expect(live, "a concurrent refresh opened a second tag for the pair").toHaveLength(1);
    expect(live[0]!.tagId).toBe(first.ownTagIds[0]);
    // SIX REFRESHES AND NOT FEWER, which is the half a count of live tags cannot
    // see: a refresh lost to a rollback that never retried would leave this below
    // six while everything else looked right.
    expect(live[0]!.refreshCount, "a refresh was lost or applied twice").toBe(6);
    // And every writer named the tag it refreshed, so none of them folded silently.
    for (const r of results) expect(r.ownTagIds).toEqual([live[0]!.tagId]);
  }, 120_000);
});

describe("R83 CORRECTED: a re-delivered refusal is recorded ONCE, not once per delivery", () => {
  it("writes exactly one chain entry however many times the same refusal is re-sent", async () => {
    // THE AMPLIFICATION R83 CLAIMED TO AVOID, OPEN AT THE SITE R83 CHOSE TO
    // RECORD. Two independent reviews measured it and the store says it in so
    // many words (`observation.ts`, the producer-cap transaction): "the pre-read
    // is deliberately OUTSIDE this transaction: a re-delivery has already
    // returned by now, so the indexer's retry never consumes a slot."
    //
    // So "bounded by the producer cap" was false. `append` answers
    // `{created:false}` for a repeat without charging the cap, `readingsOf` runs
    // before the re-delivery branch, the payload fails again, and the refusal was
    // recorded again -- ONE accepted observation buying N permanent rows in the
    // one table retention cannot reach, at whatever rate a producer re-sends.
    //
    // Worse than a missing bound: the HONEST path writes no entry on a
    // re-delivery at all, so chain growth used to be cap-bounded and this
    // introduced the only unbounded path into it.
    //
    // The fix is the first delivery, which is the one the cap charged for. This
    // row is the regression test against the behaviour it replaced: measured at
    // five deliveries it wrote FIVE entries before the fix.
    const huge = "9".repeat(309);
    const observation = payment("op:reamplify", huge, "REAMPLIFY");

    const first = await observe(composed, observation, policies).then(
      () => null,
      (e: unknown) => e as RefusedObservation,
    );
    expect(first!.code).toBe("OBSERVATION_UNREADABLE");
    const afterFirst = await composed.audit.head();
    expect(afterFirst!.kind, "the first delivery recorded nothing").toBe("observe_refused");

    // Four more deliveries of the SAME wire observation, unchanged.
    for (let i = 0; i < 4; i += 1) {
      const again = await observe(composed, observation, policies).then(
        () => null,
        (e: unknown) => e as RefusedObservation,
      );
      // Still refused, and still by its code and its id: the caller is not left
      // to infer that a re-delivery of an unreadable observation was fine.
      expect(again, `delivery ${i + 2} was accepted`).not.toBeNull();
      expect(again!.code).toBe("OBSERVATION_UNREADABLE");
      expect(again!.observationId, "a re-delivery was given a new id").toBe(first!.observationId);
    }

    const afterFive = await composed.audit.head();
    expect(
      Number(afterFive!.seq) - Number(afterFirst!.seq),
      "a re-delivery wrote another permanent row into the chain",
    ).toBe(0);
  }, 60_000);

  it("and an erased namespace's re-delivery records nothing either", async () => {
    // The third `append` arm. A reviewer measured three more rows here: the
    // refusal is re-derived from the WIRE, which is still in hand after the
    // namespace key is gone, so an erased counterparty's observation id was
    // being written into a row that outlives the key by design.
    const observation = payment("op:eraseamp", "9".repeat(309), "ERASEAMP");
    await observe(composed, observation, policies).catch(() => undefined);
    const nsId = await namespaceIdOf("ERASEAMP");
    await composed.namespaces.shred(nsId);
    const before = await composed.audit.head();

    for (let i = 0; i < 3; i += 1) {
      await observe(composed, observation, policies).catch(() => undefined);
    }
    const after = await composed.audit.head();
    expect(
      Number(after!.seq) - Number(before!.seq),
      "an erased namespace's re-delivery was recorded",
    ).toBe(0);
  }, 60_000);
});

describe("R10: a stale tag refresh rolls the FOLD back with it", () => {
  it("leaves the baseline count and the refresh count agreeing, under contention", async () => {
    // THE CLAUSE'S FIRST HALF, WHICH HAD NO WITNESS. A review found that the
    // concurrent-refresh row above uses `protocol`, and tagging's own docstrings
    // say a CATEGORICAL reading has no baseline -- `result.baseline` is null, so
    // `inner.baselines.upsert` is never reached and there is no fold in that
    // transaction to roll back. The row held "the retry lands exactly one
    // refresh" and nothing about the fold.
    //
    // A continuous channel with a warm baseline is the witness the plan means:
    // every writer both folds AND refreshes, in one transaction, so the two
    // counts must agree. A tag refresh that rolled back while its fold committed
    // would leave the baseline ahead of the refresh count -- which is R10's
    // "committed fold with no tag" seen from the other end.
    const nsName = "FOLDROLL";
    const warm = POLICY_V0.minObservations;
    for (let i = 0; i < warm; i += 1) {
      await observe(composed, payment(`op:fr${i}`, (10 + i * 0.001).toFixed(7), nsName), policies);
    }
    // One big crossing to OPEN the tag, so every concurrent writer refreshes
    // rather than racing to open.
    const opened = await observe(composed, payment("op:frOpen", "4000.0000000", nsName), policies);
    expect(opened.ownTagIds, "the opening crossing opened no tag").toHaveLength(1);

    const nsId = await namespaceIdOf(nsName);
    const writers = 4;
    const contended = { ...policies, brief: { ...BRIEF_POLICY_V0, maxRetries: 60 } };
    const results = await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        observe(composed, payment(`op:frC${i}`, "9000.0000000", nsName), contended),
      ),
    );
    expect(results.filter((r) => r.folded).length).toBe(writers);

    const baseline = await baselineOf(nsId, "volume", "amount/USDC/in");
    const live = await composed.tags.listLive(nsId);

    // EVERY FOLD LANDED EXACTLY ONCE.
    expect(baseline!.count, "a fold was lost or doubled under contention").toBe(
      warm + 1 + writers,
    );
    // AND EVERY REFRESH LANDED EXACTLY ONCE, on the one tag.
    expect(live, "a concurrent refresh opened a second tag for the pair").toHaveLength(1);
    expect(live[0]!.tagId).toBe(opened.ownTagIds[0]);
    expect(
      live[0]!.refreshCount,
      "the fold and the tag write disagree, so one rolled back without the other",
    ).toBe(writers);
    // Each writer named the tag it refreshed, so none folded silently.
    for (const r of results) expect(r.ownTagIds).toEqual([live[0]!.tagId]);
  }, 180_000);
});
