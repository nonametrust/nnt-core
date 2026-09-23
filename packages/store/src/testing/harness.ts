import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { openDb, type Db } from "../db.js";
import { migrate } from "../migrate.js";
import type { Observation } from "@nonametrust/schema";
import type { AppendResult } from "../repositories/observation.js";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

export function requireTestUrl(): string {
  const url = process.env.NNT_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "NNT_TEST_DATABASE_URL is not set. Run `pnpm --filter @nonametrust/store db:up` " +
        "and export what it prints. The store suite fails rather than skips, on purpose.",
    );
  }
  return url;
}

/**
 * The connection string for `base`, with every session it opens confined to
 * `schema`. The schema name goes into the connection string rather than being
 * set with `set search_path`, because the driver pools connections and a
 * session setting applies to one of them.
 */
export function urlForSchema(base: string, schema: string): string {
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}options=-c%20search_path%3D${schema}`;
}

/**
 * A private schema per test file, with every migration applied into it and
 * dropped afterwards. Isolation is a fresh schema rather than TRUNCATE,
 * because TRUNCATE bypasses row triggers and would let a test reach a state
 * production cannot.
 */
export async function withSchema(name: string): Promise<{ db: Db; done: () => Promise<void> }> {
  const base = requireTestUrl();
  const admin = openDb(base);
  await sql.raw(`drop schema if exists ${name} cascade`).execute(admin);
  await sql.raw(`create schema ${name}`).execute(admin);
  await admin.destroy();

  const db = openDb(urlForSchema(base, name));
  await migrate(db, MIGRATIONS);

  return {
    db,
    done: async () => {
      await db.destroy();
      const cleanup = openDb(base);
      await sql.raw(`drop schema if exists ${name} cascade`).execute(cleanup);
      await cleanup.destroy();
    },
  };
}

/**
 * Removes this suite's leftover temp directories, by prefix, and returns how
 * many it took. Called on ENTRY rather than relied on at teardown, for the
 * same reason `withSchema` drops its schema on entry: an ordinary failure
 * runs afterAll, a SIGKILL does not, and the directories then accumulate one
 * per killed run. Measured: eight had built up before this existed.
 */
export function sweepTempDirs(prefix: string): number {
  const stale = readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));
  for (const name of stale) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  return stale.length;
}

/**
 * The observation an append result carries, or a throw naming the shape that
 * came back instead.
 *
 * `AppendResult` became a union in Task 8 (R19): an append can answer that a
 * row exists and cannot be opened, and such a result carries no observation.
 * A test that reaches for `.observation` is asserting the append stored one
 * or could read one back, so that assertion is made here, once, and fails
 * with the two flags rather than with `undefined is not an object` wherever
 * the value is first used.
 */
export function storedObservation(result: AppendResult): Observation {
  if (result.created) return result.observation;
  if (result.readable) return result.observation;
  throw new Error(
    `append answered unreadable for observation ${result.observationId}: ` +
      `periodExpired=${result.periodExpired}, namespaceErased=${result.namespaceErased}`,
  );
}
