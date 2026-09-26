import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.js";
import type { Counters } from "../counters.js";

/**
 * The public Horizon serves about a year of history and returns HTTP 410
 * before its retention wall, which moves. That is a boundary, not an empty
 * result, and callers must tell the two apart (spec section 11).
 */
export class RetentionBoundary extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "RetentionBoundary";
  }
}

/**
 * A non-retryable (or retries-exhausted) HTTP status from Horizon, with the
 * status carried as its own field. A caller must never recover the status by
 * matching the message against a status-code-shaped substring: the message
 * embeds the URL, and a URL can contain a hex hash or an account id that
 * itself contains digits that look like a status code.
 */
export class HorizonStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Horizon ${status} for ${url}`);
    this.name = "HorizonStatusError";
  }
}

export interface HorizonClientOptions {
  baseUrl: string;
  clock: Clock;
  counters: Counters;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cacheDir?: string;
  minIntervalMs?: number;
  maxRetries?: number;
}

export interface HorizonPage<T> {
  records: T[];
  next: string | null;
}

interface RawPage<T> {
  _links?: { next?: { href?: string } };
  _embedded?: { records?: T[] };
}

const DEFAULT_MIN_INTERVAL_MS = 1250; // 0.8 requests per second, what the backtest sustained
const DEFAULT_MAX_RETRIES = 5;
// Measured 2026-09-10: a hot account's payments page answers 503 on every
// attempt above this limit (about ten seconds, Horizon's query timeout);
// at 25 it answers in time, so this is the floor `pages()` shrinks to.
const PAGE_LIMIT_FLOOR = 25;

/**
 * A thin client: every trap the backtest measured lives at this layer and
 * must be visible, so there is no library between us and HTTP. Time comes
 * from the injected clock and waiting from the injected sleep, so the
 * limiter is proved under a fake clock.
 */
export class HorizonClient {
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly counters: Counters;
  private readonly cacheDir: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(opts: HorizonClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.clock = opts.clock;
    this.counters = opts.counters;
    this.cacheDir = opts.cacheDir;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (this.cacheDir) mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * A thrown fetch (a network-level failure such as `TypeError: fetch
   * failed`, e.g. a dropped connection) is retried exactly like a retryable
   * HTTP status; once retries are exhausted it fails with an error naming
   * the url, instead of aborting the run with the bare underlying message.
   */
  async getJson<T = unknown>(pathWithQuery: string, opts?: { maxRetries?: number; noCache?: boolean }): Promise<T> {
    const url = pathWithQuery.startsWith("http") ? pathWithQuery : `${this.baseUrl}${pathWithQuery}`;
    if (!opts?.noCache) {
      const cached = this.readCache(url);
      if (cached !== null) {
        this.counters.inc("cache_hits");
        return JSON.parse(cached) as T;
      }
    }
    const maxRetries = opts?.maxRetries ?? this.maxRetries;
    let attempt = 0;
    for (;;) {
      await this.throttle();
      this.counters.inc("requests");
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= maxRetries) {
          throw new Error(`Horizon unreachable for ${url}: ${message}`);
        }
        attempt++;
        this.counters.inc("retries");
        await this.sleep(this.minIntervalMs * 2 ** attempt);
        continue;
      }
      if (res.status === 200) {
        const text = await res.text();
        let parsed: T;
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          throw new Error(`Horizon returned a non-JSON body for ${url}`);
        }
        if (!opts?.noCache) this.writeCache(url, text);
        return parsed;
      }
      if (res.status === 410) {
        this.counters.inc("retention_refusals");
        throw new RetentionBoundary(`Horizon no longer serves ${url} (HTTP 410)`, url);
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new HorizonStatusError(res.status, url);
      }
      attempt++;
      this.counters.inc("retries");
      await this.sleep(this.minIntervalMs * 2 ** attempt);
    }
  }

  /**
   * Follows `_links.next` until a page comes back empty. A page shorter than
   * the requested limit that is nonetheless followed by records is counted
   * as truncated, because that is the shape the backtest saw when Horizon
   * cut a page silently; nothing is lost, since the next link is followed
   * regardless, but the report must say it happened.
   *
   * Measured live (2026-09-10): for a hot account, a large `limit` makes
   * Horizon exceed its own query timeout and answer 503 on *every* attempt,
   * so the normal backoff ladder just burns eight retries and then aborts
   * the run. A 503 while paging is therefore treated as "this page is too
   * big", not as an outage: each page is first tried with a single-attempt
   * ladder (`maxRetries: 1`), and a 503 above the floor of 25 halves the
   * `limit` on the URL and retries the same page immediately, counting
   * `page_limit_reduced`. Horizon's own `next` link on a reduced page
   * already carries the smaller limit, so the reduction sticks for the rest
   * of the iteration without extra bookkeeping. Once `limit` is at the
   * floor (or the URL carries no `limit` at all) a 503 is no longer
   * treated as "too big" and the page is fetched with the client's normal
   * retry ladder, so a genuine outage still surfaces as a failure. Only a
   * 503 is read as "shrink the page": any other error from the
   * single-attempt ladder (a 429, a 5xx that is not 503, a dropped
   * connection) gets the client's full normal ladder before it is allowed
   * to propagate, except a 410, which is final and propagates at once, so the short ladder used to probe page
   * size never undoes the retry behaviour the rest of the client relies on
   * for ordinary transient failures. The truncation heuristic compares
   * against the limit actually used for the page that came back, not the
   * limit the caller originally asked for.
   */
  async *pages<T>(pathWithQuery: string): AsyncIterable<T[]> {
    let url: string | null = pathWithQuery;
    let previousShort = false;
    while (url !== null) {
      let currentUrl = url;
      let raw: RawPage<T>;
      for (;;) {
        const currentLimit = requestedLimit(currentUrl);
        if (currentLimit !== null && currentLimit > PAGE_LIMIT_FLOOR) {
          try {
            raw = await this.getJson<RawPage<T>>(currentUrl, { maxRetries: 1 });
            break;
          } catch (err) {
            if (err instanceof HorizonStatusError && err.status === 503) {
              const reduced = Math.max(PAGE_LIMIT_FLOOR, Math.floor(currentLimit / 2));
              currentUrl = withLimit(currentUrl, reduced);
              this.counters.inc("page_limit_reduced");
              continue;
            }
            // A retention refusal is final: the history is gone, no ladder
            // brings it back, and a second attempt would only count
            // `retention_refusals` twice and spend a request on a question
            // already answered.
            if (err instanceof RetentionBoundary || (err instanceof HorizonStatusError && err.status === 410)) throw err;
            // Not a 503 and not final: the short ladder just probed page
            // size, it did not decide this was an outage. Give the full
            // normal ladder its one run before this error propagates.
            raw = await this.getJson<RawPage<T>>(currentUrl);
            break;
          }
        }
        raw = await this.getJson<RawPage<T>>(currentUrl);
        break;
      }
      const currentLimit = requestedLimit(currentUrl);
      const records = raw._embedded?.records ?? [];
      if (records.length === 0) return;
      if (previousShort) this.counters.inc("pages_truncated");
      yield records;
      previousShort = currentLimit !== null && records.length < currentLimit;
      url = raw._links?.next?.href ?? null;
    }
  }

  private async throttle(): Promise<void> {
    const now = this.clock.now().getTime();
    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.clock.now().getTime();
  }

  /**
   * The cache is keyed by URL and never expires, which is correct only for
   * an answer that cannot change: a closed ledger, a page of a closed range.
   * Two URLs do not have that property — `/ledgers?order=desc&limit=1` and
   * `/ledgers?order=asc&limit=1` name the two moving frontiers of history,
   * and their answers are different on every run. Cached, the head frontier
   * pins `latestLedger()` to whatever the first run saw, and `follow` then
   * computes an empty range for every account and exits 0 having read
   * nothing. Those callers pass `noCache`, which skips the read *and* the
   * write, so a frontier is never served from disk and never poisons it.
   */
  private cachePath(url: string): string | null {
    if (!this.cacheDir) return null;
    return join(this.cacheDir, createHash("sha256").update(url).digest("hex") + ".json");
  }

  private readCache(url: string): string | null {
    const p = this.cachePath(url);
    if (p === null || !existsSync(p)) return null;
    try {
      return readFileSync(p, "utf8");
    } catch {
      // A cache entry that cannot be read (e.g. something other than this
      // client occupies the path) is treated as a miss, not a crash.
      return null;
    }
  }

  private writeCache(url: string, text: string): void {
    const p = this.cachePath(url);
    if (p === null) return;
    try {
      writeFileSync(p, text, "utf8");
    } catch {
      this.counters.inc("cache_write_failed");
    }
  }
}

function requestedLimit(url: string): number | null {
  const m = /[?&]limit=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** Rewrites the `limit=` query parameter in place, keeping the rest of the URL (cursor included) untouched. */
function withLimit(url: string, limit: number): string {
  return url.replace(/([?&]limit=)\d+/, `$1${limit}`);
}
