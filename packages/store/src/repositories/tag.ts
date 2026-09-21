import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Db, Schema } from "../db.js";
import { TagNotFound, TagRefreshStale, mapPgError } from "../errors.js";

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
  aspect: string;
  g0: number;
  taggedAt: Date;
  refreshCount: number;
  saturationState: "open" | "saturated";
  suppressionFactor: number;
  /** Set once by M4's nightly retirement; a retired tag is no longer live. */
  retiredAt: Date | null;
}

/**
 * What a refresh writes, spelled exactly as `TagRefresh` in
 * packages/tagging. The store may not import tagging -- that dependency
 * would put a database under every tagging test -- so the shape is declared
 * twice and a root gate holds the two declarations equal field for field.
 *
 * Every value here is computed by M2 over the DECAYED strength at the
 * caller's instant. The store cannot recompute any of it: it deliberately
 * holds no half-life, so it writes what it is handed and merges nothing.
 */
export interface TagRefresh {
  g0: number;
  taggedAt: Date;
  refreshCount: number;
  saturationState: "open" | "saturated";
}

export interface OpenTag {
  namespaceId: string;
  observationId: string;
  channel: string;
  aspect: string;
  g0: number;
  /**
   * The instant the decision stamps, which is the event's own instant and not
   * this process's clock. M2's `decide` clamps an event's instant to the
   * caller's `at` and uses `at` itself for a state; either way the store
   * writes what it is handed. Stamped from a clock instead, an observation
   * ingested a minute after it happened decays from the wrong instant, and a
   * backfill dates a whole history at the day it was loaded.
   */
  taggedAt: Date;
}

const COLUMNS = [
  "tag_id", "namespace_id", "observation_id", "channel", "aspect", "g0",
  "tagged_at", "refresh_count", "saturation_state", "suppression_factor",
  "retired_at",
] as const;

// Postgres's `check (g0 >= 0)` admits NaN and Infinity, because it orders NaN
// above every other double. NaN in particular would then travel: greatest(g0,
// NaN) is NaN, so one bad refresh would replace a real g0 with a value no
// decay curve can read. Both numbers are refused here, before any statement,
// and RangeError is the class because the argument is arithmetic nonsense in
// the same way a zero half-life is.
// An Invalid Date is a Date, and it reaches Postgres as a null bind rather
// than as an error, so the column's NOT NULL would refuse it with a message
// about a null. Refused here instead, where the argument can be named.
function requireInstant(name: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date, got ${String(value)}`);
  }
}

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
   * belong to the namespace, is refused by the foreign keys and raised as
   * ConstraintViolation with SQLSTATE 23503 and the key's name on it: an
   * unknown identifier at this layer is a caller's defect, and the name
   * says which key, with the driver's error kept as cause.
   */
  async open(input: OpenTag): Promise<StoredTag> {
    requireFinite("g0", input.g0, 0);
    requireInstant("taggedAt", input.taggedAt);
    const tag: StoredTag = {
      tagId: randomUUID(),
      namespaceId: input.namespaceId,
      observationId: input.observationId,
      channel: input.channel,
      aspect: input.aspect,
      g0: input.g0,
      taggedAt: input.taggedAt,
      refreshCount: 0,
      saturationState: "open",
      suppressionFactor: 1,
      retiredAt: null,
    };
    try {
      await this.db
        .insertInto("tag")
        .values({
          tag_id: tag.tagId,
          namespace_id: tag.namespaceId,
          observation_id: tag.observationId,
          channel: tag.channel,
          aspect: tag.aspect,
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
  /**
   * Writes what M2's decision returned, and computes nothing.
   *
   * Optimistic on the count: the caller was handed `refreshCount`, so it read
   * the row at `refreshCount - 1`, and the update matches on that. A lost
   * race is refused rather than merged, because merging would need the
   * decayed strength at the caller's instant and this package holds no
   * half-life to compute it with; the caller re-reads and recomputes. Merged
   * arithmetically, as M1 did, the row would hold a strength no decision ever
   * produced.
   */
  async refresh(tagId: string, next: TagRefresh): Promise<void> {
    requireFinite("g0", next.g0, 0);
    requireInstant("taggedAt", next.taggedAt);
    if (!Number.isSafeInteger(next.refreshCount) || next.refreshCount < 1) {
      throw new RangeError(
        `refreshCount must be a safe integer of at least 1, got ${next.refreshCount}`,
      );
    }
    const result = await this.db
      .updateTable("tag")
      .set({
        g0: next.g0,
        tagged_at: next.taggedAt,
        refresh_count: next.refreshCount,
        saturation_state: next.saturationState,
      })
      .where("tag_id", "=", tagId)
      .where("refresh_count", "=", next.refreshCount - 1)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 0n) return;
    // Zero rows is two different conditions with two different cures, and a
    // caller told the wrong one retries forever or gives up wrongly.
    const live = await this.db
      .selectFrom("tag").select("tag_id").where("tag_id", "=", tagId).executeTakeFirst();
    if (live === undefined) throw new TagNotFound(`no tag ${tagId} to refresh`);
    throw new TagRefreshStale(
      `tag ${tagId} was refreshed by someone else since this decision read it; ` +
        `re-read the live tag and decide again`,
    );
  }

  /**
   * The namespace's tags, newest first, optionally only those tagged at or
   * after `since`. In this milestone every stored tag is live, because
   * nothing retires one: expiry from the bounded window is the nightly job's
   * operation and arrives with it. The name says what the nightly job will
   * ask for, so its call site does not change when retirement exists.
   */
  /**
   * The live tag on a pair, or null. This is the read M2 needs: its
   * `tagObservation` takes `LiveTagInput | null` for a (namespace, channel,
   * aspect), and without this a caller would pull every live tag in the
   * namespace and filter in memory. The uniqueness is the database's, so at
   * most one row can match.
   */
  async findLive(namespaceId: string, channel: string, aspect: string): Promise<StoredTag | null> {
    const row = await this.db
      .selectFrom("tag")
      .select(COLUMNS)
      .where("namespace_id", "=", namespaceId)
      .where("channel", "=", channel)
      .where("aspect", "=", aspect)
      .where("retired_at", "is", null)
      .executeTakeFirst();
    return row === undefined ? null : toStored(row);
  }

  async listLive(namespaceId: string, since?: Date): Promise<StoredTag[]> {
    let q = this.db
      .selectFrom("tag")
      .select(COLUMNS)
      .where("namespace_id", "=", namespaceId)
      .where("retired_at", "is", null)
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
    aspect: row.aspect,
    g0: row.g0,
    taggedAt: row.tagged_at,
    refreshCount: row.refresh_count,
    saturationState: row.saturation_state,
    suppressionFactor: row.suppression_factor,
    retiredAt: row.retired_at,
  };
}
