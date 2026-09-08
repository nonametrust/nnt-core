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

  async getJson<T = unknown>(pathWithQuery: string): Promise<T> {
    const url = pathWithQuery.startsWith("http") ? pathWithQuery : `${this.baseUrl}${pathWithQuery}`;
    const cached = this.readCache(url);
    if (cached !== null) {
      this.counters.inc("cache_hits");
      return JSON.parse(cached) as T;
    }
    let attempt = 0;
    for (;;) {
      await this.throttle();
      this.counters.inc("requests");
      const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      if (res.status === 200) {
        const text = await res.text();
        let parsed: T;
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          throw new Error(`Horizon returned a non-JSON body for ${url}`);
        }
        this.writeCache(url, text);
        return parsed;
      }
      if (res.status === 410) {
        this.counters.inc("retention_refusals");
        throw new RetentionBoundary(`Horizon no longer serves ${url} (HTTP 410)`, url);
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
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
   */
  async *pages<T>(pathWithQuery: string): AsyncIterable<T[]> {
    const limit = requestedLimit(pathWithQuery);
    let url: string | null = pathWithQuery;
    let previousShort = false;
    while (url !== null) {
      const raw: RawPage<T> = await this.getJson<RawPage<T>>(url);
      const records = raw._embedded?.records ?? [];
      if (records.length === 0) return;
      if (previousShort) this.counters.inc("pages_truncated");
      yield records;
      previousShort = limit !== null && records.length < limit;
      url = raw._links?.next?.href ?? null;
    }
  }

  private async throttle(): Promise<void> {
    const now = this.clock.now().getTime();
    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.clock.now().getTime();
  }

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
