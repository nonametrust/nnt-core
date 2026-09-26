// The four acceptance criteria of M1, from the plan's milestone table:
//
//   1. An observation round-trips.
//   2. A tag's strength is derivable at an arbitrary instant.
//   3. A promotion preserves the original timestamp.
//   4. The audit chain verifies.
//
// The per-module suites test each mechanism in isolation. This file runs them
// together on one database, in the order the engine will, so that a criterion
// cannot be met by a component that no longer composes with its neighbours.
// One fixedClock starts at day zero and is advanced, so twenty-one simulated
// days run in milliseconds.
//
// The sequence is the whitepaper's scenario, and the test is written to read
// as it. A data provider that an agent uses often has a standing condition
// and a payment history (day zero). On day twelve its advertised payment
// address changes once and reverts the same afternoon. The change is
// sub-threshold: it alerts nobody, is tagged into limbo, and, in M2, lowers
// the provider's brief threshold. On day twenty-one the provider quotes a
// large price, the decision layer asks what is known, and the address change
// must surface still dated day twelve. On day twenty-two the nightly job
// audits the whole of it.
//
// Every operation the story performs appends an audit entry, and the fourth
// criterion verifies the chain over all of them, so a break anywhere in the
// sequence is caught there as well as where it happened.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateObservation, type Observation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "./db.js";
import { withSchema, storedObservation } from "./testing/harness.js";
import { keyRingFromEnv } from "./crypto.js";
import { fixedClock } from "./clock.js";
import { RETENTION_V0 } from "./retention.js";
import {
  AppendOnlyViolation, DayNotClosed, TimestampAltered, mapPgError, PayloadExpired,
} from "./errors.js";
import { NamespaceRepository, sweepOrder } from "./repositories/namespace.js";
import { ObservationRepository } from "./repositories/observation.js";
import { TagRepository, type StoredTag } from "./repositories/tag.js";
import { TriggerEventRepository, type StoredTriggerEvent } from "./repositories/trigger-event.js";
import {
  PermanentRecordRepository, type StoredPermanentRecord,
} from "./repositories/permanent-record.js";
import { AuditChain, type StoredAuditEntry, type VerifyResult } from "./audit/chain.js";
import { strengthAt } from "./strength.js";

const DAY = 24 * 60 * 60 * 1000;

// Day zero of the scenario. The schema package's day-twelve fixtures date the
// address change 2026-09-12, so day zero is twelve days before that, and
// every other instant here is a day count from it.
const DAY_ZERO = new Date("2026-08-31T00:00:00.000Z");
function day(n: number, time = "00:00"): Date {
  return new Date(`${new Date(DAY_ZERO.getTime() + n * DAY).toISOString().slice(0, 10)}T${time}:00.000Z`);
}
function dayString(n: number): string {
  return day(n).toISOString().slice(0, 10);
}

// The one clock. It only ever moves forward, as the engine's does; a step
// that asked for an earlier instant would be a mistake in the story, not a
// scenario, and is refused rather than rewound.
const clock = fixedClock(DAY_ZERO);
function advanceTo(instant: Date): void {
  const ms = instant.getTime() - clock.now().getTime();
  if (ms < 0) throw new Error(`the story cannot go back to ${instant.toISOString()}`);
  clock.advance(ms);
}

const POLICY = "v0";
// The calibration input M2 owns. A week, as tag.test.ts and strength.test.ts
// assume, so that the day-twelve tag has halved once by day nineteen.
//
// NOT the product's number: `CALIBRATION_V0.halfLifeMs` in the tagging package
// is fourteen days. The store may not import tagging, so this file chooses its
// own and the choice is legitimate -- but anyone reading this story as THE
// scenario is reading a seven-day half-life that the engine does not use, and
// "halved once by day nineteen" is a property of this test and not of the
// product. M3's acceptance scenario has to pick one of the two and say which.
const HALF_LIFE = 7 * DAY;

// The provider is an endpoint, as in the fixtures. Its payment wallet is a
// second namespace: an address is an attribute of a counterparty and not the
// counterparty itself, and the two are linked by an assertion, never inferred.
const PROVIDER = { kind: "endpoint", id: "https://data.example/x402" } as const;
const WALLET = { kind: "wallet", id: "GOLDADDRESS" } as const;

// One ring for the whole run. It wraps the namespace data keys and derives
// the day-seal key, and no isolated suite uses one ring for both.
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);

// Every observation enters the way a producer's would: through
// validateObservation, which runs the channel's payload validator. The
// repository parses the envelope only, so the payloads are proved here.
function validated(input: unknown): Observation {
  const result = validateObservation(input);
  if (!result.ok) throw new Error(`fixture does not validate:\n${result.errors.join("\n")}`);
  return result.value;
}

const DAY_TWELVE = fileURLToPath(new URL("../../schema/fixtures/day-twelve/", import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DAY_TWELVE, name), "utf8"));
}

const gateway = { producer: "x402-gateway", producerVersion: "0.1.0" };
const indexer = { producer: "stellar-indexer", producerVersion: "0.1.0", network: "testnet" };

// Day zero: the provider accepts USDC. A standing condition, with an interval
// and no instant, so it can never be credited to a window.
const acceptsUsdc = validated({
  schemaVersion: "0.1.0",
  namespace: PROVIDER,
  channel: "protocol", evidenceKind: "state", kind: "accepts_asset",
  validFrom: day(0).toISOString(), validUntil: null,
  source: { ...gateway, ref: "probe:day-zero", fetchedAt: day(0, "09:00").toISOString() },
  payload: { event: "accepts_asset", assetCode: "USDC", issuerKnown: true },
});

// Day zero: a payment lands on the provider's wallet through a muxed address,
// and ops assert that the wallet is the endpoint's payment address.
const routinePayment = validated({
  schemaVersion: "0.1.0",
  namespace: {
    ...WALLET,
    muxedId: "1",
    continuity: {
      assertedBy: "ops",
      assertedAt: day(0, "09:00").toISOString(),
      reason: "the payment address https://data.example/x402 advertises",
    },
  },
  channel: "volume", evidenceKind: "event", kind: "payment",
  observedAt: day(0, "09:30").toISOString(),
  source: { ...indexer, ref: "op:day-zero:1", fetchedAt: day(0, "09:31").toISOString() },
  payload: { amount: "25.0000000", assetCode: "USDC", direction: "in" },
  salienceHints: { amount: "25.0000000" },
});

// Day twelve, from the schema package's own fixtures: the advertised address
// moves away in the morning and back in the afternoon, each seen by the
// gateway under its own request reference.
const movedAway = validated(fixture("address-moved-away.json"));
const movedBack = validated(fixture("address-moved-back.json"));

// Day twenty-one: the provider quotes a large price, and the agent's decision
// layer asks what is known before it authorises.
const largeQuote = validated({
  schemaVersion: "0.1.0",
  namespace: PROVIDER,
  channel: "price", evidenceKind: "event", kind: "price_quoted",
  observedAt: day(21, "10:00").toISOString(),
  source: { ...gateway, ref: "req:01J9ZZ1LARGE", fetchedAt: day(21, "10:00").toISOString() },
  payload: { quoted: "2500.0000000", unit: "USDC" },
  salienceHints: { amount: "2500.0000000" },
});

let db: Db;
let done: () => Promise<void>;
let namespaces: NamespaceRepository;
let observations: ObservationRepository;
let tags: TagRepository;
let triggers: TriggerEventRepository;
let records: PermanentRecordRepository;
let chain: AuditChain;
let provider: string;

// What each step stored, for the steps after it.
const stored: Partial<Record<"acceptsUsdc" | "routinePayment" | "movedAway" | "movedBack" | "largeQuote", Observation>> = {};
let limboTag: StoredTag;
let quoteTrigger: StoredTriggerEvent;
const promoted: StoredPermanentRecord[] = [];

// Every operation the story performs is written here as well, in order, so
// the fourth criterion can check that the chain holds one entry per
// operation and nothing else.
const journal: { kind: string; seq: string }[] = [];
async function audit(kind: string, body: unknown): Promise<StoredAuditEntry> {
  const entry = await chain.append({ policyVersion: POLICY, kind, body });
  journal.push({ kind, seq: entry.seq });
  return entry;
}

function idOf(o: Observation): string {
  if (!o.observationId) throw new Error("a stored observation has no observationId");
  return o.observationId;
}

// Ingests at the clock's instant and audits it. Reports what the repository
// returned; whether that matches what is read back is each criterion's own
// assertion.
async function ingest(wire: Observation, at: Date): Promise<Observation> {
  advanceTo(at);
  const _r = await observations.append(wire);
    const created = _r.created;
    const observation = storedObservation(_r);
  expect(created).toBe(true);
  await audit("observation.appended", {
    observationId: idOf(observation), idempotencyKey: observation.idempotencyKey,
    channel: observation.channel, evidenceKind: observation.evidenceKind,
  });
  return observation;
}

// Criterion 1's form: every wire field of what is read back equal to the
// wire input, and the two fields ingest assigns present and well-formed. The
// comparison is against the input and not against what `append` returned,
// so a field altered on the way in cannot pass by being read back altered.
// `get` has re-parsed the decrypted blob through the schema already; that
// parse is the proof.
async function roundTrips(wire: Observation, stored: Observation, ingestedAt: Date): Promise<Observation> {
  const read = await observations.get(idOf(stored));
  for (const key of Object.keys(wire) as (keyof Observation)[]) {
    expect(read[key], key).toEqual(wire[key]);
    expect(stored[key], key).toEqual(wire[key]);
  }
  expect(read.observationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(read.observationId).toBe(stored.observationId);
  expect(read.ingestedAt).toBe(ingestedAt.toISOString());
  return read;
}

// The xmin of every tag row, as tag.test.ts reads it: Postgres rewrites it on
// any UPDATE, including one that sets a column to the value it already had.
async function tagRowVersions(): Promise<string[]> {
  const r = await sql<{ v: string }>`select tag_id::text || ':' || xmin::text as v from tag order by tag_id`
    .execute(db);
  return r.rows.map((x) => x.v);
}

// The retention policy this story runs under. One object, handed to every
// repository that takes one: R16 refuses a stored expiry its own policy did
// not compute, so a fixture appended through one policy and swept by another
// is a PeriodKeyAltered on the next append rather than a sweep that finds
// nothing -- and §2d names this suite by name as a place that would happen.
//
// Three days rather than ninety, so the story can reach its own expiry: the
// scenario is twenty-two days long and a ninety-day grace would need a
// hundred and fourteen. Three collides with no other field of the policy,
// which is the habit the M2 ledger asks for -- the shipped numbers are 90,
// 86,400,000 and 10,000,000, and a function reading the wrong one would show.
//
// What this does NOT prove, and the card says so: the full horizon over a
// real ninety days across a calendar month belongs to M5. This proves the
// mechanism on M1's scenario.
const RETENTION = Object.freeze({ ...RETENTION_V0, graceDays: 3 });

beforeAll(async () => {
  ({ db, done } = await withSchema("acceptance"));
  namespaces = new NamespaceRepository(db, ring, clock, RETENTION);
  observations = new ObservationRepository(db, namespaces, clock, RETENTION);
  tags = new TagRepository(db, clock);
  triggers = new TriggerEventRepository(db, clock);
  records = new PermanentRecordRepository(db, ring, clock, RETENTION);
  chain = new AuditChain(db, clock, ring);
  provider = (await namespaces.ensure(PROVIDER)).namespaceId;
});
afterAll(async () => { await done(); });

describe("1. an observation round-trips", () => {
  it("day zero: the provider's standing condition is stored undated, so it can never be credited to a window", async () => {
    const at = day(0, "09:00");
    stored.acceptsUsdc = await ingest(acceptsUsdc, at);
    const read = await roundTrips(acceptsUsdc, stored.acceptsUsdc, at);
    expect(read.evidenceKind).toBe("state");
    const row = await db.selectFrom("observation").select(["dated_at"])
      .where("observation_id", "=", idOf(read)).executeTakeFirstOrThrow();
    expect(row.dated_at).toBeNull();
  });

  it("day zero: a routine payment on the provider's wallet carries its muxed identifier, the continuity assertion and the salience hints back out", async () => {
    const at = day(0, "09:31");
    stored.routinePayment = await ingest(routinePayment, at);
    const read = await roundTrips(routinePayment, stored.routinePayment, at);
    expect(read.namespace.muxedId).toBe("1");
    expect(read.namespace.continuity?.assertedBy).toBe("ops");
    expect(read.salienceHints?.amount).toBe("25.0000000");
    // The wallet is its own namespace, and the endpoint's row is untouched
    // by a payment on it.
    const wallet = await namespaces.find(WALLET.kind, WALLET.id);
    expect(wallet?.namespaceId).not.toBe(provider);
  });

  it("day twelve: the payment address moves away in the morning and back in the afternoon, and each comes back as it was sent", async () => {
    // Ingested a minute after each was observed, as from a gateway, so the
    // instant an observation carries and the instant it was stored differ.
    // A repository that confused the two would fail criterion 3 here rather
    // than pass it by coincidence.
    stored.movedAway = await ingest(movedAway, day(12, "08:15"));
    stored.movedBack = await ingest(movedBack, day(12, "16:48"));
    const away = await roundTrips(movedAway, stored.movedAway, day(12, "08:15"));
    const back = await roundTrips(movedBack, stored.movedBack, day(12, "16:48"));
    expect(away.namespace).toEqual(PROVIDER);
    expect(back.payload).toEqual({ previous: "GNEWADDRESS", current: "GOLDADDRESS" });
    // Both were filed under the endpoint's namespace, the one the tag and the
    // permanent record will be keyed on.
    const rows = await db.selectFrom("observation").select(["namespace_id"])
      .where("observation_id", "in", [idOf(away), idOf(back)]).execute();
    expect(rows.map((r) => r.namespace_id)).toEqual([provider, provider]);
  });
});

describe("2. a tag's strength is derivable at an arbitrary instant", () => {
  it("day twelve: the sub-threshold change is tagged into limbo, and the move back refreshes that tag rather than opening a second", async () => {
    advanceTo(day(12, "16:50"));
    // g0 below whatever threshold M2 sets: this is the observation that
    // alerts nobody. Lowering the provider's brief threshold on its account
    // is M2's arithmetic and is not stored here.
    limboTag = await tags.open({
      // The aspect the tagging vocabulary gives this channel: address_integrity
      // is categorical and one transition is one aspect, so a revert is a
      // second observation on the same aspect, which is what refresh is for
      // (tagging reading.ts, the address_integrity template).
      namespaceId: provider, observationId: idOf(stored.movedAway!),
      channel: "address_integrity", aspect: "transition", g0: 0.6,
      // From the decision, which stamps the EVENT's own instant -- 08:15,
      // when the address moved -- while the clock reads 16:50, when the
      // decision was made. The two must differ here or this story cannot see
      // the inversion the card was written to remove: with them equal, `open`
      // stamping from the clock instead of the decision passes every
      // assertion below. A mutation audit found exactly that, and the comment
      // this replaces conceded it ("the clock here happens to agree").
      taggedAt: day(12, "08:15"),
    });
    await audit("tag.opened", {
      tagId: limboTag.tagId, observationId: limboTag.observationId,
      channel: limboTag.channel, g0: limboTag.g0, taggedAt: limboTag.taggedAt.toISOString(),
    });
    // A repeated deviation on an already-tagged pair refreshes rather than
    // stacks. What is stored is what M2's decision returned, and nothing
    // here recomputes it: the maximum M2 takes is over the DECAYED strength
    // at the instant of the repeat, which this package cannot compute because
    // it holds no half-life. Under M1's arithmetic this row would have kept
    // 0.6 by taking the greater of the two stored numbers, which is the
    // substitution the storage card exists to remove.
    const refreshedAt = day(12, "17:30");
    // The story's clock moves with it: the repeat happens forty minutes
    // later, and a decision may not stamp a tag ahead of the clock.
    advanceTo(refreshedAt);
    // The number comes from the curve, not from what makes the test pass.
    // M2's refreshTag holds max(decayedStrength, freshG0), so a fresh
    // deviation weaker than what is already there leaves the decayed value
    // standing: nine and a quarter hours from the tag's own instant into a
    // seven-day half-life, 0.6 has decayed to 0.577533… and that is what the
    // decision returns. Nine and a quarter hours, not the forty minutes
    // between the two clock readings, because the decay runs from when the
    // address moved and not from when anyone noticed.
    const decayed = strengthAt(limboTag, refreshedAt, HALF_LIFE);
    const held = Math.max(decayed, 0.1);
    expect(held).toBe(decayed);
    await tags.refresh(limboTag.tagId, {
      g0: held, taggedAt: refreshedAt, refreshCount: 1, saturationState: "open",
    });
    await audit("tag.refreshed", { tagId: limboTag.tagId, g0: held });
    const after = await tags.get(limboTag.tagId);
    expect(after.refreshCount).toBe(1);
    // M1's arithmetic took greatest(stored g0, new g0) and would have left
    // 0.6 here. M2's takes the maximum over the DECAYED strength and returns
    // 0.577533…, which is smaller, and that difference is the whole
    // substitution this card removed.
    expect(after.g0).toBe(held);
    expect(after.g0).toBeLessThan(0.6);
    expect(after.g0).toBeCloseTo(0.577533, 6);
    expect(after.taggedAt.toISOString()).toBe(refreshedAt.toISOString());
    // And the tag was opened at the event's instant, not at the clock's. This
    // is the assertion that makes the story able to see F2 at all.
    expect(limboTag.taggedAt.toISOString()).toBe(day(12, "08:15").toISOString());
    expect(limboTag.aspect).toBe("transition");
    expect(await tags.listLive(provider)).toHaveLength(1);
  });

  it("day twenty-one: the large quote arrives, the brief reads the tag's strength at four instants, and writes nothing", async () => {
    const at = day(21, "10:00");
    stored.largeQuote = await ingest(largeQuote, at);
    const quote = await roundTrips(largeQuote, stored.largeQuote, at);
    expect(quote.salienceHints?.amount).toBe("2500.0000000");

    const before = await tagRowVersions();
    const tag = await tags.get(limboTag.tagId);
    const at_ = (instant: Date) => strengthAt(tag, instant, HALF_LIFE);
    // The readings follow from the g0 the decision wrote, which is the
    // decayed strength at the refresh rather than the 0.6 M1 would have kept.
    const g0 = tag.g0;
    expect(g0).toBeLessThan(0.6);
    // Before the tag existed: g0, not more. A clock skew cannot invent
    // evidence.
    expect(at_(day(0))).toBeCloseTo(g0, 12);
    // At the instant of tagging: g0.
    expect(at_(tag.taggedAt)).toBeCloseTo(g0, 12);
    // One half-life on: half.
    expect(at_(new Date(tag.taggedAt.getTime() + HALF_LIFE))).toBeCloseTo(g0 / 2, 12);
    // Now, nine days on: still there, still readable, and less than half.
    const now = at_(clock.now());
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(g0 / 2);
    // The brief is a decision, and the strength it read is reproducible from
    // this entry and the tag's row, because nothing was overwritten to
    // produce it.
    await audit("brief.read", {
      namespaceId: provider, at: clock.now().toISOString(),
      tags: [{ tagId: tag.tagId, strength: now, halfLifeMs: HALF_LIFE }],
    });
    expect(await tagRowVersions()).toEqual(before);
  });
});

describe("3. a promotion preserves the original timestamp", () => {
  it("day twenty-one: the quote is surprising against the provider's history, and rescues both day-twelve observations into the permanent record", async () => {
    advanceTo(day(21, "10:01"));
    // The surprise is stored as given; the arithmetic that produces it is
    // M2's, and which trigger statuses rescue is M3's policy. What the store
    // holds is that a rescuer belongs to the same counterparty as the record
    // it rescues.
    quoteTrigger = await triggers.record({
      namespaceId: provider, observationId: idOf(stored.largeQuote!),
      status: "verified", surprise: 4.2,
    });
    await audit("trigger.recorded", {
      triggerId: quoteTrigger.triggerId, observationId: quoteTrigger.observationId,
      status: quoteTrigger.status, surprise: quoteTrigger.surprise,
    });
    for (const source of [stored.movedAway!, stored.movedBack!]) {
      const record = await records.promote({
        observationId: idOf(source), namespaceId: provider,
        rescuedBy: quoteTrigger.triggerId, confidence: 0.8,
      });
      await audit("record.promoted", {
        recordId: record.recordId, observationId: record.observationId,
        rescuedBy: record.rescuedBy,
        originalDatedAt: record.originalDatedAt.toISOString(),
        promotedAt: record.promotedAt.toISOString(),
      });
      promoted.push(record);
    }
    expect(promoted.map((r) => r.originalDatedAt.toISOString())).toEqual([
      "2026-09-12T08:14:00.000Z", "2026-09-12T16:47:00.000Z",
    ]);
    expect(promoted.map((r) => r.promotedAt.toISOString())).toEqual([
      day(21, "10:01").toISOString(), day(21, "10:01").toISOString(),
    ]);
    expect(promoted.map((r) => r.rescuedBy)).toEqual([quoteTrigger.triggerId, quoteTrigger.triggerId]);
  });

  it("read back on day twenty-one, the address change is still dated day twelve", async () => {
    for (const record of promoted) {
      const read = await records.get(record.recordId);
      expect(read).toEqual(record);
      expect(read.originalDatedAt.toISOString().slice(0, 10)).toBe(dayString(12));
      expect(read.promotedAt.toISOString().slice(0, 10)).toBe(dayString(21));
    }
  });

  it("a record that moves the change to day twenty-one is refused by the database, by class, and nothing is written", async () => {
    const failure = await sql`
      insert into permanent_record
        (record_id, observation_id, namespace_id, original_dated_at, promoted_at, confidence)
      values (gen_random_uuid(), ${idOf(stored.movedAway!)}, ${provider},
              ${clock.now()}, ${clock.now()}, 0.5)
    `.execute(db).then(() => null, (e: unknown) => e);
    expect(mapPgError(failure)).toBeInstanceOf(TimestampAltered);
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("namespace_id", "=", provider).execute();
    expect(rows.map((r) => r.record_id).sort()).toEqual(promoted.map((r) => r.recordId).sort());
  });
});

let tagVersionsBeforeSweep: string[] = [];

describe("4. the audit chain verifies", () => {
  it("holds one entry per operation the story performed, in order, and nothing else", async () => {
    const rows = await db.selectFrom("audit_entry").select(["seq", "kind"]).orderBy("seq").execute();
    expect(rows).toEqual(journal);
    expect(journal.map((j) => j.kind)).toEqual([
      "observation.appended", "observation.appended",
      "observation.appended", "observation.appended",
      "tag.opened", "tag.refreshed",
      "observation.appended", "brief.read",
      "trigger.recorded", "record.promoted", "record.promoted",
    ]);
  });

  it("day twenty-two: the nightly job verifies the chain over all of them", async () => {
    advanceTo(day(22, "00:05"));
    expect(await chain.verify()).toEqual({ ok: true });
  });

  // The tamper the story fears most: the audit record of the promotion
  // rewritten to say the change happened on day twenty-one. Planted with the
  // guard off inside a transaction that is rolled back, as chain.test.ts
  // does, so the guard comes back and the table the seals see is the one
  // the story built.
  it("localises a rewrite of the promotion's recorded instant to its own entry, and the guard comes back", async () => {
    const target = journal.find((j) => j.kind === "record.promoted")!;
    const ROLLBACK = Symbol("rollback");
    let verdict: VerifyResult | undefined;
    await db.transaction().execute(async (trx) => {
      await sql`alter table audit_entry disable trigger audit_entry_no_rewrite`.execute(trx);
      await sql`update audit_entry
                set body = jsonb_set(body, '{originalDatedAt}', to_jsonb(${day(21, "10:01").toISOString()}::text))
                where seq = ${target.seq}`.execute(trx);
      verdict = await new AuditChain(trx, clock, ring).verify();
      throw ROLLBACK;
    }).catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
    expect(verdict).toEqual({ ok: false, brokenAt: target.seq, reason: "canonical" });

    const failure = await sql`update audit_entry set kind = 'x' where seq = ${target.seq}`
      .execute(db).then(() => null, (e: unknown) => e);
    expect(mapPgError(failure)).toBeInstanceOf(AppendOnlyViolation);
    expect(await chain.verify()).toEqual({ ok: true });
    const row = await db.selectFrom("audit_entry").select(["body"]).where("seq", "=", target.seq)
      .executeTakeFirstOrThrow();
    expect((row.body as { originalDatedAt: string }).originalDatedAt).toBe("2026-09-12T08:14:00.000Z");
  });

  it("seals every day from day zero to day twenty-one, refuses the day that is still open, and the chain still verifies", async () => {
    // A day on which nothing was decided is still a day the chain stood at
    // some head, and a seal for every day is what an auditor walks.
    for (let n = 0; n <= 21; n++) await chain.sealDay(dayString(n));
    await expect(chain.sealDay(dayString(22))).rejects.toBeInstanceOf(DayNotClosed);
    const seals = await db.selectFrom("audit_day").select(["day", "terminal_seq"]).orderBy("day").execute();
    expect(seals).toHaveLength(22);
    // Day eleven's head is still day zero's last entry; day twelve's is the
    // tag refresh; day twenty-one's is the chain's head.
    const seq = (kind: string, nth: number) => journal.filter((j) => j.kind === kind)[nth]!.seq;
    expect(seals[11]!.terminal_seq).toBe(seq("observation.appended", 1));
    expect(seals[12]!.terminal_seq).toBe(seq("tag.refreshed", 0));
    expect(seals[21]!.terminal_seq).toBe(journal.at(-1)!.seq);
    expect(await chain.verify()).toEqual({ ok: true });
  });
});

// The fifth criterion, and the sentence the whole card exists for: a captured
// trace outlives its month.
//
// It runs last on purpose. Everything above proves the four M1 criteria on a
// live database; this proves they survive the thing retention does TO that
// database, which is the M1 lesson the M2 spec records in §14 -- criteria
// that hold in isolation and not in composition.
describe("5. retention runs, and the rescue survives it", () => {
  // Day 0 is 31 August and day 12 is 12 September, so this story spans two
  // calendar months and therefore two month keys per namespace. August closed
  // on 1 September and expired on the 4th; September closes on 1 October and
  // expires on the 4th.
  //
  // The sweep therefore runs TWICE, and the two days are the point. On day
  // thirty-three August is past its grace and September has a day left, so a
  // sweep that ignored `expires_at` would be visible here and nowhere else in
  // this file. On day thirty-five September's grace has run out, and a sweep
  // that ignored `key_wrapped is not null` would hand August back a second
  // time. A single sweep on day thirty-five proves neither, because by then
  // every month in the database is expired -- which is what stood here, with
  // a name that claimed both rules. Both mutants die in the unit suite too;
  // this file is where they have to die in COMPOSITION.
  //
  // Note what the gap between the two days means and does not mean: from day
  // four to day thirty-three August is expired and still readable, because
  // `openPeriodKey` asks whether the key was shredded and never asks the
  // clock. Expiry is what the sweep acts on, not a state the store enforces
  // on read; the sweep is the caller's to run, and until it runs nothing has
  // happened.
  const FIRST_SWEEP_DAY = 33; // 3 October 2026, one day inside September's grace
  const SWEEP_DAY = 35; // 5 October 2026

  it("holds two months for each namespace before anything is swept", async () => {
    // Asserted from the STORY rather than read off the sweep: day zero wrote
    // to both namespaces in August, day twelve onwards in September. Without
    // this the sweep's own list would be its own oracle.
    const wallet = (await namespaces.find(WALLET.kind, WALLET.id))!.namespaceId;
    // Three key rows, not four, and the asymmetry is the story rather than
    // an accident: the two address changes and the price quote are evidence
    // ABOUT THE PROVIDER -- a provider's payment address changed -- so they
    // land in the provider's September. The wallet is named in the day-zero
    // payment and never again, so it holds August alone. Getting this wrong
    // was my first guess, and writing it down is cheaper than guessing again.
    expect(await namespaces.periodsOf(provider)).toEqual(["2026-08-01", "2026-09-01"]);
    expect(await namespaces.periodsOf(wallet)).toEqual(["2026-08-01"]);
  });

  it("day thirty-three: takes the two Augusts and leaves September standing, with a day of its grace to run", async () => {
    advanceTo(day(FIRST_SWEEP_DAY, "03:00"));
    const wallet = (await namespaces.find(WALLET.kind, WALLET.id))!.namespaceId;
    // Captured here, one line before the FIRST sweep, rather than at the end
    // of criterion four: the tag assertion below has to compare against the
    // instant before expiry, and reading it from another describe block made
    // that depend on the order of two blocks instead of on one line.
    tagVersionsBeforeSweep = await tagRowVersions();
    const { shredded } = await namespaces.expirePeriods();
    expect(shredded).toEqual([
      { namespaceId: provider, period: "2026-08-01", namespaceErasedAtSweep: false },
      { namespaceId: wallet, period: "2026-08-01", namespaceErasedAtSweep: false },
    // The repository's own comparator, so the test states the same rule the
    // code does rather than a locale-dependent approximation of it.
    ].sort(sweepOrder));
    // And the day-twelve observations still read, which is the other half of
    // "leaves September standing": the grace is a promise about readability,
    // so asserting only the sweep's return would let a sweep that shredded
    // September and forgot to mention it pass.
    for (const name of ["movedAway", "movedBack", "largeQuote"] as const) {
      const still = await observations.get(idOf(stored[name]!));
      expect(still.observationId, name).toBe(idOf(stored[name]!));
      expect("observedAt" in still ? still.observedAt : "", name).toMatch(/^2026-09-/);
    }
  });

  it("day thirty-five: September's grace runs out, the sweep takes it and hands back no August twice", async () => {
    advanceTo(day(SWEEP_DAY, "03:00"));
    const { shredded } = await namespaces.expirePeriods();
    // One row, and the two Augusts are NOT in it. Neither namespace was
    // erased on request, so this is a retention expiry and the flag says so
    // -- the mixed case is exercised in the unit suite.
    expect(shredded).toEqual([
      { namespaceId: provider, period: "2026-09-01", namespaceErasedAtSweep: false },
    ]);
    // The store wrote no audit row for either sweep. The nightly job's
    // `periods.expired` entry is M4's to write from exactly this return
    // value, which is why the sweep returns it at all.
    expect(journal.filter((j) => j.kind.startsWith("periods"))).toEqual([]);
  });

  it("makes every day-twelve observation unreadable, and leaves its row standing", async () => {
    for (const [name, o] of Object.entries(stored)) {
      await expect(observations.get(idOf(o!)), name).rejects.toBeInstanceOf(PayloadExpired);
    }
    // Unreadability and nothing else: the rows, the foreign keys and the key
    // rows are all where they were.
    const counts = await sql<{ obs: string; keys: string; orphans: string }>`
      select (select count(*) from observation)::text as obs,
             (select count(*) from namespace_key)::text as keys,
             (select count(*) from observation o where not exists (
                select 1 from namespace_key k
                 where k.namespace_id = o.namespace_id and k.period = o.period))::text as orphans
    `.execute(db);
    expect(counts.rows[0]!.obs).toBe("5");
    expect(counts.rows[0]!.keys).toBe("3");
    expect(counts.rows[0]!.orphans).toBe("0");
  });

  it("still reads both rescued observations back, dated day twelve", async () => {
    // This is the card's sentence. The sources are gone and the rescues are
    // not, because a promotion re-sealed them under the namespace key while
    // the month keys were what expired.
    expect(promoted).toHaveLength(2);
    // Read out of the RESCUE after the sweep, not off the array criterion
    // three filled before it. The previous version of this test checked only
    // `observationId` and then asserted the date from `promoted`, so a
    // `read` that returned any date at all passed: measured with a `read`
    // stamping 2099, twenty of twenty green. "Dated day twelve" is the
    // card's sentence, so it is the half that has to come back from disk.
    const rescuedDates: (string | null)[] = [];
    const recordDates: string[] = [];
    for (const record of promoted) {
      const rescued = await records.read(record.recordId);
      expect(rescued.observationId).toBe(record.observationId);
      rescuedDates.push("observedAt" in rescued ? rescued.observedAt : null);
      // And the metadata row, re-read after the sweep rather than
      // remembered from before it.
      recordDates.push((await records.get(record.recordId)).originalDatedAt.toISOString());
      await expect(observations.get(record.observationId)).rejects.toBeInstanceOf(PayloadExpired);
    }
    const dayTwelve = ["2026-09-12T08:14:00.000Z", "2026-09-12T16:47:00.000Z"];
    expect(rescuedDates).toEqual(dayTwelve);
    expect(recordDates).toEqual(dayTwelve);
    expect(promoted.map((r) => r.originalDatedAt.toISOString().slice(0, 10)))
      .toEqual(["2026-09-12", "2026-09-12"]);
  });

  it("leaves the tag exactly as it was, because retention is not a decision", async () => {
    // `xmin` moves on any UPDATE, including one that writes the value a
    // column already had, so this is the strongest form of "untouched".
    expect(await tagRowVersions()).toEqual(tagVersionsBeforeSweep);
    expect(await tags.listLive(provider)).toHaveLength(1);
  });

  it("verifies the chain, and re-sealing every day after the sweep moves nothing", async () => {
    expect(await chain.verify()).toEqual({ ok: true });
    // Sealing a day that is already sealed is a no-op rather than an error,
    // so the nightly job can re-run over a range it has seen. Re-sealed
    // here across the whole scenario, after the sweep, to show that expiry
    // moved no seal.
    //
    // What this does NOT prove, and used to claim by its name: that the
    // re-seal VERIFIES anything. `sealDay`'s existing-seal branch checks the
    // sealed entry's hash and the seal's HMAC, and replacing both checks
    // with `true` leaves every test in this file green -- the branch is
    // taken, but nothing here can tell a check from a skip. Those two rules
    // are held in `chain.test.ts` by "refuses to re-seal a day whose sealed
    // entry was rewritten" and "...whose seal no longer verifies", which is
    // where a corrupted seal can be planted. Measured, both directions.
    const before = await db.selectFrom("audit_day").select(["day", "terminal_seq"])
      .orderBy("day").execute();
    for (let n = 0; n <= 21; n++) await chain.sealDay(dayString(n));
    const after = await db.selectFrom("audit_day").select(["day", "terminal_seq"])
      .orderBy("day").execute();
    expect(after).toEqual(before);
    expect(await chain.verify()).toEqual({ ok: true });
  });

  it("answers a re-delivery of the day-twelve fixture instead of throwing", async () => {
    // The indexer's normal retry, after the month it belongs to is gone. It
    // is answered, not refused, and the answer says which erasure happened:
    // the month expired and the counterparty space did not.
    const again = await observations.append(movedAway);
    expect(again).toMatchObject({
      created: false,
      readable: false,
      observationId: idOf(stored.movedAway!),
      periodExpired: true,
      namespaceErased: false,
    });
  });

  it("adds no kind to the journal, because the store writes no audit row", async () => {
    // The eleven kinds of criterion four, unchanged. Retention is an
    // operation the CALLER journals; this suite is the caller and
    // deliberately does not, so that the absence is visible here rather
    // than assumed.
    expect(journal.map((j) => j.kind)).toEqual([
      "observation.appended", "observation.appended",
      "observation.appended", "observation.appended",
      "tag.opened", "tag.refreshed",
      "observation.appended", "brief.read",
      "trigger.recorded", "record.promoted", "record.promoted",
    ]);
    // And the DATABASE agrees with the journal, which is the half that
    // carries the claim. `journal` grows only when this file calls
    // `audit()`, so a store method that appended an entry of its own would
    // leave the array untouched and the assertion above green. Measured
    // rather than reasoned: an `AuditChain.append` planted at the top of
    // `expirePeriods` passed 462 of 463 tests, and the one that went red did
    // so because it happened to call the sweep inside a transaction and
    // R21's guard fired -- a test of another rule entirely, which is not
    // evidence for this one. This comparison is what refuses the plant.
    const entries = await sql<{ kind: string }>`
      select kind from audit_entry order by seq`.execute(db);
    expect(entries.rows.map((r) => r.kind)).toEqual(journal.map((j) => j.kind));
  });
});
