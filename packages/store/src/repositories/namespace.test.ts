import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { namespaceRefSchema } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv, newDataKey } from "../crypto.js";
import { fixedClock } from "../clock.js";
import {
  CiphertextRejected, NamespaceAltered, NamespaceNotFound, NamespaceShredded, StoreError, mapPgError,
} from "../errors.js";
import { NamespaceRepository } from "./namespace.js";

let db: Db;
let done: () => Promise<void>;
let repo: NamespaceRepository;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
const clock = fixedClock(new Date("2026-09-07T00:00:00.000Z"));

beforeAll(async () => {
  ({ db, done } = await withSchema("ns_test"));
  repo = new NamespaceRepository(db, ring, clock);
});
afterAll(async () => { await done(); });

describe("identity is byte-exact", () => {
  // This is M0's first carried note, recorded as load-bearing. If the storage
  // layer ever compares identifiers more loosely, two distinct keys land in
  // one logical namespace and the evidence is double-counted.
  it("keeps two identifiers that differ only in case apart", async () => {
    const upper = await repo.ensure({ kind: "wallet", id: "GOLDADDRESS" });
    const lower = await repo.ensure({ kind: "wallet", id: "goldaddress" });
    expect(upper.namespaceId).not.toBe(lower.namespaceId);
    expect((await repo.find("wallet", "GOLDADDRESS"))?.namespaceId).toBe(upper.namespaceId);
    expect((await repo.find("wallet", "goldaddress"))?.namespaceId).toBe(lower.namespaceId);
  });

  it("keeps a trailing space apart, so no column is trimmed", async () => {
    const bare = await repo.ensure({ kind: "wallet", id: "SPACED" });
    const spaced = await repo.ensure({ kind: "wallet", id: "SPACED " });
    expect(bare.namespaceId).not.toBe(spaced.namespaceId);
  });

  it("treats the same identifier under two kinds as two namespaces", async () => {
    const w = await repo.ensure({ kind: "wallet", id: "SHARED" });
    const d = await repo.ensure({ kind: "domain", id: "SHARED" });
    expect(w.namespaceId).not.toBe(d.namespaceId);
  });

  // The kind vocabulary lives in the schema's enum and again in the
  // migration's check constraint. A kind added to the enum alone would fail
  // in production at the first ensure of that kind while this suite stayed
  // green; ensuring one namespace per enum member makes it fail here.
  it("accepts every kind the schema's enum admits", async () => {
    const kinds = namespaceRefSchema.innerType().shape.kind.options;
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const n = await repo.ensure({ kind, id: `KIND-${kind}` });
      expect(n.kind).toBe(kind);
    }
  });

  it("returns the same row for a repeated ensure", async () => {
    const a = await repo.ensure({ kind: "endpoint", id: "https://data.example/x402" });
    const b = await repo.ensure({ kind: "endpoint", id: "https://data.example/x402" });
    expect(a.namespaceId).toBe(b.namespaceId);
  });
});

describe("keys and shredding", () => {
  it("gives each namespace its own data key", async () => {
    const a = await repo.ensure({ kind: "wallet", id: "KEYA" });
    const b = await repo.ensure({ kind: "wallet", id: "KEYB" });
    const ka = await repo.dataKey(a.namespaceId);
    const kb = await repo.dataKey(b.namespaceId);
    expect(ka.equals(kb)).toBe(false);
  });

  it("returns the same key on every read, so a stored payload stays readable", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "STABLE" });
    const first = await repo.dataKey(n.namespaceId);
    const second = await repo.dataKey(n.namespaceId);
    expect(first.equals(second)).toBe(true);
  });

  // The wrap's associated data is the UTF-8 of the identifier string, so the
  // spelling handed to `wrap` at insert and the spelling the database hands
  // back for `unwrap` must be the same bytes. Both are lowercase canonical
  // today, one from Node and one from Postgres, but nothing else states that
  // they agree, and if they ever stopped agreeing every unwrap would fail with
  // an authentication error that says nothing about uuid spelling. This test
  // names the cause: it wraps under the id Node generated, stores it, and
  // reads the id back through the driver.
  it("stores the identifier in the spelling the wrap was bound to", async () => {
    const generated = randomUUID();
    const dataKey = newDataKey();
    await db.insertInto("namespace").values({
      namespace_id: generated,
      kind: "wallet",
      ns_id: "SPELLING",
      data_key_wrapped: ring.wrap(dataKey, generated),
      key_shredded_at: null,
      created_at: clock.now(),
    }).execute();
    const stored = await repo.find("wallet", "SPELLING");
    expect(stored?.namespaceId).toBe(generated);
    expect((await repo.dataKey(generated)).equals(dataKey)).toBe(true);
  });

  // The uuid column matches the row under any spelling of the same value,
  // while the wrap's associated data is the bytes of one spelling. `dataKey`
  // unwraps under the spelling the database reports, so a caller's spelling
  // only has to locate the row.
  it("opens under the spelling the database reports, whatever the caller's", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "CASEDCALLER" });
    const canonical = await repo.dataKey(n.namespaceId);
    const shouted = await repo.dataKey(n.namespaceId.toUpperCase());
    expect(shouted.equals(canonical)).toBe(true);
  });

  it("names a namespace that does not exist, by class", async () => {
    await expect(repo.dataKey(randomUUID())).rejects.toBeInstanceOf(NamespaceNotFound);
  });

  // The header alone, with no key inside it, is what the key ring produces
  // for an empty data key. It is also the exact boundary the migration's
  // octet_length check names, so this pins the SQL literal to crypto.ts.
  it("refuses a stored wrapped key that holds no key", async () => {
    const id = randomUUID();
    const headerOnly = ring.wrap(Buffer.alloc(0), id);
    const insert = db.insertInto("namespace").values({
      namespace_id: id,
      kind: "wallet",
      ns_id: "EMPTYKEY",
      data_key_wrapped: headerOnly,
      key_shredded_at: null,
      created_at: clock.now(),
    }).execute();
    await expect(insert).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_present" });
  });

  it("makes the key unrecoverable once shredded, and says so by class", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "SHREDME" });
    await repo.shred(n.namespaceId);
    await expect(repo.dataKey(n.namespaceId)).rejects.toBeInstanceOf(NamespaceShredded);
  });

  it("keeps the identity row after shredding, so counts and the chain survive", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "SHREDKEEP" });
    await repo.shred(n.namespaceId);
    const found = await repo.find("wallet", "SHREDKEEP");
    expect(found?.namespaceId).toBe(n.namespaceId);
    expect(found?.shreddedAt).not.toBeNull();
  });

  it("is idempotent, so a repeated erasure request is not an error", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "SHREDTWICE" });
    await repo.shred(n.namespaceId);
    await expect(repo.shred(n.namespaceId)).resolves.toBeUndefined();
  });

  // The first erasure's timestamp is the compliance record. The clock has to
  // move between the two requests, or a second shred that rewrote the
  // timestamp would be invisible under a fixed clock.
  it("keeps the first erasure's timestamp across a repeat", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "SHREDFIRST" });
    await repo.shred(n.namespaceId);
    const first = (await repo.find("wallet", "SHREDFIRST"))?.shreddedAt;
    expect(first).not.toBeNull();
    clock.advance(60_000);
    await repo.shred(n.namespaceId);
    const after = (await repo.find("wallet", "SHREDFIRST"))?.shreddedAt;
    expect(after?.getTime()).toBe(first?.getTime());
  });

  // Success here would tell an operator the data is gone when no row was
  // examined, on the one privacy-critical path this design has.
  it("refuses to shred an identifier that has no row, by class", async () => {
    await expect(repo.shred(randomUUID())).rejects.toBeInstanceOf(NamespaceNotFound);
  });

  // The wrap is bound to the namespace id, so a wrapped key copied into
  // another namespace's row does not unwrap there. Without that binding, a
  // copy taken before a shred outlives the shred and the erasure is undone.
  it("refuses a wrapped key that was moved to another namespace's row", async () => {
    const a = await repo.ensure({ kind: "wallet", id: "WRAPA" });
    const b = await repo.ensure({ kind: "wallet", id: "WRAPB" });
    const rowA = await db.selectFrom("namespace").select(["data_key_wrapped"])
      .where("namespace_id", "=", a.namespaceId).executeTakeFirstOrThrow();
    await db.updateTable("namespace").set({ data_key_wrapped: rowA.data_key_wrapped })
      .where("namespace_id", "=", b.namespaceId).execute();
    // The refusal must come from the unwrap, and that is the class the
    // unwrap raises; NamespaceNotFound or NamespaceShredded here would mean
    // the row was missing or shredded, which it is not.
    await expect(repo.dataKey(b.namespaceId)).rejects.toBeInstanceOf(CiphertextRejected);
    expect((await repo.find("wallet", "WRAPB"))?.shreddedAt).toBeNull();
  });

  // The one that matters most: an `ensure` written as a blind upsert would
  // quietly mint a new key for a shredded namespace and undo the erasure.
  it("does not resurrect a key when ensure is called again after shredding", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "NORESURRECT" });
    await repo.shred(n.namespaceId);
    await repo.ensure({ kind: "wallet", id: "NORESURRECT" });
    expect((await repo.find("wallet", "NORESURRECT"))?.shreddedAt).not.toBeNull();
    await expect(repo.dataKey(n.namespaceId)).rejects.toBeInstanceOf(NamespaceShredded);
  });
});

// The identity row is the one row every other table hangs from, and until
// this trigger it was the one table with no guard of its own. Observation
// rows are append-only, but the row they hang from was not: one UPDATE of
// kind and ns_id re-attributes every observation, tag, record, trigger and
// baseline of one counterparty to another, and every payload still opens,
// because the wrap is bound to namespace_id and not to the identity pair.
// And a shred could be undone by putting back a copy of the wrapped key
// taken before it, which the consistency check alone admits. `ensure` uses
// `do nothing` so that it never undoes a shred; that closed one path while
// the table left the rest open.
describe("what the table refuses on its own", () => {
  const CODE = "NNT05";

  it("refuses a DELETE, by SQLSTATE and by class", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "NODELETE" });
    const attempt = sql`delete from namespace where namespace_id = ${n.namespaceId}`.execute(db);
    await expect(attempt).rejects.toMatchObject({ code: CODE });
    const mapped = mapPgError(await attempt.catch((e: unknown) => e));
    expect(mapped).toBeInstanceOf(NamespaceAltered);
    expect(mapped).toBeInstanceOf(StoreError);
    expect((await repo.find("wallet", "NODELETE"))?.namespaceId).toBe(n.namespaceId);
  });

  it("refuses a change to the identity, so evidence cannot be re-attributed", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "FIXEDID" });
    const changes = [
      sql`kind = 'domain'`,
      sql`ns_id = 'FIXEDID2'`,
      sql`namespace_id = ${randomUUID()}`,
      sql`created_at = created_at + interval '1 second'`,
      sql`kind = 'merchant', ns_id = 'SOMEONE-ELSE'`,
    ];
    for (const change of changes) {
      await expect(
        sql`update namespace set ${change} where namespace_id = ${n.namespaceId}`.execute(db),
      ).rejects.toMatchObject({ code: CODE });
    }
    const row = await db.selectFrom("namespace").select(["kind", "ns_id", "created_at"])
      .where("namespace_id", "=", n.namespaceId).executeTakeFirstOrThrow();
    expect(row).toEqual({ kind: "wallet", ns_id: "FIXEDID", created_at: clock.now() });
  });

  // The copy is taken before the shred, which is the only time it can be.
  // Written back afterwards, with or without the timestamp cleared, it
  // satisfies the consistency check and would make every payload readable
  // again. Erasure is the only deletion this ledger has, and an erasure a
  // row copy can reverse is not one.
  it("refuses to un-shred, whether the key is put back, the timestamp cleared, or both", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "STAYSHRED" });
    const before = await db.selectFrom("namespace").select(["data_key_wrapped"])
      .where("namespace_id", "=", n.namespaceId).executeTakeFirstOrThrow();
    await repo.shred(n.namespaceId);
    const shreddedAt = (await repo.find("wallet", "STAYSHRED"))?.shreddedAt;
    expect(shreddedAt).not.toBeNull();
    const reversals = [
      sql`key_shredded_at = null, data_key_wrapped = ${before.data_key_wrapped}`,
      sql`data_key_wrapped = ${before.data_key_wrapped}`,
      sql`key_shredded_at = null`,
      sql`key_shredded_at = key_shredded_at + interval '1 day'`,
    ];
    for (const change of reversals) {
      await expect(
        sql`update namespace set ${change} where namespace_id = ${n.namespaceId}`.execute(db),
      ).rejects.toMatchObject({ code: CODE });
    }
    await expect(repo.dataKey(n.namespaceId)).rejects.toBeInstanceOf(NamespaceShredded);
    expect((await repo.find("wallet", "STAYSHRED"))?.shreddedAt?.getTime()).toBe(shreddedAt?.getTime());
  });

  // A re-wrap under a rotated master key is an UPDATE of data_key_wrapped on
  // a live row, and the guard must leave that open or rotation becomes a
  // migration. The key inside does not change; only its wrapping does.
  it("admits a re-wrap of a live row's key", async () => {
    const n = await repo.ensure({ kind: "wallet", id: "REWRAP" });
    const key = await repo.dataKey(n.namespaceId);
    await db.updateTable("namespace").set({ data_key_wrapped: ring.wrap(key, n.namespaceId) })
      .where("namespace_id", "=", n.namespaceId).execute();
    expect((await repo.dataKey(n.namespaceId)).equals(key)).toBe(true);
  });
});
