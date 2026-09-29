import { describe, it, expect } from "vitest";
import { sql } from "kysely";
import { openDb } from "./db.js";
import { requireTestUrl } from "./testing/harness.js";

// `openDb`'s pool, and the one thing about it that is fatal rather than untidy.
//
// Node's EventEmitter RETHROWS an unhandled `'error'` event, and `pg.Pool` emits one
// when the server drops a connection that no query is waiting on. That is not an
// exotic case: it is a restart, a failover, or an administrator running
// `pg_terminate_backend`. Measured before the handler existed, the process died with
//
//   Unhandled 'error' event ... terminating connection due to administrator command
//
// and exit 1.
//
// WHY IT MATTERS MORE THAN A LOG LINE. M3's R7 builds a tiered response to the store
// being unavailable -- low proceeds, medium proceeds under a ceiling, high is refused.
// None of it can run in a process the store has already taken down with it. An
// unavailability policy whose first act is to crash is not a policy.

describe("the pool an open database holds", () => {
  it("SURVIVES the server dropping an idle connection", async () => {
    // The whole test is that this function returns. Without the handler the process
    // does not reach its last line: it dies inside the event loop, and the runner
    // reports the file rather than this row -- which is a red either way, and a loud
    // one.
    const base = requireTestUrl();
    const db = openDb(base);

    // One query, to make the pool open a real connection and learn its backend id.
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
    const pid = rows[0]!.pid;
    expect(pid).toBeGreaterThan(0);

    // The connection goes back to the pool and is now IDLE: nothing is awaiting it, so
    // an error on it belongs to no promise and reaches the emitter instead.
    const killer = openDb(base);
    await sql`select pg_terminate_backend(${pid})`.execute(killer);
    await killer.destroy();

    // Long enough for the socket to close and the pool to emit.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Still here. And still usable: the pool opens a fresh connection for the next
    // query rather than staying poisoned by the one that died.
    const after = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(after.rows[0]!.ok).toBe(1);
    await db.destroy();
  }, 30_000);

  it("keeps serving other connections while one of them is terminated", async () => {
    // The control: the row above would pass for a pool that quietly stopped working,
    // because "did not crash" and "still works" are different claims.
    const base = requireTestUrl();
    const db = openDb(base);
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);

    const killer = openDb(base);
    await sql`select pg_terminate_backend(${rows[0]!.pid})`.execute(killer);
    await killer.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => sql<{ ok: number }>`select 1 as ok`.execute(db)),
    );
    expect(results.map((r) => r.rows[0]!.ok)).toEqual([1, 1, 1, 1, 1]);
    await db.destroy();
  }, 30_000);
});
