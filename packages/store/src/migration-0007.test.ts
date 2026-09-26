import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { requireTestUrl, sweepTempDirs, urlForSchema } from "./testing/harness.js";

const url = requireTestUrl();
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const schemaName = "migration_0007_test";
const PREFIX = "nnt-0007-";

let db: Db;
let dir: string;

beforeAll(async () => {
  const admin = openDb(url);
  await sql.raw(`drop schema if exists ${schemaName} cascade`).execute(admin);
  await sql.raw(`create schema ${schemaName}`).execute(admin);
  await admin.destroy();
  db = openDb(urlForSchema(url, schemaName));
  // Sweep this file's own leftovers before making a new one. afterAll removes
  // the directory on any ordinary failure, but a SIGKILL leaves it behind and
  // they accumulate; the schema harness drops on ENTRY for the same reason,
  // so nothing depends on teardown having happened.
  sweepTempDirs(PREFIX);
  dir = mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`));
});

afterAll(async () => {
  await db.destroy();
  const cleanup = openDb(url);
  await sql.raw(`drop schema if exists ${schemaName} cascade`).execute(cleanup);
  await cleanup.destroy();
  rmSync(dir, { recursive: true, force: true });
});

// The real migration files, not fixtures: what is under test is this
// migration's own preamble, so a hand-written stand-in would prove nothing
// about the file that ships.
function copyMigrations(upTo: string): string[] {
  const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
  const wanted = names.filter((n) => n <= upTo);
  for (const n of wanted) copyFileSync(join(MIGRATIONS, n), join(dir, n));
  return wanted;
}

async function recordFor(filename: string): Promise<{ filename: string } | undefined> {
  return await db.selectFrom("schema_migration").select(["filename"])
    .where("filename", "=", filename).executeTakeFirst();
}

// 0007 moves the byte layout of the payload envelope: `producer` and
// `ingested_at` go inside it. A payload sealed under the old layout does not
// open under the new one, and it does not fail loudly at migration time -- it
// fails at the first read, far away, as a CiphertextRejected that names a
// tamper rather than a migration.
//
// Nothing is deployed, so this refusal never fires today. That is exactly why
// it is worth a test: "nothing is deployed" is a belief about the world, and
// the preamble is the one place that turns it into something the database
// checks. Without this test the preamble is a comment with a `do` block
// around it -- it was added, the whole suite stayed green with it deleted,
// and that is how this test came to exist.
describe("0007 over stored observations", () => {
  it("refuses to run, and records nothing, when an observation already exists", async () => {
    const applied = copyMigrations("0006_baseline_trigger_volatility_window.sql");
    expect(applied).toHaveLength(6);
    await migrate(db, dir);

    const namespaceId = randomUUID();
    await sql`
      insert into namespace (namespace_id, kind, ns_id, data_key_wrapped, key_shredded_at, created_at)
      values (${namespaceId}, 'wallet', 'PREEXISTING', ${Buffer.alloc(61)}, null, now())
    `.execute(db);
    // A row in the shape 0002 defines, which is the shape a deployed table
    // would hold: no producer column, and a payload sealed under the six-part
    // envelope that no longer exists.
    await sql`
      insert into observation (
        observation_id, idempotency_key, namespace_id, channel, kind, evidence_kind,
        dated_at, ingested_at, payload_nonce, payload_tag, payload_ciphertext
      ) values (
        ${randomUUID()}, ${randomUUID()}, ${namespaceId}, 'volume', 'payment', 'event',
        now(), now(), decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex')
      )
    `.execute(db);

    const seventh = "0007_retention_aspect_and_baseline_shape.sql";
    copyFileSync(join(MIGRATIONS, seventh), join(dir, seventh));

    // The message is asserted, not only the rejection: any broken migration
    // would also throw, and this must be the preamble's own refusal saying a
    // re-encryption is a separate migration.
    await expect(migrate(db, dir)).rejects.toThrow(/re-keys the payload envelope/);
    expect(await recordFor(seventh)).toBeUndefined();
    // And it refused before applying any of its own sections.
    const aspect = await sql<{ n: number }>`
      select count(*)::int as n from information_schema.columns
      where table_schema = ${schemaName} and table_name = 'tag' and column_name = 'aspect'
    `.execute(db);
    expect(aspect.rows[0]?.n).toBe(0);
  });

  // The other half of the rule, and it needs its own schema: observation is
  // append-only and refuses a DELETE, so an emptied table is not a state this
  // database can be walked back into. A fresh schema is what a deployment
  // actually is.
  //
  // Without this half, a preamble that refused unconditionally would still
  // pass the test above. And the namespace row is what keys the refusal to
  // the right table: with only an observation present in the test above, a
  // preamble reading `select 1 from namespace` refuses identically, and
  // review found that mutant alive. A namespace with no observation is
  // reachable in ordinary use -- `ensure` runs before an insert that then
  // fails -- so a deployment in that state must still migrate.
  it("runs over an empty observation table, even with other rows present", async () => {
    const fresh = `${schemaName}_fresh`;
    const freshDir = mkdtempSync(join(tmpdir(), `${PREFIX}fresh-`));
    const admin = openDb(url);
    await sql.raw(`drop schema if exists ${fresh} cascade`).execute(admin);
    await sql.raw(`create schema ${fresh}`).execute(admin);
    await admin.destroy();
    const freshDb = openDb(urlForSchema(url, fresh));
    try {
      const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
      const seventh = "0007_retention_aspect_and_baseline_shape.sql";
      for (const n of names.filter((n) => n < seventh)) {
        copyFileSync(join(MIGRATIONS, n), join(freshDir, n));
      }
      await migrate(freshDb, freshDir);
      await sql`
        insert into namespace (namespace_id, kind, ns_id, data_key_wrapped, key_shredded_at, created_at)
        values (${randomUUID()}, 'wallet', 'NOOBSERVATIONS', ${Buffer.alloc(61)}, null, now())
      `.execute(freshDb);

      copyFileSync(join(MIGRATIONS, seventh), join(freshDir, seventh));
      await migrate(freshDb, freshDir);
      const row = await freshDb.selectFrom("schema_migration").select(["filename"])
        .where("filename", "=", seventh).executeTakeFirst();
      expect(row).toBeDefined();

      // Section 8, and the "EVERY trigger function" half of it specifically.
      // The guards read their tables unqualified, so an unpinned one resolves
      // `namespace` through the session's `search_path` -- whose implicit
      // `pg_temp` comes FIRST -- and a temp table of that name answers the
      // gate instead of the real one. Pinning the function 0007 added and
      // leaving `0001`-`0006`'s eight alone would read as done and close
      // nothing, so what is asserted here is that NONE is left unpinned, and
      // that the count is not zero, which is what makes the first half mean
      // anything.
      const fns = await sql<{ name: string; config: string[] | null }>`
        select p.proname as name, p.proconfig as config
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = ${fresh}
           and p.prorettype = 'pg_catalog.trigger'::regtype
         order by p.proname`.execute(freshDb);
      expect(fns.rows.length).toBeGreaterThanOrEqual(9);
      const unpinned = fns.rows.filter(
        (f) => !(f.config ?? []).some((c) => c.startsWith("search_path=")),
      );
      expect(unpinned.map((f) => f.name)).toEqual([]);
      // And `pg_temp` is named LAST rather than left out: leaving it out of
      // the list is exactly what puts it first.
      for (const f of fns.rows) {
        const pinned = (f.config ?? []).find((c) => c.startsWith("search_path="))!;
        expect(pinned, f.name).toBe(`search_path=${fresh}, pg_temp`);
      }
    } finally {
      await freshDb.destroy();
      const cleanup = openDb(url);
      await sql.raw(`drop schema if exists ${fresh} cascade`).execute(cleanup);
      await cleanup.destroy();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// A killed run leaves its temp directory behind, so the sweep is what stops
// them accumulating. Held here rather than trusted: the mutant that deletes
// the sweep call leaves the whole suite green.
describe("the suite's own leftovers", () => {
  it("sweeps stale temp directories by prefix, the way a killed run leaves them", () => {
    const stale = join(tmpdir(), `${PREFIX}stale-probe`);
    mkdirSync(stale, { recursive: true });
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length).toBeGreaterThan(0);
    sweepTempDirs(`${PREFIX}stale-probe`);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith(`${PREFIX}stale-probe`))).toEqual([]);
  });
});

// `sweepTempDirs` removes leftovers by PREFIX on entry, and until the branch
// review that was every directory carrying the prefix, with no ownership
// check: two concurrent runs of this file -- two review agents, or a shard --
// deleted each other's LIVE working directory, and the suite could not tell
// the correct behaviour from the broken one. Per-database isolation does not
// cover it, because the temp directory is per MACHINE. The directory name now
// carries the pid that made it and the sweep leaves a living process's
// directory alone.
describe("the temp-directory sweep", () => {
  it("removes a dead run's directory and leaves a living one's alone", () => {
    const probe = `nnt-sweepprobe-${randomUUID().slice(0, 8)}-`;
    // A pid that is certainly gone: a child run to completion.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    expect(dead).toBeGreaterThan(0);
    const mine = join(tmpdir(), `${probe}${process.pid}-live`);
    const theirs = join(tmpdir(), `${probe}${dead}-stale`);
    // A name with no pid at all is a leftover from before this rule, and is
    // swept: otherwise the old directories never go away.
    const nameless = join(tmpdir(), `${probe}leftover`);
    for (const d of [mine, theirs, nameless]) mkdirSync(d, { recursive: true });
    try {
      const swept = sweepTempDirs(probe);
      const left = readdirSync(tmpdir()).filter((n) => n.startsWith(probe));
      expect(left).toEqual([`${probe}${process.pid}-live`]);
      expect(swept).toBe(2);
    } finally {
      for (const d of [mine, theirs, nameless]) rmSync(d, { recursive: true, force: true });
    }
  });
});
