import { Kysely, PostgresDialect, type ColumnType, type Generated } from "kysely";
import pg from "pg";

// The store owns its own schema type. Each task adds its tables here.
export interface Schema {
  schema_migration: {
    filename: string;
    sha256: string;
    applied_at: Generated<Date>;
  };
  namespace: {
    namespace_id: string;
    kind: string;
    ns_id: string;
    data_key_wrapped: Buffer | null;
    key_shredded_at: Date | null;
    created_at: Date;
  };
  // The month key, one row per (namespace, calendar month).
  //
  // `period` goes in as a string and is NEVER read back as a driver Date:
  // the driver parses a `date` at LOCAL midnight, so east of UTC a
  // round-tripped 2026-09-01 comes back as 2026-08-31T21:00Z and looks up
  // the wrong month's key with nothing to show for it. Every read renders it
  // through PERIOD_TEXT. The `never` on the update side is the other half of
  // the guard's rule: the column is fixed at mint and the type says so
  // before the trigger has to.
  //
  // What `never` on the READ side buys is narrower than it looks: it removes
  // the column from `Selectable`, but Kysely takes select names from the
  // table type, so `.select(["period"])` still compiles and hands back
  // `never`, which assigns to anything. It is documentation with teeth on
  // the row shape, not a barrier.
  namespace_key: {
    namespace_id: string;
    // `never` on the SELECT side, not `string`: the driver returns a Date for
    // a `date` column, so typing the read as string would compile and lie.
    // The only readable form is sql`period::text`, which is what R8 requires
    // anyway -- the driver parses a date at LOCAL midnight, so east of UTC a
    // round-tripped 2026-09-01 comes back as 2026-08-31T21:00Z.
    period: ColumnType<never, string, never>;
    key_wrapped: Buffer | null;
    expires_at: ColumnType<Date, Date, never>;
    shredded_at: Date | null;
    created_at: ColumnType<Date, Date, never>;
  };
  observation: {
    observation_id: string;
    idempotency_key: string;
    namespace_id: string;
    channel: string;
    kind: string;
    evidence_kind: string;
    dated_at: Date | null;
    ingested_at: Date;
    producer: string;
    // The same `never` on the read side as namespace_key.period, for the same
    // reason: the driver returns a Date for a `date` column, parsed at LOCAL
    // midnight. Read it with to_char.
    period: ColumnType<never, string, never>;
    payload_nonce: Buffer;
    payload_tag: Buffer;
    payload_ciphertext: Buffer;
  };
  // What a tag stores and nothing more. There is deliberately no strength,
  // score or decayed column here or in 0003_tag.sql; strength is derived by
  // strength.ts, and tag.test.ts reads the live catalogue to hold that.
  tag: {
    tag_id: string;
    namespace_id: string;
    observation_id: string;
    channel: string;
    aspect: string;
    g0: number;
    tagged_at: Date;
    refresh_count: number;
    saturation_state: "open" | "saturated";
    suppression_factor: number;
    retired_at: Date | null;
  };
  // rescued_by is a plain uuid here; the foreign key arrived with 0006, the
  // migration that created trigger_event, and the type did not change then.
  permanent_record: {
    record_id: string;
    observation_id: string;
    namespace_id: string;
    original_dated_at: Date;
    promoted_at: Date;
    rescued_by: string | null;
    confidence: number;
  };
  // `seq` is a string throughout. bigint arrives from the driver as a string
  // unless a type parser is configured, and none is: a chain sequence is an
  // identifier and never arithmetic. `body` is written as the canonical JSON
  // text, never as an object, because the driver would render a top-level
  // array as a Postgres array literal rather than as JSON.
  audit_entry: {
    seq: Generated<string>;
    occurred_at: Date;
    policy_version: string;
    kind: string;
    body: ColumnType<unknown, string, never>;
    canonical: string;
    prev_sha256: Buffer;
    entry_sha256: Buffer;
  };
  // `day` is written as an ISO date string and read back as the driver's
  // Date, which is what it makes of a `date` column without a parser.
  audit_day: {
    day: ColumnType<Date, string, never>;
    terminal_seq: string;
    terminal_sha256: Buffer;
    hmac: Buffer;
    sealed_at: Date;
  };
  // The four tables M2 and M3 fill. Every number here is stored as given
  // and computed by nobody in this package.
  //
  // `n` is a bigint, and the driver hands a bigint back as a string, as it
  // does audit_entry.seq. Unlike seq this one is arithmetic, so the baseline
  // repository converts it and refuses a value past the safe-integer range
  // rather than round it. The TypeScript field is `count`; the column is not,
  // because `count` in hand-written SQL reads as the aggregate.
  baseline: {
    namespace_id: string;
    channel: string;
    aspect: string;
    n: ColumnType<string, number, number>;
    mean: number;
    m2: number;
    median_est: number | null;
    mad_est: number | null;
    fast_mean: number;
    fast_m2: number;
    slow_mean: number;
    slow_m2: number;
    updated_at: Date;
  };
  // `tier` is any text: the tiers themselves are the tiered failure policy,
  // which is M3's. The check the table holds is that only a harm-confirmed
  // row carries one.
  trigger_event: {
    trigger_id: string;
    namespace_id: string;
    observation_id: string;
    status: "candidate" | "verified" | "harm_confirmed";
    tier: string | null;
    cluster_id: string | null;
    surprise: number;
    created_at: Date;
  };
  volatility: {
    namespace_id: string;
    q_hat: number;
    updated_at: Date;
  };
  hot_window: {
    window_id: string;
    namespace_id: string;
    trigger_id: string;
    opens_at: Date;
    closes_at: Date;
    scale: number;
  };
}

export type Db = Kysely<Schema>;

/**
 * Every connection this package opens announces `DateStyle=ISO`, and that is
 * not cosmetic.
 *
 * The driver parses `timestamptz` out of the text the server sends, and the
 * server renders that text through DateStyle. Under `German` or `SQL, MDY` it
 * sends `01.09.2026 ...`, node-pg does not recognise it, and every timestamp
 * column in this store comes back as NULL -- so a read crashes on
 * `.getTime()` with an error this package does not own, rather than refusing
 * anything. `date` columns render the same way, which is why period is read
 * through `to_char` with an explicit pattern.
 *
 * A server-wide setting, an `alter role ... set datestyle`, a `PGDATESTYLE`
 * in the environment or one connection of a mixed pool is enough to produce
 * it. `options` on the connection is per session and beats all of them, so
 * this is the one place it can be settled.
 *
 * It is appended rather than assigned, because `urlForSchema` already puts a
 * `search_path` in `options` and a second `options` parameter would replace
 * the first instead of adding to it.
 */
export function openDb(url: string): Db {
  return new Kysely<Schema>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: withIsoDates(url) }) }),
  });
}

// Two settings this package pins per connection rather than inheriting, for
// the same reason and by the same mechanism.
//
// DateStyle, because under any non-ISO style node-pg cannot parse the
// timestamptz text the server sends and every timestamp column arrives null.
//
// READ COMMITTED, because this store's correctness rests on statements seeing
// what committed before them. Measured under a session defaulting to
// REPEATABLE READ: the producer cap admitted fourteen rows against a cap of
// five -- the snapshot is taken at a transaction's first statement, which is
// the lock acquisition, so queued appenders all count against a view that
// predates the holder's commit -- and `ensure` and `periodKey`, whose
// `on conflict do nothing` is the normal path when two deliveries touch one
// namespace, raise 40001 instead of converging. Neither is a defect the store
// can fix downstream: the isolation level has to be right before the
// statement runs.
//
// A server-wide setting, an `alter role ... set default_transaction_isolation`,
// a `PGOPTIONS`, or a connection pooler is enough to set either from outside.
// `options` on the connection string is per session and beats all of them, so
// this is the one place either can be settled.
const ISO_DATES = "-c datestyle=ISO -c default_transaction_isolation=read\\ committed";

export function withIsoDates(url: string): string {
  const parsed = new URL(url);
  const existing = parsed.searchParams.get("options");
  if (existing?.includes("datestyle=")) return url;
  parsed.searchParams.set("options", existing ? `${existing} ${ISO_DATES}` : ISO_DATES);
  return parsed.toString();
}
