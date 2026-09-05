import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "./db.js";
import { migrate } from "./migrate.js";
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

  it("holds no advisory lock once it has returned, so the next runner is not blocked", async () => {
    // Failure here would also look like a hang in the test above, so the
    // check is direct: no session in this database still holds the key.
    const held = await sql<{ n: string }>`
      select count(*)::text as n from pg_locks
      where locktype = 'advisory' and objid = 81402026 and database = (
        select oid from pg_database where datname = current_database()
      )
    `.execute(db);
    expect(held.rows[0]?.n).toBe("0");
  });

  it("refuses to run when an applied file's content has changed", async () => {
    put("0001_a.sql", "create table a (id int); -- edited");
    await expect(migrate(db, dir)).rejects.toBeInstanceOf(MigrationDrift);
    put("0001_a.sql", "create table a (id int);");
  });

  it("records the sha256 of each file it applied", async () => {
    const row = await db
      .selectFrom("schema_migration")
      .selectAll()
      .where("filename", "=", "0002_b.sql")
      .executeTakeFirstOrThrow();
    const expected = createHash("sha256").update("create table b (id int);").digest("hex");
    expect(row.sha256).toBe(expected);
  });

  it("leaves nothing recorded when a file fails, so a half-applied file is not marked done", async () => {
    put("0003_bad.sql", "this is not sql;");
    await expect(migrate(db, dir)).rejects.toThrow();
    const row = await db
      .selectFrom("schema_migration")
      .selectAll()
      .where("filename", "=", "0003_bad.sql")
      .executeTakeFirst();
    expect(row).toBeUndefined();
    rmSync(join(dir, "0003_bad.sql"));
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
