import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import { mapPgError } from "../errors.js";

/**
 * A namespace's volatility estimate. Mean-reverting in M3; here a stored
 * number, replaced on every write.
 */
export interface StoredVolatility {
  namespaceId: string;
  qHat: number;
  updatedAt: Date;
}

export interface VolatilityState {
  namespaceId: string;
  qHat: number;
}

const COLUMNS = ["namespace_id", "q_hat", "updated_at"] as const;

export class VolatilityRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Writes the namespace's estimate, replacing what was there, stamped at
   * the clock's instant. A value the table does not admit is refused by its
   * check constraint and raised as ConstraintViolation under SQLSTATE 23514.
   */
  async upsert(state: VolatilityState): Promise<StoredVolatility> {
    const values = { q_hat: state.qHat, updated_at: this.clock.now() };
    try {
      const row = await this.db
        .insertInto("volatility")
        .values({ namespace_id: state.namespaceId, ...values })
        .onConflict((oc) => oc.column("namespace_id").doUpdateSet(values))
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toStored(row);
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
  }

  /** Null for a namespace that has no estimate yet, which is every new one. */
  async get(namespaceId: string): Promise<StoredVolatility | null> {
    const row = await this.db
      .selectFrom("volatility")
      .select(COLUMNS)
      .where("namespace_id", "=", namespaceId)
      .executeTakeFirst();
    return row ? toStored(row) : null;
  }
}

function toStored(row: Schema["volatility"]): StoredVolatility {
  return { namespaceId: row.namespace_id, qHat: row.q_hat, updatedAt: row.updated_at };
}
