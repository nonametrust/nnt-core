import { randomUUID } from "node:crypto";
import type { Db, Schema } from "../db.js";
import { HotWindowNotFound, mapPgError } from "../errors.js";

/**
 * A forward window opened after a trigger. The bounds and the scale are
 * stored as given: scaling by volatility is M3's, and M1 keeps what it is
 * handed. No clock is injected, because nothing here happens at "now"; a
 * window's instants are the caller's, and the table holds that they are
 * ordered.
 */
export interface StoredHotWindow {
  windowId: string;
  namespaceId: string;
  triggerId: string;
  opensAt: Date;
  closesAt: Date;
  scale: number;
}

export interface OpenHotWindow {
  namespaceId: string;
  triggerId: string;
  opensAt: Date;
  closesAt: Date;
  scale: number;
}

const COLUMNS = ["window_id", "namespace_id", "trigger_id", "opens_at", "closes_at", "scale"] as const;

export class HotWindowRepository {
  constructor(private readonly db: Db) {}

  /**
   * Opens a window. One that closes at or before it opens, or whose scale is
   * not a finite positive number, is refused by the check constraints; one
   * filed under a namespace its trigger is not about is refused by the
   * foreign key. Each comes back as the driver's error with the SQLSTATE and
   * the constraint's name on it.
   */
  async open(input: OpenHotWindow): Promise<StoredHotWindow> {
    try {
      const row = await this.db
        .insertInto("hot_window")
        .values({
          window_id: randomUUID(),
          namespace_id: input.namespaceId,
          trigger_id: input.triggerId,
          opens_at: input.opensAt,
          closes_at: input.closesAt,
          scale: input.scale,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toStored(row);
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
  }

  async get(windowId: string): Promise<StoredHotWindow> {
    const row = await this.db
      .selectFrom("hot_window")
      .select(COLUMNS)
      .where("window_id", "=", windowId)
      .executeTakeFirst();
    if (!row) throw new HotWindowNotFound(`no hot window ${windowId}`);
    return toStored(row);
  }
}

function toStored(row: Schema["hot_window"]): StoredHotWindow {
  return {
    windowId: row.window_id,
    namespaceId: row.namespace_id,
    triggerId: row.trigger_id,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    scale: row.scale,
  };
}
