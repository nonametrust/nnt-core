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
}

export type Db = Kysely<Schema>;

export function openDb(url: string): Db {
  return new Kysely<Schema>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  });
}
