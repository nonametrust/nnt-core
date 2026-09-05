import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import type { Db } from "./db.js";
import { MigrationDrift } from "./errors.js";

// One arbitrary but fixed key, so two processes migrating at once serialise
// rather than racing to create the same table.
const LOCK_KEY = 81402026;

/**
 * Applies every unapplied file in `dir`, in filename order, each in its own
 * transaction. Returns the filenames it applied, empty on a second run.
 *
 * A file whose recorded hash no longer matches its content stops the run. An
 * edited migration is a different migration, and finding that out in
 * production is worse than a failed start.
 *
 * A file is sent to the server whole. It is never split on semicolons: a
 * `$$`-quoted function body contains semicolons that are not statement
 * boundaries, and a splitter that gets that wrong fails on exactly the
 * triggers this store depends on.
 */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  // The directory is read before the database is touched. A missing directory
  // is a misconfiguration, and it should fail before a ledger table exists to
  // suggest a migration ever ran.
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  // Everything below runs on one pinned connection. The advisory lock is
  // session-level: taken through the pool, the lock and the unlock could land
  // on different connections, the unlock would be a warning and no-op, and the
  // lock would outlive the run and block the next runner for as long as that
  // connection stayed open.
  return db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(${LOCK_KEY})`.execute(conn);
    try {
      await sql`
        create table if not exists schema_migration (
          filename   text primary key,
          sha256     text not null,
          applied_at timestamptz not null default now()
        )
      `.execute(conn);

      const recorded = new Map(
        (await conn.selectFrom("schema_migration").select(["filename", "sha256"]).execute()).map(
          (r) => [r.filename, r.sha256] as const,
        ),
      );

      const applied: string[] = [];

      for (const filename of files) {
        const body = readFileSync(join(dir, filename), "utf8");
        const digest = createHash("sha256").update(body).digest("hex");
        const seen = recorded.get(filename);
        if (seen !== undefined) {
          if (seen !== digest) {
            throw new MigrationDrift(
              `${filename} was applied with different content (recorded ${seen}, found ${digest}). ` +
                "An edited migration is a different migration; add a new file instead.",
            );
          }
          continue;
        }
        // The file runs first and the record is written second, both under one
        // transaction, so a failing file leaves no record. `applied_at` is the
        // column default: the ledger's timestamp is the database's, and this
        // package reads no wall clock of its own.
        await conn.transaction().execute(async (trx) => {
          await sql.raw(body).execute(trx);
          await trx.insertInto("schema_migration").values({ filename, sha256: digest }).execute();
        });
        applied.push(filename);
      }
      return applied;
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
    }
  });
}
