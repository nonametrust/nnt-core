import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { StoreError, TagNotFound } from "../errors.js";
import { strengthAt } from "../strength.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";
import { TagRepository } from "./tag.js";

const DAY = 24 * 60 * 60 * 1000;

let db: Db;
let done: () => Promise<void>;
let namespaces: NamespaceRepository;
let observations: ObservationRepository;
let repo: TagRepository;
let ns: string;
let obs: string;
let obs2: string;
let obs3: string;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
const clock = fixedClock(new Date("2026-09-07T00:00:00.000Z"));

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "testnet", ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

function anEvent(over: Record<string, unknown> = {}): WireObservation {
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "GOLDADDRESS" },
    channel: "volume", evidenceKind: "event", kind: "payment",
    observedAt: "2026-09-12T09:00:00.000Z",
    source: src, payload: { amount: "500.0000000" },
    salienceHints: { amount: "500.0000000" },
    ...over,
  } as WireObservation;
}

// Three observations under one namespace, each with its own source ref so the
// idempotency key keeps them apart.
async function appendUnder(nsId: string, ref: string): Promise<string> {
  const { observation } = await observations.append(
    anEvent({ source: { ...src, ref }, namespace: { kind: "wallet", id: nsId } }),
  );
  return observation.observationId!;
}

beforeAll(async () => {
  ({ db, done } = await withSchema("tag_test"));
  namespaces = new NamespaceRepository(db, ring, clock);
  observations = new ObservationRepository(db, namespaces, clock);
  repo = new TagRepository(db, clock);
  obs = await appendUnder("GOLDADDRESS", "op:tag:1");
  obs2 = await appendUnder("GOLDADDRESS", "op:tag:2");
  obs3 = await appendUnder("GOLDADDRESS", "op:tag:3");
  ns = (await namespaces.find("wallet", "GOLDADDRESS"))!.namespaceId;
});
afterAll(async () => { await done(); });

// The xmin of every row, which Postgres rewrites on any UPDATE including one
// that sets a column to the value it already had. A row count would miss an
// in-place rewrite, and "no write" has to mean no write.
async function rowVersions(): Promise<string[]> {
  const r = await sql<{ v: string }>`select tag_id::text || ':' || xmin::text as v from tag order by tag_id`
    .execute(db);
  return r.rows.map((x) => x.v);
}

describe("what the table refuses to hold", () => {
  // Tag strength is never persisted. This reads the live catalogue rather than
  // the migration file, so a later ALTER TABLE cannot slip past a grep over
  // the original text.
  it("has no strength-like column, in the catalogue and not just in the file", async () => {
    const rows = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'tag' and table_schema = current_schema()
    `.execute(db);
    const offenders = rows.rows
      .map((r) => r.column_name)
      .filter((c) => /strength|score|decayed|current_g|weight/i.test(c));
    expect(offenders, `tag must not store strength; found ${offenders.join(", ")}`).toEqual([]);
  });

  // The name list above is a guess at what a strength column would be called,
  // and a column called `level` or `g_now` is not on it. The spec enumerates
  // what `tag` holds, so the stronger form of the same gate is that the
  // catalogue holds exactly that list: any column of any name added later
  // fails here and has to be argued into this test on purpose.
  it("holds exactly the columns the design enumerates, so an added column of any name is a decision", async () => {
    const rows = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'tag' and table_schema = current_schema()
    `.execute(db);
    expect(rows.rows.map((r) => r.column_name).sort()).toEqual([
      "channel", "g0", "namespace_id", "observation_id", "refresh_count",
      "saturation_state", "suppression_factor", "tag_id", "tagged_at",
    ]);
  });

  it("offers no way to delete a tag by identifier, because suppression is not deletion", () => {
    const surface = Object.getOwnPropertyNames(TagRepository.prototype);
    expect(surface.filter((m) => /delete|remove|drop/i.test(m))).toEqual([]);
  });
});

describe("opening and reading", () => {
  it("round-trips a tag through get, with the defaults a fresh tag carries", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", g0: 0.7 });
    expect(t.tagId).toMatch(/^[0-9a-f-]{36}$/);
    const read = await repo.get(t.tagId);
    expect(read).toEqual({
      tagId: t.tagId, namespaceId: ns, observationId: obs, channel: "volume", g0: 0.7,
      taggedAt: new Date("2026-09-07T00:00:00.000Z"),
      refreshCount: 0, saturationState: "open", suppressionFactor: 1,
    });
  });

  it("stamps taggedAt from the injected clock, not from the database's now()", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "latency", g0: 0.2 });
    expect(t.taggedAt.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("names a missing tag by class, so a bad id is not mistaken for a bug", async () => {
    await expect(repo.get(randomUUID())).rejects.toBeInstanceOf(TagNotFound);
    await expect(repo.get(randomUUID())).rejects.toBeInstanceOf(StoreError);
  });

  it("refuses a tag on an observation that does not exist, on the foreign key", async () => {
    await expect(
      repo.open({ namespaceId: ns, observationId: randomUUID(), channel: "volume", g0: 0.5 }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  // NaN and Infinity are accepted by a double precision column and NaN sorts
  // above every number in Postgres, so `check (g0 >= 0)` lets both through.
  // The refusal has to happen before the statement is sent.
  it("refuses a g0 that is negative or not a finite number, before writing", async () => {
    for (const g0 of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        repo.open({ namespaceId: ns, observationId: obs, channel: "volume", g0 }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe("suppression", () => {
  it("suppresses by raising the factor and leaves the row in place", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", g0: 1 });
    await repo.suppress(t.tagId, 4);
    const after = await repo.get(t.tagId);
    expect(after.suppressionFactor).toBe(4);
    expect(after.g0).toBe(1);
  });

  // Suppression only ever accelerates. A later call with a smaller factor
  // would slow a tag's decay back down, which is a way to revive evidence
  // that nothing in the design asks for; the larger factor stands.
  it("does not lower a factor already raised", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", g0: 1 });
    await repo.suppress(t.tagId, 4);
    await repo.suppress(t.tagId, 2);
    expect((await repo.get(t.tagId)).suppressionFactor).toBe(4);
  });

  it("refuses a factor below one or not finite, because that would be deceleration", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", g0: 1 });
    for (const factor of [0.5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repo.suppress(t.tagId, factor)).rejects.toBeInstanceOf(RangeError);
    }
    expect((await repo.get(t.tagId)).suppressionFactor).toBe(1);
  });

  it("names a missing tag by class rather than updating nothing quietly", async () => {
    await expect(repo.suppress(randomUUID(), 2)).rejects.toBeInstanceOf(TagNotFound);
  });
});

describe("refresh", () => {
  it("refreshes rather than stacking: the new g0 is the larger of the two", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs2, channel: "volume", g0: 0.4 });
    await repo.refresh(t.tagId, 0.9);
    await repo.refresh(t.tagId, 0.2);
    const after = await repo.get(t.tagId);
    expect(after.g0).toBe(0.9);
    expect(after.refreshCount).toBe(2);
  });

  // greatest(g0, NaN) is NaN in Postgres, so a NaN refresh that reached the
  // statement would replace a real g0 with one that no decay curve can read.
  it("refuses a g0 that is not a finite non-negative number, and leaves the tag as it was", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs2, channel: "volume", g0: 0.4 });
    for (const g0 of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repo.refresh(t.tagId, g0)).rejects.toBeInstanceOf(RangeError);
    }
    const after = await repo.get(t.tagId);
    expect(after.g0).toBe(0.4);
    expect(after.refreshCount).toBe(0);
  });

  it("names a missing tag by class rather than updating nothing quietly", async () => {
    await expect(repo.refresh(randomUUID(), 0.5)).rejects.toBeInstanceOf(TagNotFound);
  });

  // The reason refresh is one statement. Each of these runs on its own pooled
  // connection, so up to the pool's width of them are inside Postgres at
  // once. A read-modify-write would have two of them read the same
  // refresh_count and one write would vanish; the single statement locks the
  // row and re-evaluates on the current version, so every one of them lands.
  it("loses nothing when many refreshes run at once", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs2, channel: "volume", g0: 0.1 });
    const rounds = 40;
    const values = Array.from({ length: rounds }, (_, i) => ((i * 7919) % rounds) / rounds);
    await Promise.all(values.map((g0) => repo.refresh(t.tagId, g0)));
    const after = await repo.get(t.tagId);
    expect(after.refreshCount).toBe(rounds);
    expect(after.g0).toBe(Math.max(0.1, ...values));
  });
});

describe("strength", () => {
  // Acceptance criterion 2. Four instants, one of them before the tag
  // existed, read off one stored tag under a fixed clock, and the table's row
  // versions are the same afterwards: deriving strength wrote nothing.
  it("derives strength from a stored tag at an arbitrary instant with no write", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs3, channel: "volume", g0: 1 });
    const before = await rowVersions();
    const stored = await repo.get(t.tagId);
    const at = (iso: string) => strengthAt(stored, new Date(iso), 7 * DAY);
    expect(at("2026-09-01T00:00:00.000Z")).toBeCloseTo(1, 12);
    expect(at("2026-09-07T00:00:00.000Z")).toBeCloseTo(1, 12);
    expect(at("2026-09-14T00:00:00.000Z")).toBeCloseTo(0.5, 12);
    const day21 = at("2026-09-21T00:00:00.000Z");
    expect(day21).toBeGreaterThan(0);
    expect(day21).toBeLessThan(0.5);
    expect(await rowVersions()).toEqual(before);
  });

  it("reads a suppressed tag as weaker at the same instant, from the same row", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs3, channel: "volume", g0: 1 });
    const instant = new Date("2026-09-14T00:00:00.000Z");
    const plain = strengthAt(await repo.get(t.tagId), instant, 7 * DAY);
    await repo.suppress(t.tagId, 3);
    const suppressed = strengthAt(await repo.get(t.tagId), instant, 7 * DAY);
    expect(plain).toBeCloseTo(0.5, 12);
    expect(suppressed).toBeCloseTo(0.125, 12);
  });
});

describe("listLive", () => {
  // Its own clock, so advancing it to give the tags distinct instants does not
  // move the clock the tests above read.
  const listClock = fixedClock(new Date("2026-09-10T00:00:00.000Z"));
  let lister: TagRepository;
  let otherNs: string;
  let otherObs: string;
  beforeAll(async () => {
    lister = new TagRepository(db, listClock);
    otherObs = await appendUnder("OTHERADDRESS", "op:tag:other");
    otherNs = (await namespaces.find("wallet", "OTHERADDRESS"))!.namespaceId;
  });

  it("returns the namespace's tags newest first and nobody else's", async () => {
    const first = await lister.open({ namespaceId: otherNs, observationId: otherObs, channel: "volume", g0: 0.3 });
    listClock.advance(DAY);
    const second = await lister.open({ namespaceId: otherNs, observationId: otherObs, channel: "latency", g0: 0.6 });
    listClock.advance(DAY);
    const third = await lister.open({ namespaceId: otherNs, observationId: otherObs, channel: "volume", g0: 0.9 });
    const live = await lister.listLive(otherNs);
    expect(live.map((t) => t.tagId)).toEqual([third.tagId, second.tagId, first.tagId]);
    expect(live.every((t) => t.namespaceId === otherNs)).toBe(true);
  });

  it("bounds the listing to tags at or after an instant, which is what a trigger's window asks", async () => {
    const live = await lister.listLive(otherNs, new Date("2026-09-11T00:00:00.000Z"));
    expect(live.map((t) => t.taggedAt.toISOString())).toEqual([
      "2026-09-12T00:00:00.000Z", "2026-09-11T00:00:00.000Z",
    ]);
  });

  // A suppressed tag is still live. It decays faster and it is still there,
  // which is the whole distinction between suppression and deletion.
  it("still lists a suppressed tag", async () => {
    const [newest] = await lister.listLive(otherNs);
    await lister.suppress(newest!.tagId, 8);
    const live = await lister.listLive(otherNs);
    expect(live.find((t) => t.tagId === newest!.tagId)?.suppressionFactor).toBe(8);
    expect(live).toHaveLength(3);
  });

  it("is empty for a namespace with no tags, not an error", async () => {
    expect(await lister.listLive(randomUUID())).toEqual([]);
  });
});
