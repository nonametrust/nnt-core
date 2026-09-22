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

export function openDb(url: string): Db {
  return new Kysely<Schema>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  });
}
