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

// The clock stopped stamping tags when `open` began taking the instant from
// the decision, and this is what it does instead. A tag stamped in the future
// is full strength forever -- the decay curve reads any instant before the
// tag as g0 -- and it cannot be retired either, because the guard refuses a
// retirement before the tag's own instant. M2 never produces one, since its
// `decide` clamps an event to the caller's `at`; the database cannot hold the
// rule without reading a wall clock, which the injected-clock discipline
// forbids. So it is held here.
//
// What it costs if wrong: an engine whose clock runs ahead of the store's
// would have legitimate decisions refused. In v0 both are the same process
// and the same clock, and a RangeError naming the two instants is a better
// failure than a tag that never decays.
function requireNotAfter(name: string, value: Date, now: Date): void {
  if (value.getTime() > now.getTime()) {
    throw new RangeError(
      `${name} ${value.toISOString()} is after the clock ${now.toISOString()}: ` +
        `a tag stamped in the future never decays and cannot be retired`,
    );
  }
}

function requireFinite(name: string, value: number, floor: number): void {
  if (!Number.isFinite(value) || value < floor) {
    throw new RangeError(`${name} must be a finite number no less than ${floor}, got ${value}`);
  }
}

/**
 * The tag repository. Its prototype carries `open`, `get`, `findLive`,
 * `suppress`,
 * `refresh` and `listLive`, and nothing that deletes: suppression is
 * accelerated decay and the row stays, and retirement from the bounded
 * window is a separate, named operation that belongs to the nightly job of a
 * later milestone. tag.test.ts pins the absence, so adding a delete here
 * fails a test rather than quietly widening what a call site can do.
 */
export class TagRepository {
  constructor(
    private readonly db: Db,
    // Public and readonly so a composition root can assert every repository
    // shares one clock -- see `surface.test.ts`. Exposing it is not a check: a
    // reader of one repository still cannot tell whose clock this is.
    readonly clock: Clock,
  ) {}

  /**
   * Opens a tag at the instant the decision stamps -- the event's own, not
   * the clock's -- with the defaults a fresh tag carries. The clock is still
   * read, but only as a bound: a tag stamped ahead of it never decays.
   * A missing namespace or observation, or an observation that does not
   * belong to the namespace, is refused by the foreign keys and raised as
   * ConstraintViolation with SQLSTATE 23503 and the key's name on it: an
   * unknown identifier at this layer is a caller's defect, and the name
   * says which key, with the driver's error kept as cause.
   */
  async open(input: OpenTag): Promise<StoredTag> {
    requireFinite("g0", input.g0, 0);
    requireInstant("taggedAt", input.taggedAt);
    requireNotAfter("taggedAt", input.taggedAt, this.clock.now());
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
   * nothing in the design asks for; the guard holds the same rule against a
   * raw writer. One statement, because a suppression is a maximum the store
   * may compute -- unlike a refresh, which is M2's arithmetic.
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
    requireNotAfter("taggedAt", next.taggedAt, this.clock.now());
    if (!Number.isSafeInteger(next.refreshCount) || next.refreshCount < 1) {
      throw new RangeError(
        `refreshCount must be a safe integer of at least 1, got ${next.refreshCount}`,
      );
    }
    // Mapped, like every other write here: the guard refuses a backward
    // instant, a retired tag and a saturation that reopens, and those must
    // reach the caller as TagAltered. M3 retries on TagRefreshStale and must
    // not retry on a guard refusal; told apart only by a SQLSTATE string on a
    // driver error, it would retry forever or give up wrongly.
    let result;
    try {
      result = await this.db
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
    } catch (e) {
      throw mapPgError(e) ?? e;
    }
    if (result.numUpdatedRows !== 0n) return;
    // Zero rows is two different conditions with two different cures, and a
    // caller told the wrong one retries forever or gives up wrongly.
    const live = await this.db
      .selectFrom("tag").select("tag_id").where("tag_id", "=", tagId).executeTakeFirst();
    if (live === undefined) throw new TagNotFound(`no tag ${tagId} to refresh`);
    // Deliberately says what is true rather than what is likely: the row is
    // not at the count this decision was built on. Usually that is another
    // refresh landing first; it is also what a caller handing a count that
    // skips a step sees, and telling that caller someone else refreshed the
    // tag would send it to retry a read that will not help.
    throw new TagRefreshStale(
      `tag ${tagId} is not at refresh count ${next.refreshCount - 1}, which this ` +
        `decision was built on; re-read the live tag and decide again`,
    );
  }

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

  /**
   * The namespace's live tags, newest first, optionally only those tagged at
   * or after `since`. Live means `retired_at is null`, which is what both
   * readers filter on.
   *
   * The docstring that stood here said "in this milestone every stored tag is
   * live, because nothing retires one". It was true when written, stopped
   * being true when the storage card added `retired_at` and both readers
   * began filtering on it, and had drifted up above `findLive` in the
   * meantime, so it was describing the wrong method as well as the wrong
   * milestone. What is still true: nothing in this package RETIRES a tag, and
   * that operation is the nightly job's.
   *
   * `since` is owed a decision that is not this milestone's. `tagged_at` now
   * moves on every refresh, so a window asking "tagged at or after" gets the
   * LAST refresh and not the opening instant, and the opening instant is
   * stored nowhere once a tag has been refreshed. Whether a nightly window
   * wants one or the other is M4's to rule; if it wants the opening instant,
   * that is a column and therefore a migration.
   */
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
