import { Kysely, PostgresDialect, type Generated } from "kysely";
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
    g0: number;
    tagged_at: Date;
    refresh_count: number;
    saturation_state: "open" | "saturated";
    suppression_factor: number;
  };
}

export type Db = Kysely<Schema>;

export function openDb(url: string): Db {
  return new Kysely<Schema>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  });
}
