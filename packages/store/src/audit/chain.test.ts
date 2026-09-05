import { createHmac, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv } from "../crypto.js";
import { fixedClock } from "../clock.js";
import {
  ChainBroken, DayNotClosed, NothingToSeal, SealMismatch, StoreError, mapPgError,
} from "../errors.js";
import {
  AUDIT_DAY_SEAL_LABEL, AuditChain, CHAIN_LOCK_KEY, canonicalForm, entrySha256, type VerifyResult,
} from "./chain.js";

const ONE_DAY_MS = 86_400_000;

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

  // jsonb keeps more numeric precision than a JavaScript double, so a rewrite
  // below that precision re-derives to the same canonical form and the check
  // above cannot see it. No JavaScript reader can either, but a SQL reader
  // can, and the fidelity claim is about the row, not about one reader of
  // it. The fourth check compares the body to the canonical form's body as
  // jsonb values, in SQL, and it is the one that names this row.
  it("localises a rewrite below double precision, which no JavaScript reader can see", async () => {
    const stored = await chain.append({
      policyVersion: "v0", kind: "precise", body: { x: 0.1, n: 9007199254740992 },
    });
    const result = await tampered(async (trx) => {
      await sql`update audit_entry
                set body = '{"x":0.10000000000000000001,"n":9007199254740993}'::jsonb
                where seq = ${stored.seq}`.execute(trx);
    });
    expect(result).toEqual({ ok: false, brokenAt: stored.seq, reason: "body" });
    await guardIsBack(stored.seq);
  });

  // The boundary itself, pinned as designed rather than inferred. A row
  // whose predecessor and hash are right but whose canonical form is not a
  // rendering of its own body passes the live trigger, because the database
  // holds linkage and hash integrity and nothing else; only the verifier
  // holds fidelity, and only it refuses the row.
  it("accepts, by design, a row the trigger cannot fault and the verifier alone rejects", async () => {
    const head = (await chain.head())!;
    const at = clock.now();
    const canonical = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "unfaithful", body: { i: 1 } });
    let result: VerifyResult | undefined;
    let planted: string | undefined;
    await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto("audit_entry").values({
        occurred_at: at, policy_version: "v0", kind: "unfaithful", body: '{"i":2}',
        canonical, prev_sha256: head.entrySha256, entry_sha256: entrySha256(head.entrySha256, canonical),
      }).returning(["seq"]).executeTakeFirstOrThrow();
      planted = row.seq;
      result = await new AuditChain(trx, clock, ring).verify();
      throw ROLLBACK;
    }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
    expect(planted).toMatch(/^\d+$/);
    expect(result).toEqual({ ok: false, brokenAt: planted, reason: "canonical" });
    expect(await chain.verify()).toEqual({ ok: true });
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

  // The clock stands at the opening instant of 2026-09-07. A seal fixes the
  // head as of a day's close, and a day that has not closed has no such
  // head yet: later entries of that day would contradict the seal, and once
  // the table refuses rewrites the seal could not be corrected.
  it("refuses to seal a day that has not closed, by class, and seals nothing", async () => {
    await expect(chain.sealDay("2026-09-07")).rejects.toBeInstanceOf(DayNotClosed);
    await expect(chain.sealDay("2026-09-08")).rejects.toBeInstanceOf(DayNotClosed);
    await expect(chain.sealDay("2026-09-07")).rejects.toBeInstanceOf(StoreError);
    expect(await db.selectFrom("audit_day").selectAll().execute()).toEqual([]);
    // 2026-09-09T00:00Z: the seventh and the eighth have closed.
    clock.advance(2 * ONE_DAY_MS);
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
    expect(row.sealed_at.toISOString()).toBe("2026-09-09T00:00:00.000Z");
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

  // A nightly job re-runs; that is the normal case, not an error. Over the
  // same head the second run finds its own seal and returns.
  it("returns quietly when re-run over the same head, and writes nothing", async () => {
    const before = await db.selectFrom("audit_day").selectAll().orderBy("day").execute();
    await chain.sealDay("2026-09-07");
    await chain.sealDay("2026-09-08");
    expect(await db.selectFrom("audit_day").selectAll().orderBy("day").execute()).toEqual(before);
  });

  it("refuses a day that is not one", async () => {
    await expect(chain.sealDay("2026-09-07T00:00:00Z")).rejects.toBeInstanceOf(RangeError);
    await expect(chain.sealDay("yesterday")).rejects.toBeInstanceOf(RangeError);
  });

  // Without the key a seal cannot be forged, but with UPDATE and DELETE open
  // the seals after a rewrite point could be removed and leave a gap. With
  // the trigger, removing a seal costs the same privilege as removing a row.
  it("refuses a rewrite or removal of a seal, by SQLSTATE", async () => {
    await expect(sql`update audit_day set hmac = decode(repeat('00',32),'hex')`.execute(db))
      .rejects.toMatchObject({ code: "NNT01" });
    await expect(sql`delete from audit_day`.execute(db)).rejects.toMatchObject({ code: "NNT01" });
    expect((await db.selectFrom("audit_day").selectAll().execute()).length).toBe(2);
  });

  // The seal states what the head was; verify states that the chain is
  // consistent. A seal over a broken chain does not hide the break, and a
  // refusal would remove the auditor's means of bounding when it happened,
  // since the last good seal is that evidence. The nightly job verifies
  // first; sealDay does not walk the table.
  it("seals over a broken chain rather than verify first, so the last good seal bounds the break", async () => {
    // 2026-09-10T00:00Z, so the ninth has closed and is unsealed.
    clock.advance(ONE_DAY_MS);
    const first = await db.selectFrom("audit_entry").select(["seq"]).orderBy("seq").executeTakeFirstOrThrow();
    let sealed: string | undefined;
    await db.transaction().execute(async (trx) => {
      await sql`alter table audit_entry disable trigger audit_entry_no_rewrite`.execute(trx);
      await sql`update audit_entry set body = '{"n":999}'::jsonb where seq = ${first.seq}`.execute(trx);
      const inside = new AuditChain(trx, clock, ring);
      expect((await inside.verify()).ok).toBe(false);
      await inside.sealDay("2026-09-09");
      sealed = (await trx.selectFrom("audit_day").select(sql<string>`day::text`.as("day"))
        .orderBy("day", "desc").executeTakeFirstOrThrow()).day;
      throw ROLLBACK;
    }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
    expect(sealed).toBe("2026-09-09");
    await guardIsBack(first.seq);
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

  // The sequence number is drawn by nextval before the trigger takes the
  // lock. A raw writer that drew N and then queued behind a transaction
  // already holding the lock, which draws N+1 and commits, must not be
  // allowed to follow the head N+1 already followed. A predecessor query
  // filtered to `seq < N` would let it, and two committed rows would claim
  // one head: a permanent linkage break at N+1 that looks like a tamper.
  it("refuses a writer that drew its sequence number before queueing, so two rows never share a head", async () => {
    await chain.append({ policyVersion: "v0", kind: "anchor", body: null });
    const at = clock.now();
    const forge = (head: Buffer, n: number) => {
      const canonical = canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "queued", body: { n } });
      return { n, canonical, hash: entrySha256(head, canonical) };
    };
    const insert = (trx: Db, prev: Buffer, e: ReturnType<typeof forge>) =>
      sql`insert into audit_entry
            (occurred_at, policy_version, kind, body, canonical, prev_sha256, entry_sha256)
          values (${at}, 'v0', 'queued', ${JSON.stringify({ n: e.n })}::jsonb, ${e.canonical}, ${prev}, ${e.hash})`
        .execute(trx);
    let queued: Promise<unknown> | undefined;
    let settled = false;
    let head: Buffer | undefined;
    await db.transaction().execute(async (holder) => {
      await sql`select pg_advisory_xact_lock(${sql.lit(CHAIN_LOCK_KEY)})`.execute(holder);
      head = (await new AuditChain(holder, clock, ring).head())!.entrySha256;
      // Draws its sequence number now, then blocks in its trigger.
      queued = insert(db, head, forge(head, 1));
      queued.catch(() => undefined).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled, "the queued writer got through while the lock was held").toBe(false);
      // Draws the next sequence number, follows the same head, commits.
      await insert(holder, head, forge(head, 2));
    });
    const outcome = await queued!.then(() => "accepted", (e: unknown) => e);
    const onHead = await db.selectFrom("audit_entry").select(["seq"])
      .where("prev_sha256", "=", head!).execute();
    expect(onHead.length, "two committed rows claim one head").toBe(1);
    expect(outcome).toMatchObject({ code: "NNT02" });
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

  // The bulk rows above carry the seventh's instant under higher sequence
  // numbers, so the head at that day's close is no longer the one sealed.
  // A re-run over a moved head is the signal the seal exists to give.
  it("refuses to re-seal a day whose head at close has moved, by class", async () => {
    await expect(chain.sealDay("2026-09-07")).rejects.toBeInstanceOf(SealMismatch);
    await expect(chain.sealDay("2026-09-07")).rejects.toBeInstanceOf(StoreError);
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

  // jsonb refuses both, later, as the driver's error out of `append`. The
  // refusal belongs here, where it is a RangeError this package owns.
  it("refuses a NUL or a lone surrogate in a body string or key", () => {
    const bodies: unknown[] = [
      { s: "a\u0000b" }, { "k\u0000": 1 }, { s: "\ud800" }, ["x\udc00"], { k: ["\ud83d"] },
    ];
    for (const body of bodies) {
      expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body })).toThrow(RangeError);
    }
    expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k\u0000", body: null }))
      .toThrow(RangeError);
    expect(() => canonicalForm({ occurredAt: at, policyVersion: "v0", kind: "k", body: { s: "🙂 paired" } }))
      .not.toThrow();
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
