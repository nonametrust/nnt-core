import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { HotWindowNotFound, StoreError, TriggerEventNotFound } from "../errors.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";
import { PermanentRecordRepository } from "./permanent-record.js";
import { BaselineRepository, type BaselineState } from "./baseline.js";
import { TriggerEventRepository } from "./trigger-event.js";
import { VolatilityRepository } from "./volatility.js";
import { HotWindowRepository } from "./hot-window.js";

// The four tables M2 and M3 fill. Every test here writes a row and reads it
// back, or proves the database refuses a row it must never hold. Nothing in
// this file computes a Welford update, a MAD, a surprise or a window scale;
// the numbers are chosen to be distinct from each other and from the column
// defaults, so a column that came back as a default instead of as written
// would show.

let db: Db;
let done: () => Promise<void>;
let namespaces: NamespaceRepository;
let observations: ObservationRepository;
let records: PermanentRecordRepository;
let baselines: BaselineRepository;
let triggers: TriggerEventRepository;
let volatilities: VolatilityRepository;
let windows: HotWindowRepository;
let ns: string;
let obs: string;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
const clock = fixedClock(new Date("2026-09-12T09:00:00.000Z"));

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "testnet", ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

let seq = 0;
async function appendUnder(nsId: string): Promise<string> {
  seq += 1;
  const { observation } = await observations.append({
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: nsId },
    channel: "volume", evidenceKind: "event", kind: "payment",
    observedAt: "2026-09-12T08:00:00.000Z",
    source: { ...src, ref: `op:${seq}` }, payload: { amount: "500.0000000" },
    salienceHints: { amount: "500.0000000" },
  } as WireObservation);
  return observation.observationId!;
}

function aBaseline(over: Partial<BaselineState> = {}): BaselineState {
  return {
    namespaceId: ns, channel: "volume", aspect: "amount",
    count: 7, mean: 512.5, m2: 1024.25,
    medianEst: 500, madEst: 12.5,
    fastMean: 530.1, fastM2: 90.9, slowMean: 505.5, slowM2: 2048.5,
    ...over,
  };
}

beforeAll(async () => {
  ({ db, done } = await withSchema("later_tables_test"));
  namespaces = new NamespaceRepository(db, ring, clock);
  observations = new ObservationRepository(db, namespaces, clock);
  records = new PermanentRecordRepository(db, clock);
  baselines = new BaselineRepository(db, clock);
  triggers = new TriggerEventRepository(db, clock);
  volatilities = new VolatilityRepository(db, clock);
  windows = new HotWindowRepository(db);
  ns = (await namespaces.ensure({ kind: "wallet", id: "GOLDADDRESS" })).namespaceId;
  obs = await appendUnder("GOLDADDRESS");
});
afterAll(async () => { await done(); });

describe("baseline", () => {
  it("round-trips every column through upsert and forNamespace", async () => {
    const state = aBaseline({ aspect: "roundtrip" });
    const written = await baselines.upsert(state);
    expect(written).toEqual({ ...state, updatedAt: clock.now() });
    const read = (await baselines.forNamespace(ns)).filter((b) => b.aspect === "roundtrip");
    expect(read).toEqual([written]);
  });

  it("keeps one baseline per namespace, channel and aspect, holding the latest state", async () => {
    await baselines.upsert(aBaseline({ aspect: "once", count: 1 }));
    clock.advance(1000);
    await baselines.upsert(aBaseline({ aspect: "once", count: 2, medianEst: null, madEst: null }));
    const all = (await baselines.forNamespace(ns)).filter((b) => b.aspect === "once");
    expect(all).toHaveLength(1);
    expect(all[0]!.count).toBe(2);
    expect(all[0]!.medianEst).toBeNull();
    expect(all[0]!.madEst).toBeNull();
    expect(all[0]!.updatedAt).toEqual(clock.now());
  });

  // The field is `count` and the column is `n`. The mapping is proved against
  // the column by name, so a repository that wrote the count somewhere else
  // and read it back from there would not pass by being its own inverse.
  it("stores count in the column named n", async () => {
    await baselines.upsert(aBaseline({ aspect: "named", count: 41 }));
    const row = await sql<{ n: string }>`
      select n from baseline where namespace_id = ${ns} and channel = 'volume' and aspect = 'named'
    `.execute(db);
    expect(row.rows[0]!.n).toBe("41");
  });

  it("is empty for a namespace with no baseline, not an error", async () => {
    const other = (await namespaces.ensure({ kind: "wallet", id: "NOBASELINE" })).namespaceId;
    expect(await baselines.forNamespace(other)).toEqual([]);
  });

  it("refuses a negative count", async () => {
    await expect(baselines.upsert(aBaseline({ aspect: "neg", count: -1 })))
      .rejects.toMatchObject({ code: "23514" });
  });

  // A NaN in a running mean is permanent: every later update is NaN plus
  // something, and there is no observation that brings it back. A baseline
  // is per namespace, channel and aspect, so one such row blinds that whole
  // aspect for that counterparty. Postgres's own ordering puts NaN above
  // every double, so a sign check alone would let it in; these prove the
  // guard holds for every float column, from a raw writer, and that the sum
  // of squares and the MAD refuse a sign they cannot have.
  it("refuses NaN and either infinity in every float column, from a raw writer", async () => {
    const signed = ["mean", "median_est", "fast_mean", "slow_mean"];
    const unsigned = ["m2", "mad_est", "fast_m2", "slow_m2"];
    const cases: Array<[string, string]> = [];
    for (const c of [...signed, ...unsigned]) {
      cases.push([c, "'NaN'::float8"], [c, "'Infinity'::float8"], [c, "'-Infinity'::float8"]);
    }
    for (const c of unsigned) cases.push([c, "-1"]);
    for (const [column, value] of cases) {
      await expect(
        sql`insert into baseline (namespace_id, channel, aspect, updated_at, ${sql.ref(column)})
            values (${ns}, 'volume', ${`raw:${column}`}, ${clock.now()}, ${sql.raw(value)})`
          .execute(db),
        `${column} = ${value}`,
      ).rejects.toMatchObject({ code: "23514" });
    }
    // A signed column takes a negative, so the sign checks are on the right
    // columns and not on all of them.
    await expect(baselines.upsert(aBaseline({ aspect: "signed", mean: -3, medianEst: -2, fastMean: -1, slowMean: -0.5 })))
      .resolves.toMatchObject({ mean: -3 });
  });

  it("refuses the same through the repository, and leaves the stored state as it was", async () => {
    await baselines.upsert(aBaseline({ aspect: "poison", mean: 1 }));
    await expect(baselines.upsert(aBaseline({ aspect: "poison", mean: Number.NaN })))
      .rejects.toMatchObject({ code: "23514" });
    await expect(baselines.upsert(aBaseline({ aspect: "poison", m2: -1 })))
      .rejects.toMatchObject({ code: "23514" });
    const read = (await baselines.forNamespace(ns)).find((b) => b.aspect === "poison");
    expect(read?.mean).toBe(1);
  });
});

describe("trigger_event", () => {
  it("round-trips every column through record and get", async () => {
    const cluster = randomUUID();
    const t = await triggers.record({
      namespaceId: ns, observationId: obs, status: "harm_confirmed",
      tier: "B", clusterId: cluster, surprise: 9.1,
    });
    expect(t.triggerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t).toEqual({
      triggerId: t.triggerId, namespaceId: ns, observationId: obs, status: "harm_confirmed",
      tier: "B", clusterId: cluster, surprise: 9.1, createdAt: clock.now(),
    });
    expect(await triggers.get(t.triggerId)).toEqual(t);
  });

  it("carries an omitted tier and cluster back as null", async () => {
    const t = await triggers.record({ namespaceId: ns, observationId: obs, status: "candidate", surprise: 3.2 });
    const read = await triggers.get(t.triggerId);
    expect(read.tier).toBeNull();
    expect(read.clusterId).toBeNull();
    expect(read.status).toBe("candidate");
  });

  // A tier is the evidence grade of a harm-confirmed trigger and of nothing
  // else; a candidate with a tier would read as graded evidence in a brief.
  it("refuses a tier on a status that is not harm-confirmed", async () => {
    for (const status of ["candidate", "verified"] as const) {
      await expect(triggers.record({
        namespaceId: ns, observationId: obs, status, tier: "high", surprise: 3.2,
      })).rejects.toMatchObject({ code: "23514", constraint: "trigger_event_tier_needs_harm" });
    }
  });

  it("accepts a tier on a harm-confirmed status", async () => {
    const t = await triggers.record({
      namespaceId: ns, observationId: obs, status: "harm_confirmed", tier: "high", surprise: 9.1,
    });
    expect((await triggers.get(t.triggerId)).tier).toBe("high");
  });

  it("refuses a status outside the three grades", async () => {
    await expect(
      sql`insert into trigger_event (trigger_id, namespace_id, observation_id, status, surprise, created_at)
          values (${randomUUID()}, ${ns}, ${obs}, 'suspected', 1, ${clock.now()})`.execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "trigger_event_status_known" });
  });

  it("refuses a surprise that is NaN or infinite", async () => {
    for (const surprise of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(triggers.record({ namespaceId: ns, observationId: obs, status: "candidate", surprise }))
        .rejects.toMatchObject({ code: "23514" });
    }
  });

  // The finding Task 7 and Task 8 both made: two independent keys would let
  // a trigger be filed under a namespace its observation is not about, and
  // the nightly job would then scale the wrong counterparty's window.
  it("refuses a trigger filed under a namespace its observation does not belong to", async () => {
    const other = (await namespaces.ensure({ kind: "wallet", id: "SOMEONEELSE" })).namespaceId;
    await expect(triggers.record({ namespaceId: other, observationId: obs, status: "candidate", surprise: 1 }))
      .rejects.toMatchObject({ code: "23503", constraint: "trigger_event_observation_in_namespace" });
  });

  it("names a missing trigger by class, so a bad id is not mistaken for a bug", async () => {
    await expect(triggers.get(randomUUID())).rejects.toBeInstanceOf(TriggerEventNotFound);
    await expect(triggers.get(randomUUID())).rejects.toBeInstanceOf(StoreError);
  });
});

describe("volatility", () => {
  it("round-trips through upsert and get", async () => {
    const v = await volatilities.upsert({ namespaceId: ns, qHat: 0.4 });
    expect(v).toEqual({ namespaceId: ns, qHat: 0.4, updatedAt: clock.now() });
    expect(await volatilities.get(ns)).toEqual(v);
  });

  it("keeps one volatility row per namespace", async () => {
    await volatilities.upsert({ namespaceId: ns, qHat: 0.4 });
    clock.advance(1000);
    await volatilities.upsert({ namespaceId: ns, qHat: 0.9 });
    const rows = await db.selectFrom("volatility").select(["q_hat"]).where("namespace_id", "=", ns).execute();
    expect(rows).toEqual([{ q_hat: 0.9 }]);
    expect((await volatilities.get(ns))!.updatedAt).toEqual(clock.now());
  });

  it("is null for a namespace with no volatility, not an error", async () => {
    const other = (await namespaces.ensure({ kind: "wallet", id: "NOVOLATILITY" })).namespaceId;
    expect(await volatilities.get(other)).toBeNull();
  });

  it("refuses a q_hat that is negative, NaN or infinite", async () => {
    for (const qHat of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(volatilities.upsert({ namespaceId: ns, qHat })).rejects.toMatchObject({ code: "23514" });
    }
  });
});

describe("hot_window", () => {
  let trig: string;
  beforeAll(async () => {
    trig = (await triggers.record({ namespaceId: ns, observationId: obs, status: "verified", surprise: 4 })).triggerId;
  });

  it("round-trips every column through open and get", async () => {
    const w = await windows.open({
      namespaceId: ns, triggerId: trig,
      opensAt: new Date("2026-09-12T00:00:00.000Z"),
      closesAt: new Date("2026-09-21T00:00:00.000Z"),
      scale: 1.5,
    });
    expect(w.windowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(w).toEqual({
      windowId: w.windowId, namespaceId: ns, triggerId: trig,
      opensAt: new Date("2026-09-12T00:00:00.000Z"),
      closesAt: new Date("2026-09-21T00:00:00.000Z"),
      scale: 1.5,
    });
    expect(await windows.get(w.windowId)).toEqual(w);
  });

  it("refuses a window that closes before it opens", async () => {
    await expect(windows.open({
      namespaceId: ns, triggerId: trig,
      opensAt: new Date("2026-09-21T00:00:00.000Z"),
      closesAt: new Date("2026-09-12T00:00:00.000Z"),
      scale: 1,
    })).rejects.toMatchObject({ code: "23514", constraint: "hot_window_ordered" });
  });

  it("refuses a window that closes the instant it opens, because an empty window captures nothing", async () => {
    await expect(windows.open({
      namespaceId: ns, triggerId: trig,
      opensAt: new Date("2026-09-12T00:00:00.000Z"),
      closesAt: new Date("2026-09-12T00:00:00.000Z"),
      scale: 1,
    })).rejects.toMatchObject({ code: "23514", constraint: "hot_window_ordered" });
  });

  it("refuses a scale that is zero, negative, NaN or infinite", async () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(windows.open({
        namespaceId: ns, triggerId: trig,
        opensAt: new Date("2026-09-12T00:00:00.000Z"),
        closesAt: new Date("2026-09-21T00:00:00.000Z"),
        scale,
      })).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("refuses a window filed under a namespace its trigger is not about", async () => {
    const other = (await namespaces.ensure({ kind: "wallet", id: "SOMEONEELSE" })).namespaceId;
    await expect(windows.open({
      namespaceId: other, triggerId: trig,
      opensAt: new Date("2026-09-12T00:00:00.000Z"),
      closesAt: new Date("2026-09-21T00:00:00.000Z"),
      scale: 1,
    })).rejects.toMatchObject({ code: "23503", constraint: "hot_window_trigger_in_namespace" });
  });

  it("names a missing window by class", async () => {
    await expect(windows.get(randomUUID())).rejects.toBeInstanceOf(HotWindowNotFound);
    await expect(windows.get(randomUUID())).rejects.toBeInstanceOf(StoreError);
  });
});

// The round trips above cover the columns the repositories know about. This
// pins the catalogue to the design's list for each table, as tag.test.ts does
// for tag, so a column added in SQL alone is a failing test and not a field
// that silently never reaches a reader.
describe("the columns, in the catalogue", () => {
  async function columnsOf(table: string): Promise<string[]> {
    const rows = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = ${table} and table_schema = current_schema()
    `.execute(db);
    return rows.rows.map((r) => r.column_name).sort();
  }

  it("hold exactly what the design enumerates", async () => {
    expect(await columnsOf("baseline")).toEqual([
      "aspect", "channel", "fast_m2", "fast_mean", "m2", "mad_est", "mean", "median_est",
      "n", "namespace_id", "slow_m2", "slow_mean", "updated_at",
    ]);
    expect(await columnsOf("trigger_event")).toEqual([
      "cluster_id", "created_at", "namespace_id", "observation_id", "status", "surprise", "tier", "trigger_id",
    ]);
    expect(await columnsOf("volatility")).toEqual(["namespace_id", "q_hat", "updated_at"]);
    expect(await columnsOf("hot_window")).toEqual([
      "closes_at", "namespace_id", "opens_at", "scale", "trigger_id", "window_id",
    ]);
  });
});

// Carried from Task 8: rescued_by was declared without a foreign key in 0004
// because trigger_event did not exist yet, and its non-null pass-through was
// untestable until now. These are the two halves of that deliverable.
describe("permanent_record.rescued_by, now that trigger_event exists", () => {
  it("survives a promotion that names a real trigger", async () => {
    const source = await appendUnder("GOLDADDRESS");
    const trig = (await triggers.record({ namespaceId: ns, observationId: obs, status: "verified", surprise: 5 })).triggerId;
    const record = await records.promote({
      observationId: source, namespaceId: ns, rescuedBy: trig, confidence: 0.7,
    });
    expect(record.rescuedBy).toBe(trig);
    expect((await records.get(record.recordId)).rescuedBy).toBe(trig);
  });

  it("refuses a rescued_by that names no trigger, by foreign key", async () => {
    const source = await appendUnder("GOLDADDRESS");
    await expect(records.promote({
      observationId: source, namespaceId: ns, rescuedBy: randomUUID(), confidence: 0.7,
    })).rejects.toMatchObject({ code: "23503", constraint: "permanent_record_rescued_by_fk" });
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", source).execute();
    expect(rows).toEqual([]);
  });
});
