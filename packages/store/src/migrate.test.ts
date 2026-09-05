import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "./db.js";
import { LOCK_KEY, migrate } from "./migrate.js";
import { MigrationDrift } from "./errors.js";
import { requireTestUrl, urlForSchema } from "./testing/harness.js";

// A store suite without a database fails. It does not skip. A suite that skips
// itself reports green while enforcing nothing, which is the exact false green
// this project has now found in three separate places.
const url = requireTestUrl();

let db: Db;
let dir: string;

// The test's own schema arrives through the connection string, so that the
// runner's `schema_migration` table lands inside it and the drop in afterAll
// takes the ledger with the tables. Were the ledger left in the default search
// path, the temp filenames below (which repeat every run) would already be
// recorded on the second run and the first assertion would fail: green once,
// red forever after. The drop in beforeAll makes a run that crashed mid-way
// harmless too; nothing here depends on teardown having happened.
const schemaName = "migrate_test";

beforeAll(async () => {
  const admin = openDb(url);
  await sql.raw(`drop schema if exists ${schemaName} cascade`).execute(admin);
  await sql.raw(`create schema ${schemaName}`).execute(admin);
  await admin.destroy();
  db = openDb(urlForSchema(url, schemaName));
  dir = mkdtempSync(join(tmpdir(), "nnt-migrations-"));
});

afterAll(async () => {
  await db.destroy();
  const cleanup = openDb(url);
  await sql.raw(`drop schema if exists ${schemaName} cascade`).execute(cleanup);
  await cleanup.destroy();
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, "utf8");
}

async function tableExists(name: string): Promise<boolean> {
  const r = await sql<{ t: string | null }>`select to_regclass(${name})::text as t`.execute(db);
  return r.rows[0]?.t != null;
}

async function recordFor(filename: string) {
  return db.selectFrom("schema_migration").selectAll().where("filename", "=", filename).executeTakeFirst();
}

describe("migrate", () => {
  it("applies files in filename order and reports what it applied", async () => {
    put("0001_a.sql", "create table a (id int);");
    put("0002_b.sql", "create table b (id int);");
    const applied = await migrate(db, dir);
    expect(applied).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("applies nothing on a second run", async () => {
    const applied = await migrate(db, dir);
    expect(applied).toEqual([]);
  });

  it("waits on LOCK_KEY while another session holds it, and holds nothing once it has returned", async () => {
    // Two halves, each of which fails on its own. If the runner locked under
    // some other key it would finish while this session still holds LOCK_KEY;
    // if it never unlocked, a lock would survive its return. The key is the
    // runner's own export, so the test cannot drift onto a stale copy of it.
    const admin = openDb(url);
    try {
      await admin.connection().execute(async (holder) => {
        await sql`select pg_advisory_lock(${LOCK_KEY})`.execute(holder);
        let settled = false;
        const run = migrate(db, dir).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(settled, "migrate returned while another session held LOCK_KEY").toBe(false);
        await sql`select pg_advisory_unlock(${LOCK_KEY})`.execute(holder);
        expect(await run).toEqual([]);
      });
      const held = await sql<{ n: string }>`
        select count(*)::text as n from pg_locks
        where locktype = 'advisory' and objid = ${LOCK_KEY} and database = (
          select oid from pg_database where datname = current_database()
        )
      `.execute(db);
      expect(held.rows[0]?.n).toBe("0");
    } finally {
      await admin.destroy();
    }
  });

  it("refuses the whole run when any recorded file has changed, applying nothing new first", async () => {
    // The new file sorts before the edited one. Drift checked file by file
    // would apply it and then stop, leaving a fresh entry on a ledger that is
    // already wrong.
    put("0002_a_new.sql", "create table a_new (id int);");
    put("0002_b.sql", "create table b (id int); -- edited");
    await expect(migrate(db, dir)).rejects.toBeInstanceOf(MigrationDrift);
    expect(await recordFor("0002_a_new.sql")).toBeUndefined();
    expect(await tableExists("a_new")).toBe(false);
    put("0002_b.sql", "create table b (id int);");
    rmSync(join(dir, "0002_a_new.sql"));
  });

  it("records the sha256 of each file it applied", async () => {
    const row = await recordFor("0002_b.sql");
    const expected = createHash("sha256").update("create table b (id int);").digest("hex");
    expect(row?.sha256).toBe(expected);
  });

  it("leaves nothing recorded when a file does not parse", async () => {
    put("0003_bad.sql", "this is not sql;");
    await expect(migrate(db, dir)).rejects.toThrow();
    expect(await recordFor("0003_bad.sql")).toBeUndefined();
    rmSync(join(dir, "0003_bad.sql"));
  });

  it("rolls the file back when its record cannot be written, so nothing is half-applied", async () => {
    // Within one file nothing can half-apply on its own: Postgres parses the
    // whole file before running any of it, and runs a multi-statement simple
    // query as one implicit transaction. The gap the explicit transaction
    // closes is between the file and its ledger record, so the fixture is a
    // file that succeeds and then makes its own record fail: it forges a
    // ledger row under its own name and the runner's insert collides with it.
    put(
      "0003_half.sql",
      "create table half (id int);\n" +
        "insert into schema_migration (filename, sha256) values ('0003_half.sql', 'forged');",
    );
    await expect(migrate(db, dir)).rejects.toThrow();
    expect(await tableExists("half")).toBe(false);
    expect(await recordFor("0003_half.sql")).toBeUndefined();
    rmSync(join(dir, "0003_half.sql"));
  });

  it("applies a file holding a table and a $$-quoted function together, unsplit", async () => {
    // Later migrations put plpgsql trigger bodies beside create table in one
    // file. Multi-statement text needs the simple query protocol; had the
    // query builder used the extended one, this would fail with what reads
    // like an ordinary syntax error. The semicolons inside $$ are not
    // statement boundaries, which is also why the runner never splits.
    put(
      "0004_fn.sql",
      [
        "create table c (id int, n int);",
        "create function c_guard() returns trigger language plpgsql as $$",
        "begin",
        "  if new.n < 0 then raise exception 'negative'; end if;",
        "  return new;",
        "end",
        "$$;",
        "create trigger c_guard before insert on c for each row execute function c_guard();",
      ].join("\n"),
    );
    expect(await migrate(db, dir)).toEqual(["0004_fn.sql"]);
    await sql.raw("insert into c values (1, 1)").execute(db);
    await expect(sql.raw("insert into c values (2, -1)").execute(db)).rejects.toThrow(/negative/);
  });
});
