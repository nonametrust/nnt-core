import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import { TagNotFound, mapPgError } from "../errors.js";

/**
 * What a tag stores, and nothing derived from it. Strength is not here: it is
 * a function of `g0`, `taggedAt`, `suppressionFactor` and a half-life, and
 * `strengthAt` in ../strength.ts computes it at any instant from this shape.
 */
export interface StoredTag {
  tagId: string;
  namespaceId: string;
  observationId: string;
  channel: string;
  g0: number;
  taggedAt: Date;
  refreshCount: number;
  saturationState: "open" | "saturated";
  suppressionFactor: number;
}

export interface OpenTag {
  namespaceId: string;
  observationId: string;
  channel: string;
  g0: number;
}

const COLUMNS = [
  "tag_id", "namespace_id", "observation_id", "channel", "g0",
  "tagged_at", "refresh_count", "saturation_state", "suppression_factor",
] as const;

// Postgres's `check (g0 >= 0)` admits NaN and Infinity, because it orders NaN
// above every other double. NaN in particular would then travel: greatest(g0,
// NaN) is NaN, so one bad refresh would replace a real g0 with a value no
// decay curve can read. Both numbers are refused here, before any statement,
// and RangeError is the class because the argument is arithmetic nonsense in
// the same way a zero half-life is.
function requireFinite(name: string, value: number, floor: number): void {
  if (!Number.isFinite(value) || value < floor) {
    throw new RangeError(`${name} must be a finite number no less than ${floor}, got ${value}`);
  }
}

/**
 * The tag repository. Its prototype carries `open`, `get`, `suppress`,
 * `refresh` and `listLive`, and nothing that deletes: suppression is
 * accelerated decay and the row stays, and retirement from the bounded
 * window is a separate, named operation that belongs to the nightly job of a
 * later milestone. tag.test.ts pins the absence, so adding a delete here
 * fails a test rather than quietly widening what a call site can do.
 */
export class TagRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Opens a tag at the clock's instant with the defaults a fresh tag carries.
   * A missing namespace or observation, or an observation that does not
   * belong to the namespace, is refused by the foreign keys and the driver's
   * error is rethrown as it is, with SQLSTATE 23503 in `.code`: an unknown
   * identifier at this layer is a caller's defect, and a store error wrapping
   * it would hide which key.
   */
  async open(input: OpenTag): Promise<StoredTag> {
    requireFinite("g0", input.g0, 0);
    const tag: StoredTag = {
      tagId: randomUUID(),
      namespaceId: input.namespaceId,
      observationId: input.observationId,
      channel: input.channel,
      g0: input.g0,
      taggedAt: this.clock.now(),
      refreshCount: 0,
      saturationState: "open",
      suppressionFactor: 1,
    };
    try {
      await this.db
        .insertInto("tag")
        .values({
          tag_id: tag.tagId,
          namespace_id: tag.namespaceId,
          observation_id: tag.observationId,
          channel: tag.channel,
          g0: tag.g0,
          tagged_at: tag.taggedAt,
          refresh_count: tag.refreshCount,
          saturation_state: tag.saturationState,
          suppression_factor: tag.suppressionFactor,
        })
        .execute();
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
    return tag;
  }

  async get(tagId: string): Promise<StoredTag> {
    const row = await this.db
      .selectFrom("tag")
      .select(COLUMNS)
      .where("tag_id", "=", tagId)
      .executeTakeFirst();
    if (!row) throw new TagNotFound(`no tag ${tagId}`);
    return toStored(row);
  }

  /**
   * Suppression raises the factor that multiplies elapsed time in the decay.
   * It only ever raises: the larger of the stored factor and the requested
   * one is kept, so a second suppression with a smaller factor cannot slow a
   * tag's decay back down, which would be a way to revive evidence that
   * nothing in the design asks for. One statement, for the same reason as
   * `refresh`.
   */
  async suppress(tagId: string, factor: number): Promise<void> {
    requireFinite("suppression factor", factor, 1);
    const result = await this.db
      .updateTable("tag")
      .set((eb) => ({
        suppression_factor: eb.fn<number>("greatest", ["suppression_factor", eb.val(factor)]),
      }))
      .where("tag_id", "=", tagId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw new TagNotFound(`no tag ${tagId} to suppress`);
  }

  /**
   * A repeated deviation on an already-tagged pair refreshes rather than
   * stacks. The new g0 is the larger of the two, computed in the database in
   * one statement so that two concurrent refreshes cannot lose one: the row
   * lock serialises them and the second re-evaluates against the first's
   * result. A read in TypeScript followed by a write would let both read the
   * same count and the same g0, and one of the two would vanish.
   */
  async refresh(tagId: string, g0: number): Promise<void> {
    requireFinite("g0", g0, 0);
    const result = await this.db
      .updateTable("tag")
      .set((eb) => ({
        g0: eb.fn<number>("greatest", ["g0", eb.val(g0)]),
        refresh_count: eb("refresh_count", "+", 1),
      }))
      .where("tag_id", "=", tagId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw new TagNotFound(`no tag ${tagId} to refresh`);
  }

  /**
   * The namespace's tags, newest first, optionally only those tagged at or
   * after `since`. In this milestone every stored tag is live, because
   * nothing retires one: expiry from the bounded window is the nightly job's
   * operation and arrives with it. The name says what the nightly job will
   * ask for, so its call site does not change when retirement exists.
   */
  async listLive(namespaceId: string, since?: Date): Promise<StoredTag[]> {
    let q = this.db
      .selectFrom("tag")
      .select(COLUMNS)
      .where("namespace_id", "=", namespaceId)
      .orderBy("tagged_at", "desc");
    if (since !== undefined) q = q.where("tagged_at", ">=", since);
    const rows = await q.execute();
    return rows.map(toStored);
  }
}

// The row type is the Schema's, so a column added to db.ts without a place
// here is a compile error rather than a silently dropped field.
function toStored(row: Schema["tag"]): StoredTag {
  return {
    tagId: row.tag_id,
    namespaceId: row.namespace_id,
    observationId: row.observation_id,
    channel: row.channel,
    g0: row.g0,
    taggedAt: row.tagged_at,
    refreshCount: row.refresh_count,
    saturationState: row.saturation_state,
    suppressionFactor: row.suppression_factor,
  };
}
