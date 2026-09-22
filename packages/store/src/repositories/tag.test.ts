import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { RETENTION_V0 } from "../retention.js";
import { ConstraintViolation, StoreError, TagAltered, TagNotFound, TagRefreshStale } from "../errors.js";
import { strengthAt } from "../strength.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";
import { TagRepository, type TagRefresh } from "./tag.js";

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
  namespaces = new NamespaceRepository(db, ring, clock, RETENTION_V0);
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
    // Two columns were argued in on purpose by the storage card. `aspect`
    // because M2 keys the live tag on (namespace, channel, aspect) and the
    // table held only the channel, so one asset's deviation refreshed
    // another's tag. `retired_at` because retirement is named in three
    // documents and existed nowhere, and the one-live-per-pair index is
    // partial on it. Still no strength-like column; that gate is separate
    // and above.
    expect(rows.rows.map((r) => r.column_name).sort()).toEqual([
      "aspect", "channel", "g0", "namespace_id", "observation_id",
      "refresh_count", "retired_at", "saturation_state", "suppression_factor",
      "tag_id", "tagged_at",
    ]);
  });

  // The same gate as the column list, applied to the code: the surface is
  // exactly the five methods the brief names. A name list of forbidden verbs
  // (delete, remove, drop) would let `retire`, `purge` or `expire` through,
  // and a static method or a second module-level export would not be on the
  // prototype at all. Types are erased, so the module's runtime keys are its
  // real surface.
  it("offers no way to delete a tag by identifier, because suppression is not deletion", async () => {
    expect(Object.getOwnPropertyNames(TagRepository.prototype).sort()).toEqual([
      "constructor", "findLive", "get", "listLive", "open", "refresh", "suppress",
    ]);
    expect(Object.getOwnPropertyNames(TagRepository).sort()).toEqual(["length", "name", "prototype"]);
    expect(Object.keys(await import("./tag.js")).sort()).toEqual(["TagRepository"]);
  });

  // The column gate above is about `tag`. This one is the cheap part of the
  // wider claim: no table in this schema carries a column whose name says it
  // caches a strength. It cannot catch a column of any name, which is why
  // the full claim is the nightly job's determinism test and not this; it
  // does catch a `tag_strength` cache table for nothing. The allowlist is for
  // a column that legitimately matches one day, and it is empty on purpose.
  it("has no strength-like column on any table in the schema, beyond an explicit allowlist", async () => {
    const allowed = new Set<string>([]);
    const rows = await sql<{ t: string; c: string }>`
      select table_name as t, column_name as c from information_schema.columns
      where table_schema = current_schema()
    `.execute(db);
    const offenders = rows.rows
      .map((r) => `${r.t}.${r.c}`)
      .filter((tc) => /strength|score|decayed|current_g|weight/i.test(tc.split(".")[1]!))
      .filter((tc) => !allowed.has(tc));
    expect(offenders, `a column outside tag looks like a stored strength: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  // The repository refuses NaN and Infinity before any statement, and the
  // database holds the same rule on its own, because a rule that lives only
  // in application code is one a backfill or a raw session can go around,
  // and one NaN row poisons every later refresh through greatest().
  it("refuses NaN and Infinity in g0 and the factor from a raw writer, by check constraint", async () => {
    const cases: Array<[string, string]> = [
      ["'NaN'::float8", "1"], ["'Infinity'::float8", "1"],
      ["1", "'NaN'::float8"], ["1", "'Infinity'::float8"],
    ];
    for (const [g0, factor] of cases) {
      await expect(
        sql`insert into tag (tag_id, namespace_id, observation_id, channel, aspect, g0, tagged_at, suppression_factor)
            values (${randomUUID()}, ${ns}, ${obs}, 'volume', ${`raw:${g0}:${factor}`}, ${sql.raw(g0)}, ${clock.now()}, ${sql.raw(factor)})`
          .execute(db),
      ).rejects.toMatchObject({ code: "23514" });
    }
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "p1", g0: 0.5, taggedAt: clock.now() });
    await expect(
      sql`update tag set g0 = 'NaN'::float8 where tag_id = ${t.tagId}`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await repo.get(t.tagId)).g0).toBe(0.5);
  });

  // A tag says "this observation, about this counterparty". Two independent
  // foreign keys would let it name a counterparty the observation is not
  // about, and listLive would then surface it under the wrong namespace,
  // which is the one query the nightly job runs. The pair is one key.
  // The aspect is the tag's key and an empty one is a tag on no aspect at
  // all, which would collide with every other empty one under the unique
  // index. The check has to be tested or it can be deleted without anything
  // going red.
  it("refuses an empty aspect from a raw writer, by name", async () => {
    await expect(
      sql`insert into tag (tag_id, namespace_id, observation_id, channel, aspect, g0, tagged_at)
          values (${randomUUID()}, ${ns}, ${obs}, 'volume', '', 0.5, ${clock.now()})`
        .execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "tag_aspect_nonempty" });
  });

  // The nonempty check and the not-null are two rules, and only the first was
  // held. `length(aspect) > 0` evaluates to NULL, not false, for a null
  // aspect, so a check constraint passes it -- and the partial unique index
  // treats NULLs as distinct, so a null aspect would also admit any number of
  // live tags on one (namespace, channel). This is the same null-versus-check
  // gap the producer column had one migration section down; review deleted
  // `alter column aspect set not null` and the whole suite stayed green.
  it("refuses a tag with no aspect at all, which the nonempty check alone admits", async () => {
    await expect(
      sql`insert into tag (tag_id, namespace_id, observation_id, channel, aspect, g0, tagged_at)
          values (${randomUUID()}, ${ns}, ${obs}, 'volume', null, 0.5, ${clock.now()})`
        .execute(db),
    ).rejects.toMatchObject({ code: "23502", column: "aspect" });
  });

  it("refuses a tag whose namespace is not the observation's, by foreign key", async () => {
    const stranger = (await namespaces.ensure({ kind: "wallet", id: "STRANGER" })).namespaceId;
    const opened = repo.open({ namespaceId: stranger, observationId: obs, channel: "volume", aspect: "p2", g0: 0.5, taggedAt: clock.now() });
    await expect(opened).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(opened).rejects.toMatchObject({ sqlstate: "23503", constraint: "tag_observation_in_namespace" });
    expect(await repo.listLive(stranger)).toEqual([]);
  });
});

describe("opening and reading", () => {
  it("round-trips a tag through get, with the defaults a fresh tag carries", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "p3", g0: 0.7, taggedAt: clock.now() });
    expect(t.tagId).toMatch(/^[0-9a-f-]{36}$/);
    const read = await repo.get(t.tagId);
    expect(read).toEqual({
      tagId: t.tagId, namespaceId: ns, observationId: obs, channel: "volume",
      aspect: "p3", g0: 0.7,
      taggedAt: new Date("2026-09-07T00:00:00.000Z"),
      refreshCount: 0, saturationState: "open", suppressionFactor: 1,
      retiredAt: null,
    });
  });

  // Inverted by the storage card, and this is the finding the card itself did
  // not have. M2's decide returns taggedAt from the EVENT's own instant, not
  // from any clock, and M1's own acceptance test insists the two differ: an
  // observation ingested a minute after it happened must not be dated at
  // ingest. Stamped from the clock, every event tag decays from the wrong
  // instant, and a backfill dates a whole history at the day it was loaded.
  it("stamps taggedAt from the decision, which for an event is earlier than the clock", async () => {
    const happened = new Date("2026-09-05T10:00:00.000Z");
    expect(happened.getTime()).toBeLessThan(clock.now().getTime());
    const t = await repo.open({
      namespaceId: ns, observationId: obs, channel: "latency", aspect: "p4",
      g0: 0.2, taggedAt: happened,
    });
    expect(t.taggedAt).toEqual(happened);
    expect((await repo.get(t.tagId)).taggedAt).toEqual(happened);
  });

  // M2 keys the live tag on (namespace, channel, aspect) and tagReading takes
  // one live tag or none for a pair. Held only in the arithmetic, that is a
  // promise; held here it is a constraint, and the difference shows the day a
  // second writer opens a tag on a pair that already has one. Without the
  // aspect the tag layer pools exactly what the aspect vocabulary exists to
  // keep apart: a deviation on one asset refreshes a tag another opened.
  it("holds one live tag per namespace, channel and aspect", async () => {
    await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "usdc:in", g0: 0.4, taggedAt: clock.now() });
    const second = repo.open({ namespaceId: ns, observationId: obs2, channel: "volume", aspect: "usdc:in", g0: 0.5, taggedAt: clock.now() });
    await expect(second).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(second).rejects.toMatchObject({ sqlstate: "23505", constraint: "tag_one_live_per_pair" });
  });

  // The same pair on a different aspect is a different tag, which is the
  // whole point of the column: two assets moving on one channel are two
  // histories, not one.
  it("opens a second tag on the same channel under a different aspect", async () => {
    await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "xlm:in", g0: 0.4, taggedAt: clock.now() });
    const other = await repo.open({ namespaceId: ns, observationId: obs2, channel: "volume", aspect: "xlm:out", g0: 0.5, taggedAt: clock.now() });
    expect(other.aspect).toBe("xlm:out");
  });

  // Retirement frees the pair. The operation itself is M4's; the column and
  // the fact that a retired tag stops being live are this card's.
  it("stops counting a retired tag as the live one, and lets the pair open again", async () => {
    const first = await repo.open({ namespaceId: ns, observationId: obs, channel: "content", aspect: "memo", g0: 0.3, taggedAt: clock.now() });
    await sql`update tag set retired_at = ${clock.now()} where tag_id = ${first.tagId}`.execute(db);
    const live = await repo.listLive(ns);
    expect(live.map((t) => t.tagId)).not.toContain(first.tagId);
    const again = await repo.open({ namespaceId: ns, observationId: obs2, channel: "content", aspect: "memo", g0: 0.6, taggedAt: clock.now() });
    expect(again.tagId).not.toBe(first.tagId);
  });

  // The guard. M1's rule is that an invariant is held by the database rather
  // than by a caller's good manners, and every rule below is one the
  // arithmetic computes and no raw writer may undo. The forward-only instant
  // matters most: strengthAt reads the decay curve from taggedAt, so a tag
  // moved backward is credited with a future it did not have.
  describe("the guard", () => {
    async function aTag(aspect: string) {
      return repo.open({ namespaceId: ns, observationId: obs, channel: "latency", aspect, g0: 0.5, taggedAt: clock.now() });
    }

    it("refuses a delete: retirement is a column, not a disappearance", async () => {
      const t = await aTag("g:delete");
      await expect(sql`delete from tag where tag_id = ${t.tagId}`.execute(db))
        .rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("never deleted") });
      expect((await repo.get(t.tagId)).tagId).toBe(t.tagId);
    });

    it("fixes the identity columns, so a tag never becomes a tag about something else", async () => {
      const t = await aTag("g:identity");
      for (const [column, value] of [
        ["tag_id", sql`${randomUUID()}`],
        ["namespace_id", sql`${randomUUID()}`],
        ["observation_id", sql`${obs2}`],
        ["channel", sql`'volume'`],
        ["aspect", sql`'g:moved'`],
      ] as const) {
        await expect(
          sql`update tag set ${sql.ref(column)} = ${value} where tag_id = ${t.tagId}`.execute(db),
          column,
        ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("identity is fixed") });
      }
    });

    it("refuses an instant that moves backward, and allows one that moves forward", async () => {
      const t = await aTag("g:instant");
      await expect(
        sql`update tag set tagged_at = ${new Date(t.taggedAt.getTime() - 1)} where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("only moves forward") });
      await sql`update tag set tagged_at = ${new Date(t.taggedAt.getTime() + DAY)},
                refresh_count = ${t.refreshCount + 1} where tag_id = ${t.tagId}`.execute(db);
      expect((await repo.get(t.tagId)).refreshCount).toBe(1);
    });

    // A refresh moves the count by one and a suppression does not move it at
    // all; nothing moves it by two. Without this a writer could refresh once
    // and claim a history of repeats, which is the saturation curve's input.
    it("lets the count stand or rise by one, and refuses a jump", async () => {
      const t = await aTag("g:count");
      await expect(
        sql`update tag set refresh_count = ${t.refreshCount + 2} where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("stands or rises by one") });
      await sql`update tag set suppression_factor = 2 where tag_id = ${t.tagId}`.execute(db);
      expect((await repo.get(t.tagId)).refreshCount).toBe(0);
    });

    it("refuses a saturated tag returning to open", async () => {
      const t = await aTag("g:saturation");
      await sql`update tag set saturation_state = 'saturated' where tag_id = ${t.tagId}`.execute(db);
      await expect(
        sql`update tag set saturation_state = 'open' where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("saturation is one-way") });
    });

    // Not in the plan's list, found by review: the repository's `suppress`
    // takes the greater of the two factors, and its own test says lowering
    // one "is a way to revive evidence that nothing in the design asks for".
    // Held only there, it was a promise a raw writer could break -- and the
    // house rule is that an invariant lives in the database.
    it("refuses a suppression factor that falls, because that revives evidence", async () => {
      const t = await aTag("g:suppression");
      await repo.suppress(t.tagId, 4);
      await expect(
        sql`update tag set suppression_factor = 1 where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("suppression only rises") });
      expect((await repo.get(t.tagId)).suppressionFactor).toBe(4);
    });

    // Also from review. Retirement takes a tag out of the live set, and a
    // refresh puts strength back into it; a refreshed retired tag is a row
    // whose strength moves while nothing can see it, and the pair it once
    // held has since been reopened by another tag.
    it("refuses a refresh of a retired tag", async () => {
      const t = await aTag("g:retired-refresh");
      await sql`update tag set retired_at = ${clock.now()} where tag_id = ${t.tagId}`.execute(db);
      await expect(
        sql`update tag set g0 = 0.9, refresh_count = 1,
            tagged_at = ${new Date(t.taggedAt.getTime() + DAY)} where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("not refreshed") });
    });

    // Found by review. The retired-tag rule reads old.retired_at, so a single
    // statement that retires and refreshes at once passes it: the row was
    // live when the statement began. The result is a retired row carrying a
    // strength no decision produced, which is the same defect from the other
    // direction.
    it("refuses retiring and refreshing in one statement", async () => {
      const t = await aTag("g:retire-and-refresh");
      await expect(
        sql`update tag set retired_at = ${clock.now()}, g0 = 0.99, refresh_count = 1,
            tagged_at = ${new Date(t.taggedAt.getTime() + 1)} where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("retires and refreshes") });
      expect((await repo.get(t.tagId)).g0).toBe(0.5);
    });

    it("refuses a retirement instant before the tag's own", async () => {
      const t = await aTag("g:retired-before");
      await expect(
        sql`update tag set retired_at = ${new Date(t.taggedAt.getTime() - 1)} where tag_id = ${t.tagId}`.execute(db),
      ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("not before tagged_at") });
    });

    it("holds retirement one-way: once set it neither moves nor clears", async () => {
      const t = await aTag("g:retire");
      const at = new Date(t.taggedAt.getTime() + DAY);
      await sql`update tag set retired_at = ${at} where tag_id = ${t.tagId}`.execute(db);
      for (const value of [sql`${new Date(at.getTime() + DAY)}`, sql`null`]) {
        await expect(
          sql`update tag set retired_at = ${value} where tag_id = ${t.tagId}`.execute(db),
        ).rejects.toMatchObject({ code: "NNT07", message: expect.stringContaining("retirement is one-way") });
      }
    });
  });

  it("names a missing tag by class, so a bad id is not mistaken for a bug", async () => {
    await expect(repo.get(randomUUID())).rejects.toBeInstanceOf(TagNotFound);
    await expect(repo.get(randomUUID())).rejects.toBeInstanceOf(StoreError);
  });

  it("refuses a tag on an observation that does not exist, on the foreign key", async () => {
    const opened = repo.open({ namespaceId: ns, observationId: randomUUID(), channel: "volume", aspect: "p5", g0: 0.5, taggedAt: clock.now() });
    await expect(opened).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(opened).rejects.toMatchObject({ sqlstate: "23503" });
  });

  // NaN and Infinity are accepted by a double precision column and NaN sorts
  // above every number in Postgres, so `check (g0 >= 0)` lets both through.
  // The refusal has to happen before the statement is sent.
  it("refuses a g0 that is negative or not a finite number, and writes nothing", async () => {
    const before = await rowVersions();
    for (const g0 of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "p6", g0, taggedAt: clock.now() }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(await rowVersions()).toEqual(before);
  });
});

describe("suppression", () => {
  it("suppresses by raising the factor and leaves the row in place", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "p7", g0: 1, taggedAt: clock.now() });
    await repo.suppress(t.tagId, 4);
    const after = await repo.get(t.tagId);
    expect(after.suppressionFactor).toBe(4);
    expect(after.g0).toBe(1);
  });

  // Suppression only ever accelerates. A later call with a smaller factor
  // would slow a tag's decay back down, which is a way to revive evidence
  // that nothing in the design asks for; the larger factor stands.
  it("does not lower a factor already raised", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "p8", g0: 1, taggedAt: clock.now() });
    await repo.suppress(t.tagId, 4);
    await repo.suppress(t.tagId, 2);
    expect((await repo.get(t.tagId)).suppressionFactor).toBe(4);
  });

  it("refuses a factor below one or not finite, because that would be deceleration", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs, channel: "volume", aspect: "p9", g0: 1, taggedAt: clock.now() });
    for (const factor of [0.5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repo.suppress(t.tagId, factor)).rejects.toBeInstanceOf(RangeError);
    }
    expect((await repo.get(t.tagId)).suppressionFactor).toBe(1);
  });

  it("names a missing tag by class rather than updating nothing quietly", async () => {
    await expect(repo.suppress(randomUUID(), 2)).rejects.toBeInstanceOf(TagNotFound);
  });
});

describe("findLive", () => {
  // M2's tagObservation takes the live tag on a pair or null, and until now
  // the only reader was listLive, so a caller would have had to pull every
  // live tag in the namespace and filter in memory -- and could not have told
  // two tags on one pair apart, because the pair was not a key.
  it("finds the live tag on a pair, and nothing for a pair with none", async () => {
    const t = await repo.open({
      namespaceId: ns, observationId: obs, channel: "price", aspect: "usd",
      g0: 0.5, taggedAt: clock.now(),
    });
    expect(await repo.findLive(ns, "price", "usd")).toMatchObject({ tagId: t.tagId });
    expect(await repo.findLive(ns, "price", "eur")).toBeNull();
    expect(await repo.findLive(ns, "volume", "usd")).toBeNull();
  });

  it("stops finding a tag once it is retired, which is what frees the pair", async () => {
    const t = await repo.open({
      namespaceId: ns, observationId: obs, channel: "price", aspect: "gbp",
      g0: 0.5, taggedAt: clock.now(),
    });
    await sql`update tag set retired_at = ${clock.now()} where tag_id = ${t.tagId}`.execute(db);
    expect(await repo.findLive(ns, "price", "gbp")).toBeNull();
  });
});

describe("refresh", () => {
  // Opened a day back so a refresh at the clock's own instant moves forward
  // without landing in the future, which is the shape of the real thing: the
  // tag was opened when the observation happened and the repeat is later.
  function aLive(aspect: string, g0 = 0.4) {
    return repo.open({
      namespaceId: ns, observationId: obs2, channel: "volume", aspect, g0,
      taggedAt: new Date(clock.now().getTime() - DAY),
    });
  }
  function next(t: { g0: number; taggedAt: Date; refreshCount: number }, over: Partial<TagRefresh> = {}): TagRefresh {
    return {
      g0: t.g0, taggedAt: clock.now(),
      refreshCount: t.refreshCount + 1, saturationState: "open", ...over,
    };
  }

  // The inversion the storage card exists for. M1 took the greater of the
  // stored g0 and the new one and added one to the count, which was the
  // store doing arithmetic. M2 does that arithmetic now -- over the DECAYED
  // strength, which the store cannot compute because it deliberately holds
  // no half-life -- and returns the four values. The store writes them as
  // handed, including a g0 that is lower than the one already there.
  it("writes the g0 the decision returns, even when it is lower than the stored one", async () => {
    const t = await aLive("r:lower", 0.9);
    await repo.refresh(t.tagId, next(t, { g0: 0.2 }));
    const after = await repo.get(t.tagId);
    expect(after.g0).toBe(0.2);
    expect(after.refreshCount).toBe(1);
  });

  it("writes the instant, the count and the saturation state the decision returns", async () => {
    const t = await aLive("r:fields");
    const at = clock.now();
    expect(at.getTime()).toBeGreaterThan(t.taggedAt.getTime());
    await repo.refresh(t.tagId, { g0: 0.8, taggedAt: at, refreshCount: 1, saturationState: "saturated" });
    expect(await repo.get(t.tagId)).toMatchObject({
      g0: 0.8, taggedAt: at, refreshCount: 1, saturationState: "saturated",
    });
  });

  it("refuses a g0 that is not a finite non-negative number, and leaves the tag as it was", async () => {
    const t = await aLive("r:g0");
    for (const g0 of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(repo.refresh(t.tagId, next(t, { g0 }))).rejects.toBeInstanceOf(RangeError);
    }
    expect(await repo.get(t.tagId)).toMatchObject({ g0: 0.4, refreshCount: 0 });
  });

  it("refuses an invalid instant and a count that is not a safe integer", async () => {
    const t = await aLive("r:args");
    await expect(repo.refresh(t.tagId, next(t, { taggedAt: new Date(Number.NaN) })))
      .rejects.toBeInstanceOf(RangeError);
    await expect(repo.refresh(t.tagId, next(t, { refreshCount: 1.5 })))
      .rejects.toBeInstanceOf(RangeError);
    expect(await repo.get(t.tagId)).toMatchObject({ refreshCount: 0 });
  });

  // The guard's refusals reach the caller through `refresh`, so they must
  // arrive as the class and not as a driver error. M3 retries on
  // TagRefreshStale and must not retry on a guard refusal; told apart only by
  // a SQLSTATE string, it would either retry forever or give up wrongly.
  it("raises a guard refusal as its class, not as a driver error", async () => {
    const t = await aLive("r:mapped");
    const back = repo.refresh(t.tagId, next(t, { taggedAt: new Date(t.taggedAt.getTime() - 1) }));
    // The class, and the message that names which rule. TagAltered is a
    // plain StoreError like NamespaceAltered beside it, so there is no
    // sqlstate to assert; the class is the contract and the message is the
    // rule.
    await expect(back).rejects.toBeInstanceOf(TagAltered);
    await expect(back).rejects.toThrowError(/only moves forward/);
  });

  // Not the clock's instant but the clock's bound. A tag stamped in the
  // future is full strength forever, because the decay curve reads any
  // instant before the tag as g0, and it cannot be retired either, since the
  // guard refuses a retirement before the tag's own instant. M2 never
  // produces one -- its decide clamps an event to the caller's `at` -- and
  // the database cannot hold the rule without reading a wall clock, which
  // every simulated day in this suite forbids. So it is refused here, where
  // the clock is injected. This is also what the repository's Clock is for
  // now that `open` no longer stamps from it.
  it("refuses a tag stamped after the clock, which would never decay", async () => {
    const ahead = new Date(clock.now().getTime() + DAY);
    await expect(repo.open({
      namespaceId: ns, observationId: obs, channel: "price", aspect: "future",
      g0: 0.5, taggedAt: ahead,
    })).rejects.toBeInstanceOf(RangeError);
    const t = await aLive("r:future");
    await expect(repo.refresh(t.tagId, next(t, { taggedAt: ahead }))).rejects.toBeInstanceOf(RangeError);
  });

  it("refuses a count below one, because a refresh is never the first write", async () => {
    const t = await aLive("r:floor");
    for (const refreshCount of [0, -1]) {
      await expect(repo.refresh(t.tagId, next(t, { refreshCount }))).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("names a missing tag by class rather than updating nothing quietly", async () => {
    const t = await aLive("r:missing");
    await expect(repo.refresh(randomUUID(), next(t))).rejects.toBeInstanceOf(TagNotFound);
  });

  // The reason refresh stopped being one merging statement. The merged value
  // depends on the decayed strength at the caller's instant, and the store
  // holds no half-life to compute it with, so two refreshes cannot be
  // combined here at all. The count the caller was handed is the version it
  // read: one lands, the rest are told their read is stale and the caller
  // re-reads and recomputes. Silently merging would write a strength that
  // no decision produced.
  it("lets exactly one of many concurrent refreshes land, and calls the rest stale", async () => {
    const t = await aLive("r:race", 0.1);
    const rounds = 40;
    const results = await Promise.allSettled(
      Array.from({ length: rounds }, (_, i) => repo.refresh(t.tagId, next(t, { g0: i / rounds }))),
    );
    const landed = results.filter((r) => r.status === "fulfilled");
    const stale = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof TagRefreshStale,
    );
    expect(landed).toHaveLength(1);
    expect(stale).toHaveLength(rounds - 1);
    expect((await repo.get(t.tagId)).refreshCount).toBe(1);
  });

  it("tells a stale refresh from a missing tag, because the cures differ", async () => {
    const t = await aLive("r:stale");
    await repo.refresh(t.tagId, next(t));
    await expect(repo.refresh(t.tagId, next(t))).rejects.toBeInstanceOf(TagRefreshStale);
  });
});

describe("strength", () => {
  // Acceptance criterion 2. Four instants, one of them before the tag
  // existed, read off one stored tag under a fixed clock, and the table's row
  // versions are the same afterwards: deriving strength wrote nothing.
  it("derives strength from a stored tag at an arbitrary instant with no write", async () => {
    const t = await repo.open({ namespaceId: ns, observationId: obs3, channel: "volume", aspect: "p13", g0: 1, taggedAt: clock.now() });
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
    const t = await repo.open({ namespaceId: ns, observationId: obs3, channel: "volume", aspect: "p14", g0: 1, taggedAt: clock.now() });
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
    const first = await lister.open({ namespaceId: otherNs, observationId: otherObs, channel: "volume", aspect: "p15", g0: 0.3, taggedAt: listClock.now() });
    listClock.advance(DAY);
    const second = await lister.open({ namespaceId: otherNs, observationId: otherObs, channel: "latency", aspect: "p16", g0: 0.6, taggedAt: listClock.now() });
    listClock.advance(DAY);
    const third = await lister.open({ namespaceId: otherNs, observationId: otherObs, channel: "volume", aspect: "p17", g0: 0.9, taggedAt: listClock.now() });
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
