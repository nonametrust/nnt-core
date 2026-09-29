import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Deadlocked,
  fixedClock,
  keyRingFromEnv,
  migrate,
  openDb,
  RETENTION_V0,
  type Db,
} from "@nonametrust/store";
import { compose, type Composed } from "./compose.js";
import {
  EngineTimeout,
  classifyStoreFailure,
  isRetryable,
  withStoreTimeout,
} from "./availability.js";

// G15: each unavailable condition produces its code **with the store really
// unreachable rather than stubbed** — the plan's words, and the reason this file
// exists beside `availability.test.ts`.
//
// A stub that throws `new Error("ECONNREFUSED")` proves the classification reads a
// field. It does not prove that the field is what the driver really sets, and this
// task's whole risk is that the shapes are guessed. Every row below produces its
// condition against the real cluster and then asks `classifyStoreFailure` what it is.
//
// WHAT THIS MEASURED THAT THE PLAN DID NOT KNOW. R7 says "Unavailable is: a driver
// error carrying no SQLSTATE, `Cancelled` (55P03/57014), and a timeout the engine
// sets itself". On the brief's READ path `Cancelled` never arrives: `listLive` and
// `readClear` contain no `mapPgError`, so a lock timeout comes back as a raw
// `DatabaseError` carrying `code: "55P03"`. The rows below pin that, because a
// classification matched only on the mapped class would hold on the write path alone.

const SCHEMA = "engine_availability_test";
const MIGRATIONS = fileURLToPath(new URL("../../store/migrations/", import.meta.url));
const AT = new Date("2026-09-21T00:00:00.000Z");

const ring = keyRingFromEnv({
  NNT_MASTER_KEY: randomBytes(32).toString("base64"),
} as NodeJS.ProcessEnv);

let db: Db;
let composed: Composed;
let base: string;

function requireBaseUrl(): string {
  const url = process.env.NNT_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "NNT_TEST_DATABASE_URL is not set. This suite fails rather than skips, on purpose: " +
        "an unavailability gate that skips is green on every machine that cannot run it.",
    );
  }
  return url;
}

const urlFor = (schema: string, extra = ""): string =>
  `${base}${base.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}${extra}`;

beforeAll(async () => {
  base = requireBaseUrl();
  const admin = openDb(base);
  await admin.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
  await admin.schema.createSchema(SCHEMA).execute();
  await admin.destroy();

  db = openDb(urlFor(SCHEMA));
  await migrate(db, MIGRATIONS);
  composed = compose(db, fixedClock(AT), ring, RETENTION_V0);
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await db.destroy();
    const cleanup = openDb(base);
    await cleanup.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
    await cleanup.destroy();
  }
});

/** Rolled back by a sentinel, so the lock is released and the schema is untouched. */
class ReleaseLock extends Error {}

/**
 * Runs `body` while `tag` is held under an ACCESS EXCLUSIVE lock by another session.
 *
 * `alterTable ... addColumn` is what takes that lock. `createIndex` was the first
 * attempt and it takes only SHARE, which blocks writes and NOT reads -- so the row
 * that was supposed to measure a blocked SELECT measured a SELECT that sailed
 * through. The transaction is always rolled back, so the column never exists.
 */
async function withTagLocked<T>(body: () => Promise<T>): Promise<T> {
  let out: T;
  try {
    await db.transaction().execute(async (trx) => {
      await trx.schema.alterTable("tag").addColumn("t7_lock_probe", "integer").execute();
      out = await body();
      throw new ReleaseLock();
    });
  } catch (e) {
    if (!(e instanceof ReleaseLock)) throw e;
  }
  return out!;
}

/** The error a call really raised, or a marker that it did not raise one. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return { didNotFail: true };
  } catch (e) {
    return e;
  }
}

describe("G15, condition one: a port nothing listens on", () => {
  it("is classified as a connection outage, from a REAL refused connection", async () => {
    // Port 1 is reserved and nothing binds it. The driver fails before any SQL is
    // sent, so nothing maps the error and it arrives as a plain `Error`.
    const dead = openDb("postgres://nnt@127.0.0.1:1/nnt_test");
    const composedDead = compose(dead, fixedClock(AT), ring, RETENTION_V0);
    const e = await failureOf(() => composedDead.tags.listLive("11111111-0000-4000-8000-000000000001"));
    await dead.destroy();

    expect(e, "the connection succeeded, so this measured nothing").not.toHaveProperty(
      "didNotFail",
    );
    expect((e as { code?: string }).code, "the driver's own code, recorded").toBe("ECONNREFUSED");
    expect(classifyStoreFailure(e)).toBe("connection");
    expect(isRetryable(e), "an outage is the tiered policy's business, not a retry's").toBe(false);
  }, 30_000);

  it("is a connection outage through a WRITE path too, which does map its errors", async () => {
    const dead = openDb("postgres://nnt@127.0.0.1:1/nnt_test");
    const composedDead = compose(dead, fixedClock(AT), ring, RETENTION_V0);
    const e = await failureOf(() =>
      composedDead.audit.append({ policyVersion: "a/b/c/d", kind: "brief", body: {} }),
    );
    await dead.destroy();
    expect(classifyStoreFailure(e)).toBe("connection");
  }, 30_000);
});

describe("G15, condition two: a statement the server cancels", () => {
  it("arrives RAW on the brief's read path and is still classified as cancelled", async () => {
    // A 50ms `lock_timeout` on one session, an ACCESS EXCLUSIVE lock held by another.
    // This is the exact path the brief uses, and it is the one that does NOT map.
    const slow = openDb(urlFor(SCHEMA, "%20-c%20lock_timeout%3D50"));
    const blocked = compose(slow, fixedClock(AT), ring, RETENTION_V0);

    const e = await withTagLocked(() =>
      failureOf(() => blocked.tags.listLive("11111111-0000-4000-8000-000000000001")),
    );
    await slow.destroy();

    expect(e, "no failure: the lock did not block the read").not.toHaveProperty("didNotFail");
    expect((e as { code?: string }).code, "the raw sqlstate, unmapped").toBe("55P03");
    expect(
      (e as object) instanceof Deadlocked,
      "a lock timeout is not a deadlock and must not be retried as one",
    ).toBe(false);
    expect(classifyStoreFailure(e)).toBe("cancelled");
    expect(isRetryable(e)).toBe(false);
  }, 30_000);

  it("leaves the store usable afterwards, so the outage is the statement's and not the pool's", async () => {
    const rows = await composed.tags.listLive("11111111-0000-4000-8000-000000000001");
    expect(rows).toEqual([]);
  });
});

describe("G15, condition three: a timeout the engine sets itself", () => {
  it("fires on a REAL store call that is really blocked", async () => {
    // A session with NO `lock_timeout`, reading a table another session holds under
    // ACCESS EXCLUSIVE: the call hangs for as long as the lock is held, and the server
    // is perfectly healthy the whole time. That is the one condition the store cannot
    // report -- there is no error to map, because nothing failed. The only evidence it
    // happened is that the engine stopped waiting.
    //
    // This goes through `TagRepository.listLive`, the brief's own read, rather than a
    // contrived slow query.
    const patient = openDb(urlFor(SCHEMA));
    const waiting = compose(patient, fixedClock(AT), ring, RETENTION_V0);

    const e = await withTagLocked(() =>
      failureOf(() =>
        withStoreTimeout(
          () => waiting.tags.listLive("11111111-0000-4000-8000-000000000001"),
          150,
          "listLive",
        ),
      ),
    );
    await patient.destroy();

    expect(e).toBeInstanceOf(EngineTimeout);
    expect((e as Error).message).toMatch(/listLive did not answer within 150ms/);
    expect(classifyStoreFailure(e)).toBe("engine_timeout");
    expect(isRetryable(e)).toBe(false);
  }, 30_000);

  it("does NOT fire on a real call that answers inside its budget", async () => {
    // The control. A timeout that fired on everything would satisfy the row above
    // without measuring anything.
    await expect(
      withStoreTimeout(() => composed.tags.listLive("11111111-0000-4000-8000-000000000001"), 10_000, "listLive"),
    ).resolves.toEqual([]);
  }, 30_000);
});

describe("R7: a DEADLOCK is not one of the three, measured on a real one", () => {
  it("is raised as Deadlocked, retried, and never classified as unavailable", async () => {
    // Two transactions taking the same two rows in opposite orders. Postgres kills one
    // with 40P01, which the store maps to `Deadlocked` on a mapping path -- and this
    // is the ruling the first version of the plan got backwards.
    await db.schema
      .createTable("t7_deadlock")
      .ifNotExists()
      .addColumn("id", "integer", (c) => c.primaryKey())
      .execute();
    await db.deleteFrom("t7_deadlock" as never).execute();
    await db.insertInto("t7_deadlock" as never).values([{ id: 1 }, { id: 2 }] as never).execute();

    const a = openDb(urlFor(SCHEMA));
    const b = openDb(urlFor(SCHEMA));
    const held = { first: false };
    const failures: unknown[] = [];

    const take = async (handle: Db, first: number, second: number): Promise<void> => {
      await handle.transaction().execute(async (trx) => {
        await trx
          .updateTable("t7_deadlock" as never)
          .set({ id: first } as never)
          .where("id" as never, "=", first as never)
          .execute();
        held.first = true;
        await new Promise((r) => setTimeout(r, 150));
        await trx
          .updateTable("t7_deadlock" as never)
          .set({ id: second } as never)
          .where("id" as never, "=", second as never)
          .execute();
      });
    };

    const results = await Promise.allSettled([take(a, 1, 2), take(b, 2, 1)]);
    for (const r of results) if (r.status === "rejected") failures.push(r.reason);
    await a.destroy();
    await b.destroy();
    await db.schema.dropTable("t7_deadlock").ifExists().execute();

    expect(failures.length, "no deadlock occurred, so this row measured nothing").toBe(1);
    const e = failures[0];
    expect((e as { code?: string }).code ?? (e as { sqlstate?: string }).sqlstate).toBe("40P01");
    // THE REAL DEADLOCK ARRIVES RAW, measured: `DatabaseError`, and
    // `instanceof Deadlocked` is FALSE. The update path does not map either, so on
    // every path this engine actually uses, the mapped class never appears -- the raw
    // SQLSTATE branch is what does all the work.
    //
    // This is why the plan's G15 plant ("`Deadlocked` added to the set") had to be
    // planted in BOTH forms: mutating the mapped class left this row green, because
    // the mapped class is not what a real deadlock produces.
    expect(e).not.toBeInstanceOf(Deadlocked);
    expect((e as object).constructor.name).toBe("DatabaseError");
    expect(
      classifyStoreFailure(e),
      "a deadlock classified as unavailable is R7's own failure",
    ).toBeNull();
    expect(isRetryable(e), "40P01 is why a caller can tell a deadlock from a constraint and RETRY").toBe(true);
  }, 60_000);
});
