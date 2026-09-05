import { createHmac, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { ChainBroken, NothingToSeal, StoreError, mapPgError } from "../errors.js";
import {
  AUDIT_DAY_SEAL_LABEL, AuditChain, canonicalForm, entrySha256, type VerifyResult,
} from "./chain.js";

let db: Db;
let done: () => Promise<void>;
let chain: AuditChain;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
const clock = fixedClock(new Date("2026-09-07T00:00:00.000Z"));

beforeAll(async () => {
  ({ db, done } = await withSchema("audit_test"));
  chain = new AuditChain(db, clock, ring);
});
afterAll(async () => { await done(); });

// Plants damage with the append-only trigger off, verifies while the damage
// is visible, and rolls the whole thing back. The trigger comes back with the
// rollback, and each caller proves that it did: the guard is never left off,
// and the table the later tests see is the one the earlier tests built.
const ROLLBACK = Symbol("rollback");
async function tampered(plant: (trx: Db) => Promise<void>): Promise<VerifyResult> {
  let result: VerifyResult | undefined;
  await db
    .transaction()
    .execute(async (trx) => {
      await sql`alter table audit_entry disable trigger audit_entry_no_rewrite`.execute(trx);
      await plant(trx);
      result = await new AuditChain(trx, clock, ring).verify();
      throw ROLLBACK;
    })
    .catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
  if (!result) throw new Error("the tampering transaction produced no verdict");
  return result;
}

async function guardIsBack(seq: string): Promise<void> {
  await expect(sql`update audit_entry set kind = 'x' where seq = ${seq}`.execute(db))
    .rejects.toMatchObject({ code: "NNT01" });
  expect(await chain.verify()).toEqual({ ok: true });
}

describe("the chain", () => {
  // Runs first, before anything is appended. An empty chain is intact: there
  // is nothing in it to be wrong, and a fresh deployment must pass its first
  // audit rather than fail it for having no history yet.
  it("verifies an empty table as intact, with no head", async () => {
    expect(await chain.verify()).toEqual({ ok: true });
    expect(await chain.head()).toBeNull();
  });

  it("links each entry to the one before it", async () => {
    const a = await chain.append({ policyVersion: "v0", kind: "tag_opened", body: { n: 1 } });
    const b = await chain.append({ policyVersion: "v0", kind: "tag_opened", body: { n: 2 } });
    expect(b.prevSha256.equals(a.entrySha256)).toBe(true);
  });

  it("starts from a fixed genesis rather than from nothing", async () => {
    const first = await db.selectFrom("audit_entry").selectAll().orderBy("seq")
      .executeTakeFirstOrThrow();
    expect(first.prev_sha256.equals(Buffer.alloc(32))).toBe(true);
  });

  it("reports what was stored, and the hash it reports is the hash of what it reports", async () => {
    const before = await chain.head();
    const stored = await chain.append({ policyVersion: "v1", kind: "decided", body: { why: "because" } });
    expect(stored.seq).toMatch(/^\d+$/);
    expect(stored.occurredAt.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(stored.policyVersion).toBe("v1");
    expect(stored.kind).toBe("decided");
    expect(stored.body).toEqual({ why: "because" });
    expect(stored.canonical).toBe(canonicalForm({
      occurredAt: stored.occurredAt, policyVersion: "v1", kind: "decided", body: { why: "because" },
    }));
    expect(stored.prevSha256.equals(before!.entrySha256)).toBe(true);
    expect(stored.entrySha256.equals(entrySha256(stored.prevSha256, stored.canonical))).toBe(true);
    expect((await chain.head())!.seq).toBe(stored.seq);
  });

  it("verifies a run end to end", async () => {
    for (let i = 0; i < 20; i++) {
      await chain.append({ policyVersion: "v0", kind: "nightly", body: { i } });
    }
    expect(await chain.verify()).toEqual({ ok: true });
  });

  // The verifier's half rests on this: what append hashed must be what verify
  // re-derives from the jsonb column after Postgres has parsed, stored and
  // rendered it. Every shape jsonb normalises is in here.
  it("re-derives the canonical form from the stored row, whatever the body held", async () => {
    const body = {
      z: { nested: { deep: [1, "two", null, true, false, { k: "v" }] } },
      a: "unicode é 中 🙂",
      control: "line\nbreak\ttab \"quote\" back\\slash",
      numbers: [0.1, 1e21, -0, 2 ** 53, -1.5e-7, 42],
      empty: {},
      none: [],
      nil: null,
      when: new Date("2026-09-06T12:34:56.789Z"),
    };
    const stored = await chain.append({ policyVersion: "v0", kind: "shapes", body });
    const row = await db.selectFrom("audit_entry").selectAll()
      .where("seq", "=", stored.seq).executeTakeFirstOrThrow();
    expect(canonicalForm({
      occurredAt: row.occurred_at, policyVersion: row.policy_version, kind: row.kind, body: row.body,
    })).toBe(row.canonical);
    expect(await chain.verify()).toEqual({ ok: true });
  });

  it("refuses an entry that does not follow the head, by SQLSTATE", async () => {
    await expect(
      sql`insert into audit_entry
            (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
          values (now(), 'v0', 'forged', '{}'::jsonb, 'x',
                  decode(repeat('11',32),'hex'), decode(repeat('22',32),'hex'))`.execute(db),
    ).rejects.toMatchObject({ code: "NNT02" });
  });

  it("refuses an entry whose hash does not match its canonical form", async () => {
    const head = await chain.head();
    await expect(
      sql`insert into audit_entry
            (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
          values (now(), 'v0', 'forged', '{}'::jsonb, 'x',
                  ${head!.entrySha256}, decode(repeat('22',32),'hex'))`.execute(db),
    ).rejects.toMatchObject({ code: "NNT03" });
  });

  // The two SQLSTATEs are one class to a caller: a chain that cannot be
  // appended to is broken, whichever check said so.
  it("maps both refusals to ChainBroken, with the driver error as cause", async () => {
    const head = await chain.head();
    const probe = sql`insert into audit_entry
          (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
        values (now(), 'v0', 'forged', '{}'::jsonb, 'x',
                ${head!.entrySha256}, decode(repeat('22',32),'hex'))`.execute(db);
    const raw = await probe.then(() => undefined, (e: unknown) => e);
    const mapped = mapPgError(raw);
    expect(mapped).toBeInstanceOf(ChainBroken);
    expect(mapped).toBeInstanceOf(StoreError);
    expect(mapped?.cause).toBe(raw);
  });

  it("refuses an instant with microseconds, which the verifier could never re-render", async () => {
    const head = await chain.head();
    await expect(
      sql`insert into audit_entry
            (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
          values ('2026-09-07T00:00:00.000123Z', 'v0', 'forged', '{}'::jsonb, 'x',
                  ${head!.entrySha256}, sha256(${head!.entrySha256} || convert_to('x', 'UTF8')))`
        .execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "audit_entry_occurred_at_millis" });
  });

  it("refuses a rewrite of a stored entry", async () => {
    await expect(sql`update audit_entry set kind = 'x' where seq = 1`.execute(db))
      .rejects.toMatchObject({ code: "NNT01" });
  });

  it("refuses a delete of a stored entry", async () => {
    await expect(sql`delete from audit_entry where seq = 1`.execute(db))
      .rejects.toMatchObject({ code: "NNT01" });
    const row = await db.selectFrom("audit_entry").select(["seq"]).where("seq", "=", "1").executeTakeFirst();
    expect(row?.seq).toBe("1");
  });

  it("exposes no update or delete on the chain's surface at all", () => {
    const surface = Object.getOwnPropertyNames(AuditChain.prototype);
    expect(surface.filter((m) => /update|delete|remove/i.test(m))).toEqual([]);
  });

  // The database holds linkage and hash integrity. That `canonical` is a
  // faithful rendering of the row's own fields is held by the verifier, and
  // this is the test for that half of the boundary: the hashes still agree,
  // the trigger would have passed this row, and only the re-derivation says
  // the body is not the one that was hashed.
  it("localises a tampered body to its sequence number", async () => {
    await chain.append({ policyVersion: "v0", kind: "nightly", body: { i: 99 } });
    await chain.append({ policyVersion: "v0", kind: "nightly", body: { i: 100 } });
    const rows = await db.selectFrom("audit_entry").select(["seq"]).orderBy("seq", "desc").limit(2).execute();
    const target = rows[1]!;
    const result = await tampered(async (trx) => {
      await sql`update audit_entry set body = '{"i":100}'::jsonb where seq = ${target.seq}`.execute(trx);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(String(target.seq));
      expect(result.reason).toBe("canonical");
    }
    await guardIsBack(target.seq);
    const row = await db.selectFrom("audit_entry").select(["body"]).where("seq", "=", target.seq)
      .executeTakeFirstOrThrow();
    expect(row.body).toEqual({ i: 99 });
  });

  it("localises a rewritten canonical form to its sequence number, as a hash break", async () => {
    const rows = await db.selectFrom("audit_entry").select(["seq"]).orderBy("seq", "desc").limit(3).execute();
    const target = rows[2]!;
    const result = await tampered(async (trx) => {
      await sql`update audit_entry set canonical = canonical || ' ' where seq = ${target.seq}`.execute(trx);
    });
    expect(result).toEqual({ ok: false, brokenAt: target.seq, reason: "entry_hash" });
    await guardIsBack(target.seq);
  });

  it("localises a broken link to the entry that does not follow its predecessor", async () => {
    const rows = await db.selectFrom("audit_entry").select(["seq"]).orderBy("seq", "desc").limit(3).execute();
    const target = rows[2]!;
    const result = await tampered(async (trx) => {
      await sql`update audit_entry set prev_sha256 = decode(repeat('11',32),'hex') where seq = ${target.seq}`
        .execute(trx);
    });
    expect(result).toEqual({ ok: false, brokenAt: target.seq, reason: "linkage" });
    await guardIsBack(target.seq);
  });

  it("localises a deleted entry to the one after it, whose predecessor is gone", async () => {
    const rows = await db.selectFrom("audit_entry").select(["seq"]).orderBy("seq", "desc").limit(3).execute();
    const gone = rows[2]!;
    const next = rows[1]!;
    const result = await tampered(async (trx) => {
      await sql`delete from audit_entry where seq = ${gone.seq}`.execute(trx);
    });
    expect(result).toEqual({ ok: false, brokenAt: next.seq, reason: "linkage" });
    await guardIsBack(gone.seq);
  });

  it("names the first entry when it does not start from the genesis", async () => {
    const first = await db.selectFrom("audit_entry").select(["seq"]).orderBy("seq").executeTakeFirstOrThrow();
    const result = await tampered(async (trx) => {
      await sql`update audit_entry set prev_sha256 = decode(repeat('11',32),'hex') where seq = ${first.seq}`
        .execute(trx);
    });
    expect(result).toEqual({ ok: false, brokenAt: first.seq, reason: "linkage" });
    await guardIsBack(first.seq);
  });

  it("seals a day over its terminal hash", async () => {
    await chain.sealDay("2026-09-07");
    const row = await db.selectFrom("audit_day").selectAll().executeTakeFirstOrThrow();
    expect(row.hmac.length).toBe(32);
    expect(row.terminal_sha256.length).toBe(32);
  });

  it("seals the chain head as of the day's close, under the key the label derives", async () => {
    const head = (await chain.head())!;
    const row = await db.selectFrom("audit_day")
      .select(["terminal_seq", "terminal_sha256", "hmac", "sealed_at", sql<string>`day::text`.as("day")])
      .executeTakeFirstOrThrow();
    expect(row.day).toBe("2026-09-07");
    expect(row.terminal_seq).toBe(head.seq);
    expect(row.terminal_sha256.equals(head.entrySha256)).toBe(true);
    expect(row.sealed_at.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    const expected = createHmac("sha256", ring.deriveKey(AUDIT_DAY_SEAL_LABEL))
      .update(Buffer.concat([Buffer.from("2026-09-07", "utf8"), head.entrySha256]))
      .digest();
    expect(row.hmac.equals(expected)).toBe(true);
    // The seal is over the day as well as the hash: the same head sealed
    // under another day is a different seal, so a seal row cannot be moved.
    const otherDay = createHmac("sha256", ring.deriveKey(AUDIT_DAY_SEAL_LABEL))
      .update(Buffer.concat([Buffer.from("2026-09-08", "utf8"), head.entrySha256]))
      .digest();
    expect(row.hmac.equals(otherDay)).toBe(false);
  });

  it("seals a day on which nothing occurred over the head it inherited", async () => {
    const head = (await chain.head())!;
    await chain.sealDay("2026-09-08");
    const row = await db.selectFrom("audit_day").select(["terminal_seq"])
      .where(sql`day::text`, "=", "2026-09-08").executeTakeFirstOrThrow();
    expect(row.terminal_seq).toBe(head.seq);
  });

  it("refuses to seal a day before anything had occurred, by class", async () => {
    await expect(chain.sealDay("2026-09-06")).rejects.toBeInstanceOf(NothingToSeal);
    await expect(chain.sealDay("2026-09-06")).rejects.toBeInstanceOf(StoreError);
  });

  it("refuses a second seal of the same day, and a day that is not one", async () => {
    await expect(chain.sealDay("2026-09-07")).rejects.toMatchObject({ code: "23505" });
    await expect(chain.sealDay("2026-09-07T00:00:00Z")).rejects.toBeInstanceOf(RangeError);
    await expect(chain.sealDay("yesterday")).rejects.toBeInstanceOf(RangeError);
  });
});

describe("the lock", () => {
  // Would fail three ways if the span were wrong. With no lock, or one
  // released when the trigger returns, the second writer's trigger reads the
  // head while the first row is still uncommitted, sees the same predecessor,
  // and passes: `settled` is true inside the window and the chain forks. With
  // a session lock never released, the second writer waits for a connection
  // that is not closing, and the test times out.
  it("holds a second writer until the first commits, then refuses it as not following the head", async () => {
    // Its own anchor, so the test stands on its own when run alone.
    const head = await chain.append({ policyVersion: "v0", kind: "anchor", body: null });
    const at = clock.now();
    const forged = (n: number) => {
      const canonical = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "race", body: { n } });
      return { n, canonical, hash: entrySha256(head.entrySha256, canonical) };
    };
    const insert = (trx: Db, e: ReturnType<typeof forged>) =>
      sql`insert into audit_entry
            (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
          values (${at}, 'v0', 'race', ${JSON.stringify({ n: e.n })}::jsonb, ${e.canonical},
                  ${head.entrySha256}, ${e.hash})`.execute(trx);
    const winner = forged(1);
    let second: Promise<unknown> | undefined;
    let settled = false;
    await db.transaction().execute(async (first) => {
      await insert(first, winner);
      second = db.transaction().execute((trx) => insert(trx, forged(2)));
      second.catch(() => undefined).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled, "the second writer got through while the first was uncommitted").toBe(false);
    });
    await expect(second).rejects.toMatchObject({ code: "NNT02" });
    expect((await chain.head())!.entrySha256.equals(winner.hash)).toBe(true);
    expect(await chain.verify()).toEqual({ ok: true });
  });

  // The application takes the same lock before it reads the head, so writers
  // that go through `append` queue instead of losing. Without that, the
  // trigger would still keep the chain straight, but some of these would
  // come back ChainBroken for no fault of their own.
  it("serialises concurrent appends so every one of them lands", async () => {
    const other = new AuditChain(db, clock, ring);
    const stored = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? chain : other).append({ policyVersion: "v0", kind: "parallel", body: { i } }),
      ),
    );
    expect(new Set(stored.map((s) => s.seq)).size).toBe(8);
    expect(await chain.verify()).toEqual({ ok: true });
  });
});

describe("verify at scale", () => {
  // More rows than one page, written by SQL alone with the canonical form
  // spelled out by hand, so the walk crosses a page boundary and every row
  // on both sides of it was hashed by Postgres and is re-derived by Node.
  // A page size the test cannot see is a branch it cannot reach otherwise.
  it("walks past the first page, and still localises a break beyond it", async () => {
    const before = (await chain.head())!;
    await sql`
      do $$
      declare prev bytea; c text; h bytea; i int;
      begin
        select entry_sha256 into prev from audit_entry order by seq desc limit 1;
        for i in 1..1200 loop
          c := 'nnt-audit/1' || E'\n' || '2026-09-07T00:00:00.000Z' || E'\n' || 'v0' || E'\n' || 'bulk'
               || E'\n' || '{"i":' || i || '}';
          h := sha256(prev || convert_to(c, 'UTF8'));
          insert into audit_entry (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
          values ('2026-09-07T00:00:00.000Z', 'v0', 'bulk', ('{"i":' || i || '}')::jsonb, c, prev, h);
          prev := h;
        end loop;
      end $$
    `.execute(db);
    const after = (await chain.head())!;
    expect(Number(after.seq) - Number(before.seq)).toBe(1200);
    expect(await chain.verify()).toEqual({ ok: true });
    const deep = String(Number(before.seq) + 1100);
    const result = await tampered(async (trx) => {
      await sql`update audit_entry set body = '{"i":0}'::jsonb where seq = ${deep}`.execute(trx);
    });
    expect(result).toEqual({ ok: false, brokenAt: deep, reason: "canonical" });
    await guardIsBack(deep);
  });
});

describe("canonicalForm", () => {
  const at = new Date("2026-09-07T00:00:00.000Z");

  it("is stable across key insertion order, so two equal bodies hash the same", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { a: 1, b: 2 } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("sorts nested keys too", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { x: { p: 1, q: 2 } } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { x: { q: 2, p: 1 } } });
    expect(a).toBe(b);
  });

  it("distinguishes two entries that differ only in a nested value", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { x: { y: 1 } } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { x: { y: 2 } } });
    expect(a).not.toBe(b);
  });

  it("keeps array order, which is meaningful", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { xs: [1, 2] } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { xs: [2, 1] } });
    expect(a).not.toBe(b);
  });

  it("renders the instant one way, as UTC with milliseconds", () => {
    const local = new Date(at.getTime());
    expect(canonicalForm({ occurredAt: local, policyVersion: "v0", kind: "k", body: null }))
      .toContain("2026-09-07T00:00:00.000Z");
  });

  // Five parts on four separators. A newline inside a body string is escaped
  // by the JSON rendering, so the count is exact, and no body can shift a
  // part boundary.
  it("joins on a separator no part can contain, so a body cannot masquerade as another field", () => {
    const c = canonicalForm({
      occurredAt: at, policyVersion: "v0", kind: "k", body: { s: "a\nb\nc", t: ["\n"] },
    });
    expect(c.split("\n").length).toBe(5);
  });

  it("refuses the separator inside kind or policyVersion rather than let it re-partition the parts", () => {
    expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k\nx", body: null }))
      .toThrow(RangeError);
    expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0\nv1", kind: "k", body: null }))
      .toThrow(RangeError);
  });

  it("refuses an instant that is not one", () => {
    expect(() => canonicalForm({ occurredAt: new Date(NaN), policyVersion: "v0", kind: "k", body: null }))
      .toThrow(RangeError);
  });

  // JSON has no undefined, and jsonb will hold none, so the form follows
  // JSON.stringify: an undefined-valued key is absent and an undefined element
  // is null. The row's stored body then re-derives to the same form, which is
  // what the verifier needs. A body that is undefined altogether is refused;
  // there is nothing to store.
  it("treats undefined as JSON does, and refuses a body that is undefined", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { a: undefined, b: 1 } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { b: 1 } });
    expect(a).toBe(b);
    const c = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: [undefined] });
    const d = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: [null] });
    expect(c).toBe(d);
    expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: undefined }))
      .toThrow(RangeError);
  });

  // JSON.stringify would write null for these, and a decision whose number
  // was NaN would be stored as a decision about nothing, indistinguishable
  // from one that said null on purpose. The writer should learn now.
  it("refuses a number that is not finite, anywhere in the body", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { deep: [{ n: bad }] } }))
        .toThrow(RangeError);
    }
  });

  it("renders negative zero as zero, as JSON and jsonb both do", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { n: -0 } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { n: 0 } });
    expect(a).toBe(b);
  });

  it("honours toJSON, so a Date in a body is the string jsonb will hold", () => {
    const when = new Date("2026-09-06T12:34:56.789Z");
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { when } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { when: when.toISOString() } });
    expect(a).toBe(b);
  });

  it("distinguishes a nested null from an absent key", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { x: null } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: {} });
    expect(a).not.toBe(b);
  });

  it("distinguishes a string from the number it spells", () => {
    const a = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { n: "1" } });
    const b = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { n: 1 } });
    expect(a).not.toBe(b);
  });
});
