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
  /**
   * The row's id, minted by the CALLER (R1).
   *
   * The brief is a pure function returning a value and a list of effects, and its
   * audit body names the trigger id -- so the id has to be something the core was
   * given rather than something this writer invented. As shipped, `record` called
   * `randomUUID()` itself, which meant the row's id was never the id in the audit
   * body and a RETRIED record wrote a second row for one logical trigger. It now
   * collides on the primary key instead.
   */
  triggerId: string;
  /**
   * The instant the trigger was decided, from the caller's clock.
   *
   * Refused if it is after this repository's own clock (R34). R1 leaves the
   * injected clock with nothing to compute, and rather than drop it -- which
   * would make this the one repository whose clock a composition root cannot
   * check -- it became the bound, exactly as `TagRepository` bounds `taggedAt`.
   */
  at: Date;
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

/**
 * Refused when `value` is after `now`, or is not a date at all. One phrasing,
 * copied from `TagRepository`'s, so two callers can be held to the same message.
 */
function requireNotAfter(name: string, value: Date, now: Date): void {
  const at = value.getTime();
  if (Number.isNaN(at)) {
    throw new RangeError(`${name} must be a valid date, got ${String(value)}`);
  }
  if (at > now.getTime()) {
    throw new RangeError(
      `${name} ${value.toISOString()} is after the clock ${now.toISOString()}: ` +
        `a trigger recorded in the future would order before instants that precede it`,
    );
  }
}

export class TriggerEventRepository {
  constructor(
    private readonly db: Db,
    // Public and readonly so a composition root can assert every repository
    // shares one clock -- see `surface.test.ts`. Exposing it is not a check: a
    // reader of one repository still cannot tell whose clock this is.
    readonly clock: Clock,
  ) {}

  /**
   * Records a trigger under the id and at the instant the caller hands it.
   *
   * A tier on a status that is not harm-confirmed, a status outside the three
   * grades and a surprise that is not a finite number are refused by the check
   * constraints, and a namespace the observation does not belong to by the foreign
   * key; each is raised as ConstraintViolation with the SQLSTATE and constraint
   * name on it, as tag's `open` does for the same kinds of caller defect. A repeat
   * of the same id is 23505 on the primary key, which is how a retry stays one
   * row.
   *
   * Note what this table still lacks and M3 does not add (R31): `0006` puts no
   * append-only trigger on `trigger_event`, so the candidate the brief records --
   * its only durable trace beside the audit row -- is updatable and deletable from
   * any raw writer, unlike every other table in this schema.
   */
  async record(input: RecordTriggerEvent): Promise<StoredTriggerEvent> {
    requireNotAfter("at", input.at, this.clock.now());
    try {
      const row = await this.db
        .insertInto("trigger_event")
        .values({
          trigger_id: input.triggerId,
          namespace_id: input.namespaceId,
          observation_id: input.observationId,
          status: input.status,
          tier: input.tier ?? null,
          cluster_id: input.clusterId ?? null,
          surprise: input.surprise,
          created_at: input.at,
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
