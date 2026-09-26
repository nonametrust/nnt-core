import { Kysely, PostgresDialect, type ColumnType, type Generated } from "kysely";
import { WriteInsideTransaction } from "./errors.js";
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
    // The readable form is PERIOD_TEXT's `to_char` (R17), never `period::text`, which is what R8 requires
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
    // The rescued observation, re-sealed under the NAMESPACE key (Task 9).
    // Not in the metadata surface `get` returns: a shredded namespace's
    // record can still be fetched by id and only `read` refuses. "Listable"
    // would overstate it -- this repository has no list method.
    payload_nonce: Buffer;
    payload_tag: Buffer;
    payload_ciphertext: Buffer;
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
const PINS = [
  "-c datestyle=ISO",
  "-c default_transaction_isolation=read\\ committed",
  // How many digits the SERVER prints for a float8, and therefore what the
  // driver parses. This store's floats are `g0`, `confidence`, `surprise` and
  // every baseline moment. Under `extra_float_digits = 0` a `g0` written as
  // 0.5775328370803322 reads back as 0.577532837080332: no refusal, no error,
  // a different number than the one stored. On 17.7 any value >= 1 means
  // shortest-precise output; 3 is the value the JDBC driver pins and also
  // means 17 digits on majors old enough to need it.
  //
  // The second-order shape is what makes it a pin rather than a note. M2
  // reads a baseline, updates it and writes it back: a `mean` read as "0.3"
  // and written back as `median_est` is refused by
  // `baseline_location_is_mean`, whose DETAIL line renders the failing row as
  // "0.3, ..., 0.3" -- a named refusal that reads as impossible, on a write
  // that was correct. Found by asking what else could be set against this
  // store rather than by a failure, which is the only one of the three that
  // was.
  "-c extra_float_digits=3",
] as const;

/**
 * The last `-c <name>=` in an `options` string, as libpq resolves it, or null
 * when the setting is not mentioned. Tokens are split on whitespace that is
 * not backslash-escaped, which is libpq's own escaping rule and the reason
 * `read\ committed` is written the way it is.
 */
function lastSetting(options: string, name: string): string | null {
  const tokens = options.split(/(?<!\\)\s+/).filter(Boolean);
  let found: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const setting = token === "-c" ? tokens[++i] : token.startsWith("-c") ? token.slice(2) : undefined;
    if (setting !== undefined && setting.toLowerCase().startsWith(`${name}=`)) found = setting;
  }
  return found;
}

export function withIsoDates(url: string): string {
  const parsed = new URL(url);
  // getAll, not get: `urlForSchema` appends its search_path by string
  // concatenation, so a base url that already carries `options` arrives here
  // with TWO of them. `get` read the first and `set` below then deleted the
  // rest, so the schema confinement was silently dropped -- and in the other
  // order, both pins were. Collapsing them into one parameter is also what
  // the driver wants: `options` is a single connection parameter, and a url
  // carrying two of them has no defined meaning.
  const existing = parsed.searchParams.getAll("options").join(" ");
  // Decided on the LAST `-c` for each setting rather than on whether our own
  // fragment appears anywhere, because `includes` is a substring test and
  // "appears somewhere" is not "takes effect". An options string that carried
  // our pin and then a contrary one after it reported both pins present while
  // neither was in force.
  //
  // The history is worth keeping because it is the same mistake three times
  // in this one function. First it returned early whenever `options`
  // mentioned `datestyle=` at all -- written when DateStyle was the only pin,
  // and it survived the commit that added the isolation one, so a url already
  // carrying a DateStyle got NO isolation pin: twenty concurrent appends
  // under a cap of five stored fourteen rows. The fix for that matched the
  // fragment instead, and inherited the two holes above.
  //
  // What happens to a caller who asks for something contrary is settled here:
  // ours is appended after theirs and wins. Neither pin is negotiable -- a
  // non-ISO DateStyle makes every timestamp column arrive null, and
  // REPEATABLE READ makes the producer cap count against a stale snapshot --
  // so honouring a contrary choice would mean handing back a store that is
  // silently wrong rather than one that refuses. Settings we do not pin are
  // carried through untouched.
  const missing = PINS.filter((pin) => {
    const name = pin.slice("-c ".length).split("=")[0]!;
    return lastSetting(existing, name)?.toLowerCase() !== pin.slice("-c ".length).toLowerCase();
  });
  const options = [existing, ...missing].filter(Boolean).join(" ");
  if (options === existing && parsed.searchParams.getAll("options").length <= 1) return url;
  parsed.searchParams.set("options", options);
  return parsed.toString();
}

/**
 * Refuses a write path that was handed a repository built on a Transaction
 * (R21).
 *
 * Reads compose: `get`, `find`, `dataKey` and the rest work perfectly well on
 * a `trx`, and `promote` depends on that to read an observation inside its
 * own transaction. Writes do not, for two reasons that point the same way.
 * Kysely refuses a nested transaction with a bare `Error`, and by then the
 * earlier steps of the write have already written into the caller's
 * transaction -- so without this the failure arrives late, unnamed, and
 * half-applied. And composing two of this store's writes in one transaction
 * makes the lock-ordering cycle reachable: `{shred; journal}` against
 * `{journal; append}` deadlocks in about a second, measured.
 *
 * Called at the FRONT of each write that opens a transaction of its own.
 */
export function refuseWriteInsideTransaction(db: Db, operation: string): void {
  if (db.isTransaction) {
    throw new WriteInsideTransaction(
      `${operation} opens a transaction of its own and was handed one already open. ` +
        `Reads compose on a transaction and writes do not (R21): build this repository ` +
        `on the pool, or do the write outside the transaction.`,
    );
  }
}
