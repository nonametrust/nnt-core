import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { namespaceRefSchema, type WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db, Schema } from "../db.js";
import { withIsoDates } from "../db.js";
import type { Selectable } from "kysely";
import { urlForSchema, withSchema, storedObservation } from "../testing/harness.js";
import { keyRingFromEnv, newDataKey, periodKeyAad, unwrapUnder } from "../crypto.js";
import { fixedClock } from "../clock.js";
import {
  CiphertextRejected, NamespaceAltered, NamespaceNotFound, NamespaceShredded, PayloadExpired,
  PeriodKeyAltered, StoreError, mapPgError,
} from "../errors.js";
import { RETENTION_V0, expiresAt, type RetentionPolicy } from "../retention.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";
import { AuditChain } from "../audit/chain.js";

let db: Db;
let done: () => Promise<void>;
let repo: NamespaceRepository;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
const clock = fixedClock(new Date("2026-09-07T00:00:00.000Z"));

beforeAll(async () => {
  ({ db, done } = await withSchema("ns_test"));
  repo = new NamespaceRepository(db, ring, clock, RETENTION_V0);
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

// The month key: a key per (namespace, calendar month), wrapped under the
// namespace's own key. Shredding the month key makes that month unreadable
// while the namespace and every row stay where they are, which is what
// retention is in this design -- unreadability on a clock, not deletion.
async function keyVersions(): Promise<string[]> {
  const r = await sql<{ v: string }>`
    select namespace_id::text || ':' || period::text || ':' || xmin::text as v
    from namespace_key order by namespace_id, period`.execute(db);
  return r.rows.map((x) => x.v);
}

describe("the month key", () => {
  async function aNamespace(id: string): Promise<string> {
    return (await repo.ensure({ kind: "wallet", id })).namespaceId;
  }

  it("mints one key per period and gives the same key back", async () => {
    const ns = await aNamespace("PERIODKEY1");
    await repo.periodKey(ns, "2026-09-01");
    const first = await repo.openPeriodKey(ns, "2026-09-01");
    expect(first).toHaveLength(32);
    expect((await repo.openPeriodKey(ns, "2026-09-01")).equals(first)).toBe(true);
    // A second mint is a no-op, not a re-key: re-minting would strand every
    // payload already sealed under the first key.
    await repo.periodKey(ns, "2026-09-01");
    expect((await repo.openPeriodKey(ns, "2026-09-01")).equals(first)).toBe(true);
  });

  it("mints a different key for a different period and a different namespace", async () => {
    const a = await aNamespace("PERIODKEY2");
    const b = await aNamespace("PERIODKEY3");
    for (const [ns, period] of [[a, "2026-09-01"], [a, "2026-10-01"], [b, "2026-09-01"]] as const) {
      await repo.periodKey(ns, period);
    }
    const sept = await repo.openPeriodKey(a, "2026-09-01");
    expect((await repo.openPeriodKey(a, "2026-10-01")).equals(sept)).toBe(false);
    expect((await repo.openPeriodKey(b, "2026-09-01")).equals(sept)).toBe(false);
  });

  // The whole point of the wrap's associated data. Copy a live month key into
  // another row before the first is shredded and, without the binding, a live
  // copy survives the shred -- and shredding is the only erasure this design
  // has, so a shred a row copy can evade is not one.
  it("refuses a wrapped month key copied into another row, in either direction", async () => {
    const a = await aNamespace("PERIODCOPY1");
    const b = await aNamespace("PERIODCOPY2");
    await repo.periodKey(a, "2026-09-01");
    await repo.periodKey(a, "2026-10-01");
    await repo.periodKey(b, "2026-09-01");
    // The guard refuses a live key being replaced at all (R14), so the copy is
    // planted with the trigger off. That is not a weaker test: the associated
    // data's threat model is an attacker with write access to the table, and
    // under that model the trigger is already assumed bypassed. This is the
    // layer underneath it.
    async function copyKey(fromNs: string, fromPeriod: string, toNs: string, toPeriod: string) {
      await sql`alter table namespace_key disable trigger namespace_key_guarded`.execute(db);
      try {
        await sql`update namespace_key set key_wrapped =
          (select key_wrapped from namespace_key
           where namespace_id = ${fromNs} and period = ${fromPeriod}::date)
          where namespace_id = ${toNs} and period = ${toPeriod}::date`.execute(db);
      } finally {
        await sql`alter table namespace_key enable trigger namespace_key_guarded`.execute(db);
      }
    }
    // Another namespace, same period.
    await copyKey(a, "2026-09-01", b, "2026-09-01");
    await expect(repo.openPeriodKey(b, "2026-09-01")).rejects.toBeInstanceOf(CiphertextRejected);
    // Same namespace, another period.
    await copyKey(a, "2026-09-01", a, "2026-10-01");
    await expect(repo.openPeriodKey(a, "2026-10-01")).rejects.toBeInstanceOf(CiphertextRejected);
  });

  // R14, the guard branch above the cipher. The namespace table admits a live
  // re-wrap on purpose, because rotating the master re-wraps every namespace
  // key under it; no such reason exists one level down, where a month key is
  // wrapped under a data key M1 rules is never rotated. A live month silently
  // re-keyed strands every payload already sealed under the old key while the
  // row still says the month is live.
  it("refuses a live month key being replaced, above the cipher", async () => {
    const ns = await aNamespace("PERIODREWRAP");
    await repo.periodKey(ns, "2026-09-01");
    const attempt = sql`update namespace_key set key_wrapped = ${Buffer.alloc(61, 7)}
      where namespace_id = ${ns}`.execute(db);
    await expect(attempt).rejects.toMatchObject({ code: "NNT06" });
    await expect(attempt).rejects.toThrow(/live month key is not replaced/);
    await expect(repo.openPeriodKey(ns, "2026-09-01")).resolves.toHaveLength(32);
  });

  // The two-level key is the whole design, and nothing held it: wrapping the
  // month key under ring.deriveKey(namespaceId) instead of the namespace's
  // own data key passes every other test here. Under that mistake a shred
  // stops destroying the month keys and merely hides them behind a TypeScript
  // ordering -- anyone holding the master key and the database recovers every
  // month of an erased counterparty, which is the shred evasion the ring's
  // own comment warns about.
  it("wraps the month key under the namespace's data key, so a shred destroys it", async () => {
    const ns = await aNamespace("PERIODTWOLEVEL");
    await repo.periodKey(ns, "2026-09-01");
    const dataKey = await repo.dataKey(ns);
    const row = await db.selectFrom("namespace_key").select(["key_wrapped"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    const wrapped = row!.key_wrapped!;
    const aad = periodKeyAad(ns, "2026-09-01");
    expect(unwrapUnder(dataKey, wrapped, aad)).toHaveLength(32);
    // Not under anything derivable from the master alone. If it were, the
    // shred below would destroy nothing.
    expect(() => unwrapUnder(ring.deriveKey(ns), wrapped, aad)).toThrow(CiphertextRejected);

    await repo.shred(ns);
    // The row and its bytes are still there, and now nothing in the system
    // can open them: the only key that could is gone.
    const after = await db.selectFrom("namespace_key").select(["key_wrapped"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    expect(after?.key_wrapped?.equals(wrapped)).toBe(true);
    expect(() => unwrapUnder(ring.deriveKey(ns), wrapped, aad)).toThrow(CiphertextRejected);
  });

  // The binding is the pair as the DATABASE spells it, not as the caller
  // typed it. A uuid in another case names the same row and `2026-9-1` is the
  // same date to Postgres; bound to the caller's spelling, a mint and a read
  // that disagree on either produce a CiphertextRejected -- a tamper report
  // for a formatting difference.
  it("opens whatever spelling of the pair the caller uses", async () => {
    const ns = await aNamespace("PERIODSPELLING");
    await repo.periodKey(ns.toUpperCase(), "2026-9-1");
    const canonical = await repo.openPeriodKey(ns, "2026-09-01");
    expect(canonical).toHaveLength(32);
    expect((await repo.openPeriodKey(ns.toUpperCase(), "2026-09-01")).equals(canonical)).toBe(true);
    expect((await repo.openPeriodKey(ns, "2026-9-1")).equals(canonical)).toBe(true);
    expect(await repo.periodsOf(ns)).toEqual(["2026-09-01"]);
  });

  it("stamps created_at from the injected clock", async () => {
    const ns = await aNamespace("PERIODCREATED");
    await repo.periodKey(ns, "2026-09-01");
    const row = await db.selectFrom("namespace_key").select(["created_at"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    expect(row?.created_at.toISOString()).toBe(clock.now().toISOString());
  });

  // graceDays = 0 expires a month at its close, which assertRetentionPolicy
  // explicitly admits as a policy rather than a defect. Both database
  // boundaries are `>=` for that reason, and nothing pinned either: mutating
  // expires_after_period or shred_not_early to `>` left the suite green.
  //
  // This is also the only test that overrides a RetentionPolicy field, which
  // the plan's own habit requires -- without it, the required constructor
  // parameter is indistinguishable from a hardcoded ninety.
  it("admits a zero grace at both boundaries: expiry at the close, shred at expiry", async () => {
    const eager = new NamespaceRepository(db, ring, clock, { ...RETENTION_V0, graceDays: 0 });
    const ns = (await eager.ensure({ kind: "wallet", id: "PERIODGRACE0" })).namespaceId;
    await eager.periodKey(ns, "2026-09-01");
    const row = await db.selectFrom("namespace_key").select(["expires_at"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    // The close itself, with no grace after it.
    expect(row?.expires_at.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    // And a sweep may shred at exactly that instant, which is what
    // expirePeriods will do at its own boundary: it sets shredded_at = now on
    // the first sweep where expires_at <= now.
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${row!.expires_at}
      where namespace_id = ${ns}`.execute(db);
    await expect(eager.openPeriodKey(ns, "2026-09-01")).rejects.toBeInstanceOf(PayloadExpired);
  });

  it("refuses to mint under a shredded namespace, and writes no row", async () => {
    const ns = await aNamespace("PERIODSHRED1");
    await repo.shred(ns);
    await expect(repo.periodKey(ns, "2026-09-01")).rejects.toBeInstanceOf(NamespaceShredded);
    expect(await repo.periodsOf(ns)).toEqual([]);
  });

  // The namespace key is the outer one. Once it is gone there is no inner key
  // to mint under and nothing to unwrap with, so the namespace's refusal wins
  // over the period's: an operator must not be told a month expired when the
  // whole counterparty space was erased.
  it("lets the namespace's shred win over the period's, and leaves the rows alone", async () => {
    const ns = await aNamespace("PERIODSHRED2");
    await repo.periodKey(ns, "2026-09-01");
    await repo.periodKey(ns, "2026-10-01");
    const before = await keyVersions();
    // Without this the second half is vacuous: delete the two mints above and
    // "leaves the rows alone" still passes, because it compares one empty
    // list to another.
    expect(before.filter((v) => v.startsWith(ns))).toHaveLength(2);
    await repo.shred(ns);
    for (const period of ["2026-09-01", "2026-10-01"]) {
      await expect(repo.openPeriodKey(ns, period)).rejects.toBeInstanceOf(NamespaceShredded);
    }
    expect(await keyVersions()).toEqual(before);
  });

  // A late observation for a month that has already expired must not revive
  // it. `append` calls periodKey before it seals, so without do-nothing on
  // conflict an arrival after expiry would mint a fresh key over the dead
  // one -- and then some payloads of that month would open and the rest
  // would not, under a row that says the month was shredded. Retention would
  // be a suggestion.
  it("does not revive an expired month when a later observation asks for it", async () => {
    const ns = await aNamespace("PERIODREVIVE");
    await repo.periodKey(ns, "2026-09-01");
    const at = new Date("2027-01-05T00:00:00.000Z");
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${at}
      where namespace_id = ${ns} and period = date '2026-09-01'`.execute(db);
    const before = await keyVersions();

    await repo.periodKey(ns, "2026-09-01");

    // Not one byte written: xmin would move on any UPDATE, including one
    // that set a column to the value it already held.
    expect(await keyVersions()).toEqual(before);
    await expect(repo.openPeriodKey(ns, "2026-09-01")).rejects.toBeInstanceOf(PayloadExpired);
    const row = await db.selectFrom("namespace_key").select(["key_wrapped", "shredded_at"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    expect(row?.key_wrapped).toBeNull();
    expect(row?.shredded_at?.toISOString()).toBe(at.toISOString());
  });

  // A second mint over a LIVE month must not rewrite the key either: every
  // payload already sealed under the first one would be stranded, readable
  // by nothing, with the row still claiming the month is live.
  it("writes nothing at all when a live month is minted again", async () => {
    const ns = await aNamespace("PERIODREMINT");
    await repo.periodKey(ns, "2026-09-01");
    const before = await keyVersions();
    await repo.periodKey(ns, "2026-09-01");
    expect(await keyVersions()).toEqual(before);
  });

  // The two erasures can both be true of one month, and then the outer one is
  // the answer. Told "expired", an operator would go looking for a retention
  // sweep instead of the erasure request that actually happened.
  it("says shredded, not expired, for a month that is both", async () => {
    const ns = await aNamespace("PERIODBOTH");
    await repo.periodKey(ns, "2026-09-01");
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${new Date("2027-01-05T00:00:00Z")}
      where namespace_id = ${ns} and period = date '2026-09-01'`.execute(db);
    await repo.shred(ns);
    await expect(repo.openPeriodKey(ns, "2026-09-01")).rejects.toBeInstanceOf(NamespaceShredded);
  });

  it("names an expired month, with the period and the instant it was shredded", async () => {
    const ns = await aNamespace("PERIODEXPIRED");
    await repo.periodKey(ns, "2026-09-01");
    const at = new Date("2027-01-05T00:00:00.000Z");
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${at}
      where namespace_id = ${ns} and period = date '2026-09-01'`.execute(db);
    const opened = repo.openPeriodKey(ns, "2026-09-01");
    await expect(opened).rejects.toBeInstanceOf(PayloadExpired);
    await expect(opened).rejects.toThrow(/2026-09-01/);
    await expect(opened).rejects.toThrow(/2027-01-05/);
  });

  // Expiry is fixed at mint from the period and the policy in force (R2), and
  // takes no clock: a backfill of last year expires a grace after last year's
  // month closed, not a grace after the day it was loaded. The clock here is
  // 2026 and the period is 2025.
  it("fixes expiry from the period and the policy, not from the clock", async () => {
    const ns = await aNamespace("PERIODEXPIRY");
    await repo.periodKey(ns, "2025-03-01");
    const row = await db.selectFrom("namespace_key").select(["expires_at"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    expect(row?.expires_at.toISOString())
      .toBe(expiresAt("2025-03-01", RETENTION_V0).toISOString());
    // Ninety days after 2025-04-01, and the clock reads 2026-09-07.
    expect(row?.expires_at.toISOString()).toBe("2025-06-30T00:00:00.000Z");
  });
});

// R8: the driver parses a `date` at LOCAL midnight, and this machine sits at
// UTC+3 while CI sits at UTC. Read back as a Date, 2026-09-01 becomes
// 2026-08-31T21:00Z east of Greenwich and the wrong month's key is looked up,
// silently. Every select of `period` renders it as text for that reason.
describe("the period column under a skewed zone", () => {
  // The read type is the rule, and the rule was held by its own declaration:
  // changing `period` back to a readable `string` left the suite green and
  // the typecheck clean, because nothing ever selected it.
  //
  // A `@ts-expect-error` on the select itself does NOT pin it -- selecting a
  // `never` column compiles perfectly well, you simply get `never` back --
  // and the first version of this test asserted exactly that non-error and so
  // failed in both directions. The rule is about the TYPE THAT COMES BACK, so
  // that is what is asserted: the tuple wrapper stops `never` distributing,
  // and assigning `true` to `false` is the compile error when the read type
  // widens to anything at all.
  //
  // tsconfig.test.json has `"exclude": []`, so this file is typechecked and
  // the line below is enforced by `pnpm typecheck`, not by vitest.
  // What the type actually buys, stated precisely, because the first version
  // of this comment overstated it and review measured the overstatement:
  // `never` removes the column from `Selectable`, but Kysely's `.select()`
  // takes its names from the table type, so `.select(["period"])` still
  // COMPILES and hands back `period: never` -- which assigns to `string`
  // silently, because never assigns to everything. The type stops a row
  // shape from claiming the column is readable; it does not stop the select.
  //
  // The select is stopped lexically instead, by the gate below.
  it("is absent from the readable row shape", () => {
    type PeriodIsUnreadable =
      "period" extends keyof Selectable<Schema["namespace_key"]> ? false : true;
    const unreadable: PeriodIsUnreadable = true;
    expect(unreadable).toBe(true);
  });

  // The zone is not the only server setting that can move this string.
  // `date::text` renders through DateStyle: the same date is 2026-09-01 under
  // ISO, 01.09.2026 under German and 09/01/2026 under SQL/MDY. The month
  // key's binding is built from that rendering, so a key minted under one
  // DateStyle and opened under another would refuse as CiphertextRejected --
  // a tamper report for a postgresql.conf line. That is the same argument
  // this branch used against the naive CHECK, one function away.
  it("binds the period independently of the server's DateStyle", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "DATESTYLE" })).namespaceId;
    await repo.periodKey(ns, "2026-09-01");
    for (const style of ["German", "SQL, MDY", "Postgres"]) {
      await db.transaction().execute(async (trx) => {
        await sql.raw(`set local datestyle = '${style}'`).execute(trx);
        const inside = new NamespaceRepository(trx, ring, clock, RETENTION_V0);
        // The key still opens: its binding is rendered by to_char with an
        // explicit pattern, not by `period::text`, which would be
        // 01.09.2026 here and refuse as a tamper.
        expect(await inside.openPeriodKey(ns, "2026-09-01"), style).toHaveLength(32);
        expect(await inside.periodsOf(ns), style).toEqual(["2026-09-01"]);
      });
    }
  });

  // The other half, and a separate mechanism. `to_char` fixes what this
  // package RENDERS; it does nothing about what the driver PARSES. Under a
  // non-ISO DateStyle the server sends timestamptz as 01.09.2026 ..., node-pg
  // does not recognise it, and every timestamp column arrives as null -- a
  // read then crashes on .getTime() with an error this package does not own.
  // So every connection announces ISO, which beats a server default, an
  // `alter role ... set datestyle` and a PGDATESTYLE in the environment.
  //
  // (The test above defeats this deliberately with `set local`, because it is
  // testing the rendering. This one tests the pin.)
  it("pins DateStyle on its own connections, so the driver can read a timestamp", async () => {
    const shown = await sql<{ s: string }>`select current_setting('DateStyle') as s`.execute(db);
    expect(shown.rows[0]?.s).toMatch(/^ISO/);
    expect(withIsoDates("postgres://h/db")).toContain("datestyle%3DISO");
    // Appended, not assigned: urlForSchema already puts a search_path in
    // `options`, and a second `options` parameter would replace it.
    const both = withIsoDates(urlForSchema("postgres://h/db", "some_schema"));
    expect(both).toContain("search_path");
    expect(both).toContain("datestyle");
    // Idempotent, so wrapping a url twice does not stack the flag.
    expect(withIsoDates(both)).toBe(both);
  });

  // The three holes the branch review measured in this one function, each of
  // which silently returns a url whose pins never reach the server. The
  // oracle is libpq's own rule -- `options` is ONE parameter and the LAST
  // `-c` for a setting wins -- so these assert on the string we hand the
  // driver rather than on the driver's internals.
  const optionsOf = (url: string): string[] =>
    new URL(url).searchParams.getAll("options");

  it("collapses several options parameters into one, because the driver reads one", () => {
    // `urlForSchema` appends its search_path by string concatenation, so a
    // base url that already carries `options` produces two of them. The old
    // code read the FIRST with `.get` and then wrote with `.set`, which
    // deletes every other occurrence -- so the search_path was dropped on the
    // floor and nothing said so.
    const two = withIsoDates(
      urlForSchema("postgres://h/db?options=-c%20statement_timeout%3D5000", "some_schema"),
    );
    expect(optionsOf(two)).toHaveLength(1);
    const opts = optionsOf(two)[0]!;
    expect(opts).toContain("search_path=some_schema");
    expect(opts).toContain("statement_timeout=5000");
    expect(opts).toContain("datestyle=ISO");
    expect(opts).toContain("default_transaction_isolation=read\\ committed");
  });

  it("puts its pin after a contrary setting, because the last -c is the one that takes", () => {
    // `existing.includes(pin)` is a substring test, not a test of which `-c`
    // is effective: a caller whose options happen to contain our fragment AND
    // a contrary setting after it was told the pin was already there. Both
    // pins were defeated this way, and a non-ISO DateStyle makes every
    // timestamp column arrive null.
    const hostile = withIsoDates(
      "postgres://h/db?options=" +
        encodeURIComponent(
          "-c datestyle=ISO -c default_transaction_isolation=read\\ committed" +
            " -c datestyle=German -c default_transaction_isolation=repeatable\\ read",
        ),
    );
    const opts = optionsOf(hostile)[0]!;
    expect(opts.lastIndexOf("datestyle=ISO")).toBeGreaterThan(opts.lastIndexOf("datestyle=German"));
    expect(opts.lastIndexOf("default_transaction_isolation=read\\ committed"))
      .toBeGreaterThan(opts.lastIndexOf("default_transaction_isolation=repeatable\\ read"));
  });

  it("re-pins a setting a caller overrode, and leaves a setting it does not own alone", () => {
    const one = withIsoDates("postgres://h/db?options=" + encodeURIComponent("-c datestyle=German"));
    const opts = optionsOf(one)[0]!;
    expect(opts.lastIndexOf("datestyle=ISO")).toBeGreaterThan(opts.lastIndexOf("datestyle=German"));
    // Untouched: we pin two settings and claim nothing about the rest.
    expect(withIsoDates("postgres://h/db?options=" + encodeURIComponent("-c lock_timeout=1000")))
      .toContain("lock_timeout%3D1000");
  });

  it("round-trips the same month in every zone the process might run in", async () => {
    const was = process.env.TZ;
    try {
      for (const zone of ["UTC", "Etc/GMT-3", "Etc/GMT-14", "Etc/GMT+12"]) {
        process.env.TZ = zone;
        const ns = (await repo.ensure({ kind: "wallet", id: `TZ${zone}` })).namespaceId;
        await repo.periodKey(ns, "2026-09-01");
        const key = await repo.openPeriodKey(ns, "2026-09-01");
        expect(key, zone).toHaveLength(32);
        const rows = await repo.periodsOf(ns);
        expect(rows, zone).toEqual(["2026-09-01"]);
      }
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });
});

describe("what the namespace_key table refuses to hold", () => {
  async function mint(id: string, period = "2026-09-01"): Promise<string> {
    const ns = (await repo.ensure({ kind: "wallet", id })).namespaceId;
    await repo.periodKey(ns, period);
    return ns;
  }

  it("refuses a period that is not the first of a month, by name", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "RAWPERIOD1" })).namespaceId;
    await expect(
      sql`insert into namespace_key (namespace_id, period, key_wrapped, expires_at, shredded_at, created_at)
          values (${ns}, date '2026-09-15', ${Buffer.alloc(61)}, ${new Date("2027-01-01")}, null, ${clock.now()})`
        .execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_period_is_month" });
  });

  // The constraint pins its UTC conversion instead of inheriting the
  // session's, and nothing held that: the naive form
  // `expires_at >= period + interval '1 month'` passes this whole suite,
  // because under a UTC or an eastern session it is equal to or looser than
  // the pinned one. It is only visibly wrong west of Greenwich, and that is
  // where nobody runs the tests.
  //
  // `set local` is scoped to this transaction, so a pooled connection carries
  // nothing out of it. The row is a zero-grace mint at exactly the UTC close:
  // the pinned form admits it, and the naive form demands 04:00Z under New
  // York and would refuse it.
  it("measures the close in UTC and not in the session's zone", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "RAWPERIODTZ" })).namespaceId;
    await db.transaction().execute(async (trx) => {
      await sql`set local timezone = 'America/New_York'`.execute(trx);
      await sql`insert into namespace_key
          (namespace_id, period, key_wrapped, expires_at, shredded_at, created_at)
        values (${ns}, date '2026-09-01', ${Buffer.alloc(61)},
          ${new Date("2026-10-01T00:00:00.000Z")}, null, ${clock.now()})`.execute(trx);
      // And the naive form, built here, refuses the row the shipped one just
      // took -- which is the whole reason the shipped one is written the way
      // it is, asserted rather than left in a comment.
      await sql`create temp table naive_probe (
        period date not null, expires_at timestamptz not null,
        constraint naive check (expires_at >= period + interval '1 month')
      ) on commit drop`.execute(trx);
      await expect(
        sql`insert into naive_probe values (date '2026-09-01', ${new Date("2026-10-01T00:00:00.000Z")})`
          .execute(trx),
      ).rejects.toMatchObject({ code: "23514", constraint: "naive" });
    });
  });

  // The lower bound alone lets a writer plant a month that never expires.
  // Measured by review: a row with expires_at in 2999 is accepted, and
  // because periodKey is on-conflict-do-nothing the plant WINS over the
  // legitimate mint -- so the sweep never reaches that month and its payloads
  // stay readable for a thousand years. The ceiling is generous rather than
  // tight: it is not a policy, it is the difference between a grace and a
  // mistake, and a policy that wanted more would be a migration.
  it("refuses an expiry absurdly far after the period, by name", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "RAWPERIODFAR" })).namespaceId;
    await expect(
      sql`insert into namespace_key (namespace_id, period, key_wrapped, expires_at, shredded_at, created_at)
          values (${ns}, date '2026-09-01', ${Buffer.alloc(61)}, ${new Date("2999-01-01T00:00:00Z")}, null, ${clock.now()})`
        .execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_expires_in_range" });
  });

  // And the repository refuses a row it did not write the expiry of, which is
  // the same plant arriving before the legitimate mint: on conflict do
  // nothing means periodKey would otherwise accept it silently.
  it("refuses to use a month whose expiry is not the one the policy gives", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "PLANTEDEXPIRY" })).namespaceId;
    const wrong = new Date("2027-06-01T00:00:00.000Z");
    await sql`insert into namespace_key (namespace_id, period, key_wrapped, expires_at, shredded_at, created_at)
        values (${ns}, date '2026-09-01', ${Buffer.alloc(61)}, ${wrong}, null, ${clock.now()})`
      .execute(db);
    const minted = repo.periodKey(ns, "2026-09-01");
    await expect(minted).rejects.toBeInstanceOf(PeriodKeyAltered);
    await expect(minted).rejects.toThrow(/expiry/);
  });

  it("refuses an expiry before the period closes, by name", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "RAWPERIOD2" })).namespaceId;
    await expect(
      sql`insert into namespace_key (namespace_id, period, key_wrapped, expires_at, shredded_at, created_at)
          values (${ns}, date '2026-09-01', ${Buffer.alloc(61)}, ${new Date("2026-09-30T00:00:00Z")}, null, ${clock.now()})`
        .execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_expires_in_range" });
  });

  // R2's guard, and the reason expiry is a column at all: an early shred is
  // refused against the row's own value, with no wall clock in the database.
  it("refuses a shred before the month expires, by name", async () => {
    const ns = await mint("RAWPERIOD3");
    await expect(
      sql`update namespace_key set key_wrapped = null, shredded_at = ${new Date("2026-10-02T00:00:00Z")}
          where namespace_id = ${ns} and period = date '2026-09-01'`.execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_shred_not_early" });
  });

  it("refuses a key gone without a shred instant, and an instant without the key going", async () => {
    const ns = await mint("RAWPERIOD4");
    await expect(
      sql`update namespace_key set key_wrapped = null
          where namespace_id = ${ns} and period = date '2026-09-01'`.execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_shred_consistent" });
    await expect(
      sql`update namespace_key set shredded_at = ${new Date("2027-01-05T00:00:00Z")}
          where namespace_id = ${ns} and period = date '2026-09-01'`.execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_shred_consistent" });
  });

  // 29 is the wrapped-key header: one version byte, a twelve-byte nonce, a
  // sixteen-byte tag. Anything that short holds no key, and without this an
  // empty bytea would count as live under the consistency check above.
  it("refuses a wrapped key too short to hold one, by name", async () => {
    const ns = (await repo.ensure({ kind: "wallet", id: "RAWPERIOD5" })).namespaceId;
    await expect(
      sql`insert into namespace_key (namespace_id, period, key_wrapped, expires_at, shredded_at, created_at)
          values (${ns}, date '2026-09-01', ${Buffer.alloc(29)}, ${new Date("2027-01-01")}, null, ${clock.now()})`
        .execute(db),
    ).rejects.toMatchObject({ code: "23514", constraint: "namespace_key_wrapped_present" });
  });
});

describe("the namespace_key guard", () => {
  const CODE = "NNT06";

  async function mint(id: string): Promise<string> {
    const ns = (await repo.ensure({ kind: "wallet", id })).namespaceId;
    await repo.periodKey(ns, "2026-09-01");
    return ns;
  }

  // Both halves, the way the namespace guard's own tests do it: the raw
  // driver error carries the SQLSTATE this package allocated, and mapPgError
  // turns it into the class callers assert on. Asserting only one of the two
  // would let an unmapped code pass as a refusal nobody can catch by class.
  async function refused(attempt: Promise<unknown>, pattern: RegExp): Promise<void> {
    await expect(attempt).rejects.toMatchObject({ code: CODE });
    const mapped = mapPgError(await attempt.catch((e: unknown) => e));
    expect(mapped).toBeInstanceOf(PeriodKeyAltered);
    expect(mapped).toBeInstanceOf(StoreError);
    expect((mapped as Error).message).toMatch(pattern);
  }

  it("refuses a DELETE: a month is expired by shredding its key, never by dropping the row", async () => {
    const ns = await mint("GUARDDEL");
    await refused(
      sql`delete from namespace_key where namespace_id = ${ns}`.execute(db),
      /never deleted/,
    );
    expect(await repo.periodsOf(ns)).toEqual(["2026-09-01"]);
  });

  it("refuses a move of any fixed column, naming which rule failed", async () => {
    const ns = await mint("GUARDFIXED");
    const other = (await repo.ensure({ kind: "wallet", id: "GUARDFIXED2" })).namespaceId;
    const moves = [
      [sql`namespace_id = ${other}`, /identity is fixed/],
      [sql`period = date '2026-10-01'`, /identity is fixed/],
      [sql`created_at = ${new Date("2020-01-01T00:00:00Z")}`, /identity is fixed/],
      // Its own message, because its reason is its own: R2 fixes expiry at
      // mint, and a policy change that must move it is a migration.
      [sql`expires_at = ${new Date("2030-01-01T00:00:00Z")}`, /expires_at is fixed at mint/],
    ] as const;
    for (const [move, pattern] of moves) {
      await refused(
        sql`update namespace_key set ${move} where namespace_id = ${ns}`.execute(db),
        pattern,
      );
    }
  });

  it("refuses to un-shred a month, or to move the instant it was shredded", async () => {
    const ns = await mint("GUARDUNSHRED");
    const at = new Date("2027-01-05T00:00:00.000Z");
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${at}
      where namespace_id = ${ns}`.execute(db);
    await refused(
      sql`update namespace_key set key_wrapped = ${Buffer.alloc(61)}, shredded_at = null
          where namespace_id = ${ns}`.execute(db),
      /stays expired/,
    );
    await refused(
      sql`update namespace_key set shredded_at = ${new Date("2027-02-05T00:00:00Z")}
          where namespace_id = ${ns}`.execute(db),
      /stays expired/,
    );
    // And the row is still expired, with the first instant intact: that
    // instant is the compliance record.
    const row = await db.selectFrom("namespace_key").select(["key_wrapped", "shredded_at"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    expect(row?.key_wrapped).toBeNull();
    expect(row?.shredded_at?.toISOString()).toBe(at.toISOString());
  });

  // The sanctioned path the migration comment names, proved rather than
  // asserted: a policy that shortens the grace moves expires_at on minted
  // rows through a migration that disables this trigger. Without this test
  // "that is a migration, loudly" is a sentence with no demonstration, and a
  // reader would reasonably conclude expiry can never change at all.
  it("admits the migration path it names, with the trigger disabled", async () => {
    const ns = await mint("GUARDMIGRATE");
    const shorter = new Date("2026-10-08T00:00:00.000Z");
    await db.transaction().execute(async (trx) => {
      await sql`alter table namespace_key disable trigger namespace_key_guarded`.execute(trx);
      await sql`update namespace_key set expires_at = ${shorter} where namespace_id = ${ns}`
        .execute(trx);
      await sql`alter table namespace_key enable trigger namespace_key_guarded`.execute(trx);
    });
    const row = await db.selectFrom("namespace_key").select(["expires_at"])
      .where("namespace_id", "=", ns).executeTakeFirst();
    expect(row?.expires_at.toISOString()).toBe(shorter.toISOString());
    // The guard is back on afterwards, so the path is a migration and not a
    // way to leave the table unguarded.
    await refused(
      sql`update namespace_key set expires_at = ${new Date("2031-01-01T00:00:00Z")}
          where namespace_id = ${ns}`.execute(db),
      /expires_at is fixed at mint/,
    );
  });
});

// Task 7. The sweep that makes retention a clock rather than a sentence.
//
// This block owns its own SCHEMA, which is not fastidiousness. `expirePeriods`
// takes no namespace argument -- it is the nightly job and it sweeps the whole
// table -- so run against `ns_test` it would also shred the rows every other
// describe in this file minted, and "the sweep returned exactly this period"
// would be measuring whichever tests happened to run first. The 2025 period
// minted by "fixes expiry from the period and the policy" expires 2025-06-30
// and is already past every clock below.
//
// Every repository here is built from ONE policy object with graceDays 7.
// R16 refuses a stored expiry its own policy did not compute, so a fixture
// appended through a ninety-day repository and swept by a seven-day one is a
// PeriodKeyAltered on the next append to that namespace rather than a sweep
// that finds nothing -- which is the failure this comment exists to stop
// someone rediscovering.
//
// THIS BLOCK IS ONE STORY IN ORDER, and that is a property of the thing under
// test rather than a shortcut. `expirePeriods` sweeps the whole table, so a
// test that asserts an exact swept list is asserting something about every
// month every earlier test left live. Review shuffled the block and six of
// its tests went red; that is expected, but it was written down nowhere, and
// two of the six failed with a TypeError on a null `find()` rather than
// saying what was missing. Both halves are addressed: the dependence is
// stated here, and fixtures are reached through `idOf`, which names the
// missing one.
//
// What that costs a reader: a test here cannot be run alone with `-t` and
// believed. What it buys: the exact-list assertions, which are the only
// thing that caught a sweep reporting one row of four.
describe("expirePeriods: expiry is unreadability and nothing else", () => {
  const grace7: RetentionPolicy = { ...RETENTION_V0, graceDays: 7 };
  const SEPT = "2026-09-01";
  const OCT = "2026-10-01";
  // 2026-10-01 plus seven days. Written out rather than computed so that a
  // change to expiresAt cannot move the boundary this test is about.
  const due = new Date("2026-10-08T00:00:00.000Z");

  let sdb: Db;
  let sdone: () => Promise<void>;

  /** Repositories that share `grace7` and read one fixed instant. */
  function at(iso: string) {
    const c = fixedClock(new Date(iso));
    const namespaces = new NamespaceRepository(sdb, ring, c, grace7);
    return { namespaces, observations: new ObservationRepository(sdb, namespaces, c, grace7) };
  }

  /**
   * The namespace id for a wallet this block appended earlier, or a named
   * failure. Through `find(...)!.namespaceId` this was a TypeError on null
   * whenever a test ran out of order -- review shuffled the block and got
   * "Cannot read properties of null" twice, which says nothing about what
   * was actually missing.
   */
  async function idOf(wallet: string): Promise<string> {
    const found = await at("2026-09-07T00:00:00.000Z").namespaces.find("wallet", wallet);
    if (!found) {
      throw new Error(
        `fixture ${wallet} has not been appended yet: this test reads a namespace an ` +
          `earlier test in this block creates, and the block is one story in order`,
      );
    }
    return found.namespaceId;
  }

  /** The key row for one pair. Scoped to the namespace on purpose: two
   * namespaces hold a 2026-09-01 row here, and a query on the period alone
   * takes an arbitrary one of them. Review found two such queries; they read
   * correctly only because both rows happened to carry identical values. */
  async function keyRow(wallet: string, period: string) {
    return sdb.selectFrom("namespace_key").select(["expires_at", "shredded_at"])
      .where("namespace_id", "=", await idOf(wallet))
      .where(sql<boolean>`period = ${period}::date`).executeTakeFirstOrThrow();
  }

  function anEvent(id: string, ref: string): WireObservation {
    return {
      schemaVersion: "0.1.0",
      namespace: { kind: "wallet", id },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-12T09:00:00.000Z",
      source: {
        producer: "stellar-indexer", producerVersion: "0.1.0",
        network: "testnet", ref, fetchedAt: "2026-09-05T10:00:00.000Z",
      },
      payload: { amount: "500.0000000" },
      salienceHints: { amount: "500.0000000" },
    } as WireObservation;
  }

  beforeAll(async () => {
    ({ db: sdb, done: sdone } = await withSchema("ns_sweep"));
  });
  afterAll(async () => { await sdone(); });

  it("pins the boundary this block is built on", () => {
    expect(expiresAt(SEPT, grace7).toISOString()).toBe(due.toISOString());
  });

  it("shreds nothing one millisecond before the expiry, and the month at it", async () => {
    const september = at("2026-09-07T00:00:00.000Z");
    const observation = storedObservation(await september.observations.append(anEvent("SWEEPSEPT", "op:sweep:1")));
    const id = observation.observationId!;
    // Readable before anything sweeps, so the refusal below is the sweep's
    // doing and not the fixture's.
    expect((await september.observations.get(id)).channel).toBe("volume");

    // One millisecond early. `expires_at <= now` is the clause under test.
    //
    // The comment here used to say "deleted, this returns the period and the
    // assertion fails". Review measured that and it is wrong about the
    // mechanism: with the clause deleted the sweep never returns, because a
    // shred instant a millisecond before the expiry is refused by the CHECK
    // namespace_key_shred_not_early first. The rule is still held here --
    // review also planted an early sweep shaped to slip past the CHECK
    // (`expires_at <= now + 1 day` with `shredded_at = greatest(now,
    // expires_at)`) and this assertion was the only thing in the repository
    // that caught it.
    const early = await at("2026-10-07T23:59:59.999Z").namespaces.expirePeriods();
    expect(early.shredded).toEqual([]);
    expect((await september.observations.get(id)).channel).toBe("volume");

    // And at the instant itself. `>=` in namespace_key_shred_not_early is
    // what admits shredded_at exactly equal to expires_at.
    const swept = await at(due.toISOString()).namespaces.expirePeriods();
    expect(swept.shredded).toEqual([
      { namespaceId: expect.any(String), period: SEPT, namespaceErasedAtSweep: false },
    ]);
    await expect(september.observations.get(id)).rejects.toBeInstanceOf(PayloadExpired);
  });

  it("leaves the row, its key row and its foreign key exactly where they were", async () => {
    // The whole claim of this design: the payload stops opening and NOTHING
    // else changes. A sweep that deleted rows would pass every readability
    // assertion above and fail here.
    const rows = await sql<{ observations: string; keys: string; orphans: string }>`
      select (select count(*) from observation)::text as observations,
             (select count(*) from namespace_key)::text as keys,
             (select count(*) from observation o
                where not exists (select 1 from namespace_key k
                  where k.namespace_id = o.namespace_id and k.period = o.period))::text as orphans
    `.execute(sdb);
    expect(rows.rows[0]!.orphans).toBe("0");
    expect(Number(rows.rows[0]!.observations)).toBeGreaterThan(0);
    expect(Number(rows.rows[0]!.keys)).toBeGreaterThan(0);
    // The shred instant is the sweep's, and the expiry it was measured
    // against is untouched. Both values are `due` here, which is why this
    // pair cannot hold the instant on its own; the October row two tests
    // below is where the two separate.
    const key = await keyRow("SWEEPSEPT", SEPT);
    expect(key.expires_at.toISOString()).toBe(due.toISOString());
    expect(key.shredded_at?.toISOString()).toBe(due.toISOString());
  });

  it("sweeps a second namespace's September and leaves October readable", async () => {
    const october = at("2026-10-05T00:00:00.000Z");
    // Appended in October, so its period is October and its grace has not
    // run: the sweep below must not reach it.
    const live = await october.observations.append(anEvent("SWEEPOCT", "op:sweep:oct"));
    // A second namespace's September, minted late enough that the previous
    // sweep did not see it.
    const late = at("2026-09-20T00:00:00.000Z");
    const stale = await late.observations.append(anEvent("SWEEPOTHER", "op:sweep:other"));

    const swept = await at(due.toISOString()).namespaces.expirePeriods();
    expect(swept.shredded.map((s) => s.period)).toEqual([SEPT]);
    await expect(late.observations.get(storedObservation(stale).observationId!))
      .rejects.toBeInstanceOf(PayloadExpired);
    expect((await october.observations.get(storedObservation(live).observationId!)).channel)
      .toBe("volume");
    expect(await october.namespaces.periodsOf(await idOf("SWEEPOCT"))).toEqual([OCT]);
  });

  it("sweeps an expired month once and never moves the instant again", async () => {
    // `key_wrapped is not null` is the clause under test. Deleted, this
    // second sweep re-selects the already-shredded row, tries to write a new
    // shredded_at over it, and the guard refuses with NNT06 -- so the
    // mutation surfaces here as a thrown PeriodKeyAltered rather than as a
    // wrong list.
    const late = "2026-12-01T00:00:00.000Z";
    const again = await at(late).namespaces.expirePeriods();
    expect(again.shredded.map((s) => s.period)).toEqual([OCT]);
    const sept = await keyRow("SWEEPSEPT", SEPT);
    expect(sept.shredded_at?.toISOString()).toBe(due.toISOString());

    // The instant is the SWEEP's, not the row's own expiry, and this is the
    // only place that can tell: October expired on 2026-11-08 and is swept
    // three weeks later. In the test above the two instants are the same
    // value, so `set shredded_at = k.expires_at` passed the entire suite --
    // measured, as a surviving mutant, not supposed. A compliance record that
    // took the expiry would say a month swept six months late became
    // unreadable the day it became eligible, which is a false date on the one
    // record this table exists to produce.
    const oct = await keyRow("SWEEPOCT", OCT);
    expect(oct.expires_at.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(oct.shredded_at?.toISOString()).toBe(late);
  });

  // Every other sweep in this block shreds exactly ONE row, and review showed
  // what that costs. Two mutants passed all 368 tests against it: reporting
  // only `swept.rows.slice(0, 1)`, and deciding one flag for the whole batch
  // with `rows.some(r => r.erased)` instead of per row. Both are the mixed
  // batch M4's nightly run actually sees, and neither could be seen while
  // every batch had one element and one kind.
  //
  // So: four months across three namespaces, two live and one erased on
  // request, all past their grace at one instant. The full list is asserted
  // -- every row, in order, with its own flag -- because a sweep that shreds
  // four and reports one is the failure that matters here. M4 writes its
  // audit row from this array and the store is the only thing that can tell
  // it what was shredded.
  it("reports every row of a mixed batch, each with its own flag", async () => {
    const mint = at("2027-09-10T00:00:00.000Z");
    await mint.observations.append(anEvent("BATCHLIVE1", "op:batch:1"));
    await mint.observations.append(anEvent("BATCHLIVE2", "op:batch:2"));
    await mint.observations.append(anEvent("BATCHERASED", "op:batch:3"));
    // A second month for one of them, so the batch is not one row per
    // namespace either.
    await at("2027-10-10T00:00:00.000Z").observations.append(anEvent("BATCHLIVE1", "op:batch:4"));
    const erased = await idOf("BATCHERASED");
    await at("2027-11-01T00:00:00.000Z").namespaces.shred(erased);

    const live1 = await idOf("BATCHLIVE1");
    const live2 = await idOf("BATCHLIVE2");
    // 2027-10 expires 2027-11-08, the last of the four.
    const swept = await at("2027-11-20T00:00:00.000Z").namespaces.expirePeriods();
    const expected = [
      { namespaceId: live1, period: "2027-09-01", namespaceErasedAtSweep: false },
      { namespaceId: live1, period: "2027-10-01", namespaceErasedAtSweep: false },
      { namespaceId: live2, period: "2027-09-01", namespaceErasedAtSweep: false },
      { namespaceId: erased, period: "2027-09-01", namespaceErasedAtSweep: true },
    ].sort((a, b) => (a.namespaceId === b.namespaceId
      ? a.period.localeCompare(b.period)
      : a.namespaceId.localeCompare(b.namespaceId)));
    // The order is the repository's, not the heap's: review measured the
    // unsorted return to be insertion-interleaved and free to move across a
    // vacuum, which would make an M4 audit body unreproducible.
    expect(swept.shredded).toEqual(expected);
  });

  // R18's structural correction, and the finding that changed the shape of
  // what this method returns. A month whose grace ran out BEFORE its
  // namespace was erased -- a sweep that did not run, then an erasure
  // request -- is past grace by the policy's clock AND under an erased
  // namespace. Under the discriminated `reason` this shipped with, it came
  // back as `erased-namespace` and disappeared from the retention count,
  // which is exactly the outage someone reads that count to find. The two
  // facts are not alternatives: every row this sweep returns is past its
  // grace, and the flag says which of them also belonged to an erased
  // namespace.
  it("counts a month whose grace ran before the erasure as both", async () => {
    await at("2027-01-05T00:00:00.000Z").observations.append(anEvent("SWEEPLATE", "op:sweep:late"));
    const ns = await idOf("SWEEPLATE");
    // January 2027 expires 2027-02-08. The erasure request is three weeks
    // after that, and the sweep a day later still.
    await at("2027-03-01T00:00:00.000Z").namespaces.shred(ns);
    const swept = await at("2027-03-02T00:00:00.000Z").namespaces.expirePeriods();
    expect(swept.shredded).toEqual([
      { namespaceId: ns, period: "2027-01-01", namespaceErasedAtSweep: true },
    ]);
  });

  // The sweep's period rendering, held the way every other read of this
  // column is. `period::text` renders through the server's DateStyle -- the
  // same date is 2026-09-01 under ISO and 01.09.2026 under German -- and the
  // connection pins ISO, so the two forms agree and `::text` here survived
  // every assertion above as an equivalent mutant. It is not equivalent under
  // a session that sets its own style, and M4's audit rows are keyed on this
  // string.
  //
  // The month is minted OUTSIDE this transaction on purpose: under German the
  // driver cannot parse the timestamptz the mint reads back, so minting here
  // would fail on a mechanism other than the one under test.
  it("renders the swept period independently of the server's DateStyle", async () => {
    const mar = at("2028-03-05T00:00:00.000Z");
    await mar.observations.append(anEvent("SWEEPSTYLE", "op:sweep:style"));
    const ROLLBACK = Symbol("rollback");
    let swept: { period: string }[] = [];
    await sdb.transaction().execute(async (trx) => {
      await sql.raw("set local datestyle = 'German'").execute(trx);
      const inside = new NamespaceRepository(trx, ring, fixedClock(new Date("2028-07-01T00:00:00.000Z")), grace7);
      swept = (await inside.expirePeriods()).shredded;
      throw ROLLBACK;
    }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
    expect(swept.map((s) => s.period)).toEqual(["2028-03-01"]);
  });

  // R18. A namespace erased on request keeps its month keys, and the sweep
  // reaches them rather than filtering them: sweeping puts those past-grace
  // months under the same two dead keys a live namespace's expired months
  // get, where a filter would leave them under one.
  //
  // The flag is measured here; what it is FOR is measured two tests above,
  // where a live and an erased namespace are swept in the same statement.
  // This test's second assertion used to be `every(r => r.reason === ...)`
  // under a comment about "a live namespace swept in the same statement" --
  // and there is no live namespace in this sweep, so the comment described a
  // fixture nobody had written and the assertion restated the line above it.
  // Review caught that by hard-coding the flag and watching this test stay
  // green.
  it("sweeps the months of an erased namespace, and flags them", async () => {
    const jan = at("2027-01-05T00:00:00.000Z");
    await jan.observations.append(anEvent("SWEEPERASED", "op:sweep:erased"));
    const ns = await idOf("SWEEPERASED");
    await jan.namespaces.shred(ns);

    const swept = await at("2027-05-01T00:00:00.000Z").namespaces.expirePeriods();
    expect(swept.shredded).toEqual([
      { namespaceId: ns, period: "2027-01-01", namespaceErasedAtSweep: true },
    ]);
  });

  it("lets the namespace's erasure win over the month's on a namespace that is both", async () => {
    const ns = await idOf("SWEEPERASED");
    // The precondition this test used not to check, and review found it
    // green against a sweep that did nothing at all: the month must actually
    // have been shredded BY the sweep, or this is only re-measuring the
    // pre-existing "says shredded, not expired" test one describe above.
    expect((await keyRow("SWEEPERASED", "2027-01-01")).shredded_at?.toISOString())
      .toBe("2027-05-01T00:00:00.000Z");
    const both = at("2027-05-01T00:00:00.000Z");
    // Both erasures have happened to this pair. An operator told the month
    // expired would go looking for a retention sweep instead of the erasure
    // request that actually happened, so the outer refusal wins.
    await expect(both.namespaces.openPeriodKey(ns, "2027-01-01"))
      .rejects.toBeInstanceOf(NamespaceShredded);
  });

  it("still erases a namespace on request after its months have been swept", async () => {
    // The risk this holds: a shred that now has to cross rows the sweep
    // already wrote. `shred` touches `namespace` alone and the month rows are
    // already consistent, so it stays the single statement it was -- but the
    // guard on namespace_key is the kind of thing that turns a one-statement
    // erasure into a refusal, and a refused erasure request is the worst
    // failure this table has.
    const ns = await idOf("SWEEPSEPT");
    // The precondition, for the reason the test above now states one: review
    // ran this against a sweep replaced by `return { shredded: [] }` and it
    // stayed green, so it was measuring `shred` alone and none of the risk
    // its own comment names.
    expect((await keyRow("SWEEPSEPT", SEPT)).shredded_at?.toISOString()).toBe(due.toISOString());
    await at("2027-06-01T00:00:00.000Z").namespaces.shred(ns);
    const row = await sdb.selectFrom("namespace").select(["data_key_wrapped", "key_shredded_at"])
      .where("namespace_id", "=", ns).executeTakeFirstOrThrow();
    expect(row.data_key_wrapped).toBeNull();
    expect(row.key_shredded_at?.toISOString()).toBe("2027-06-01T00:00:00.000Z");
  });

  // Named for what it holds rather than for what it does: there is no line
  // in the sweep whose removal breaks `chain.verify()`, because the statement
  // touches `namespace_key` alone. What this test actually pins is that the
  // sweep leaves the audit table untouched while shredding something, which
  // is worth pinning and is not what the old name promised.
  it("shreds while leaving every audit entry and the chain's seals alone", async () => {
    const chain = new AuditChain(sdb, fixedClock(new Date("2027-08-08T00:00:00.000Z")), ring);
    await chain.append({ policyVersion: "retention-v0", kind: "observation.appended", body: { n: 1 } });
    await chain.append({ policyVersion: "retention-v0", kind: "observation.appended", body: { n: 2 } });
    // A month of its own, because every month minted above has already been
    // swept by now: without this the sweep below returns nothing and the
    // assertion that it reached something would be the only thing failing.
    await at("2027-08-08T00:00:00.000Z").observations.append(anEvent("SWEEPCHAIN", "op:sweep:chain"));
    // The whole table before the sweep, so that "alone" can mean the same
    // rows and not merely "some rows". `toBeGreaterThan(0)` was what stood
    // here, and it accepts a row the sweep wrote itself: an
    // `AuditChain.append` planted at the top of `expirePeriods` survived all
    // 463 tests but one, and that one went red for an unrelated reason.
    const before = await sdb.selectFrom("audit_entry")
      .select(["seq", "kind", "entry_sha256"]).orderBy("seq").execute();
    const swept = await at("2028-01-01T00:00:00.000Z").namespaces.expirePeriods();
    // Non-vacuous in both directions: the chain has entries, and the sweep
    // reached something. A verify() over an empty chain is ok and proves
    // nothing.
    expect(swept.shredded.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
    const after = await sdb.selectFrom("audit_entry")
      .select(["seq", "kind", "entry_sha256"]).orderBy("seq").execute();
    expect(after).toEqual(before);
    expect(await chain.verify()).toEqual({ ok: true });
  });
});
