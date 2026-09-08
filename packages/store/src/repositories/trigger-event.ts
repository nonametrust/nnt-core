import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import { TriggerEventNotFound, mapPgError } from "../errors.js";

export type TriggerStatus = Schema["trigger_event"]["status"];

/**
 * A trigger event: one row per candidate, verified or harm-confirmed
 * trigger. `tier` is set on a harm-confirmed row and nowhere else, which the
 * table holds. `clusterId` is nullable and unused in M1. `surprise` is
 * stored as given; the arithmetic that produces it is M2's.
 */
export interface StoredTriggerEvent {
  triggerId: string;
  namespaceId: string;
  observationId: string;
  status: TriggerStatus;
  tier: string | null;
  clusterId: string | null;
  surprise: number;
  createdAt: Date;
}

export interface RecordTriggerEvent {
  namespaceId: string;
  observationId: string;
  status: TriggerStatus;
  tier?: string;
  clusterId?: string;
  surprise: number;
}

const COLUMNS = [
  "trigger_id", "namespace_id", "observation_id", "status", "tier", "cluster_id", "surprise", "created_at",
] as const;

export class TriggerEventRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Records a trigger at the clock's instant. A tier on a status that is not
   * harm-confirmed, a status outside the three grades and a surprise that is
   * not a finite number are refused by the check constraints, and a
   * namespace the observation does not belong to by the foreign key; each
   * is raised as ConstraintViolation with the SQLSTATE and constraint name
   * on it, as tag's `open` does for the same kinds of caller defect.
   */
  async record(input: RecordTriggerEvent): Promise<StoredTriggerEvent> {
    try {
      const row = await this.db
        .insertInto("trigger_event")
        .values({
          trigger_id: randomUUID(),
          namespace_id: input.namespaceId,
          observation_id: input.observationId,
          status: input.status,
          tier: input.tier ?? null,
          cluster_id: input.clusterId ?? null,
          surprise: input.surprise,
          created_at: this.clock.now(),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toStored(row);
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
  }

  async get(triggerId: string): Promise<StoredTriggerEvent> {
    const row = await this.db
      .selectFrom("trigger_event")
      .select(COLUMNS)
      .where("trigger_id", "=", triggerId)
      .executeTakeFirst();
    if (!row) throw new TriggerEventNotFound(`no trigger event ${triggerId}`);
    return toStored(row);
  }
}

function toStored(row: Schema["trigger_event"]): StoredTriggerEvent {
  return {
    triggerId: row.trigger_id,
    namespaceId: row.namespace_id,
    observationId: row.observation_id,
    status: row.status,
    tier: row.tier,
    clusterId: row.cluster_id,
    surprise: row.surprise,
    createdAt: row.created_at,
  };
}
