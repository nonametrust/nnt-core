import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { requireTestUrl, urlForSchema } from "./testing/harness.js";

const url = requireTestUrl();
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const schemaName = "migration_0007_test";

let db: Db;
let dir: string;

beforeAll(async () => {
  const admin = openDb(url);
  await sql.raw(`drop schema if exists ${schemaName} cascade`).execute(admin);
  await sql.raw(`create schema ${schemaName}`).execute(admin);
  await admin.destroy();
  db = openDb(urlForSchema(url, schemaName));
  dir = mkdtempSync(join(tmpdir(), "nnt-0007-"));
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
  // pass the test above.
  it("runs over an empty observation table, which is every deployment there is", async () => {
    const fresh = `${schemaName}_fresh`;
    const admin = openDb(url);
    await sql.raw(`drop schema if exists ${fresh} cascade`).execute(admin);
    await sql.raw(`create schema ${fresh}`).execute(admin);
    await admin.destroy();
    const freshDb = openDb(urlForSchema(url, fresh));
    try {
      await migrate(freshDb, MIGRATIONS);
      const row = await freshDb.selectFrom("schema_migration").select(["filename"])
        .where("filename", "=", "0007_retention_aspect_and_baseline_shape.sql").executeTakeFirst();
      expect(row).toBeDefined();
    } finally {
      await freshDb.destroy();
      const cleanup = openDb(url);
      await sql.raw(`drop schema if exists ${fresh} cascade`).execute(cleanup);
      await cleanup.destroy();
    }
  });
});
