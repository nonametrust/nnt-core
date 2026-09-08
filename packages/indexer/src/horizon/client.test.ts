import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { HorizonClient, RetentionBoundary } from "./client.js";
import { fixedClock } from "../clock.js";
import { Counters } from "../counters.js";

const dir = mkdtempSync(join(tmpdir(), "nnt-horizon-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Route = (url: string) => { status: number; body: unknown };

/** A fake Horizon: routes by URL, records request times off the fake clock. */
function harness(route: Route, opts: { cacheDir?: string } = {}) {
  const clock = fixedClock(new Date("2026-09-08T00:00:00.000Z"));
  const counters = new Counters();
  const times: number[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    times.push(clock.now().getTime());
    const r = route(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    clock.advance(ms);
  };
  const client = new HorizonClient({
    baseUrl: "https://h.example", clock, counters, fetch: fetchImpl, sleep, ...opts,
  });
  return { client, counters, times, urls };
}

function page(records: unknown[], next: string | null) {
  return { _links: { next: next ? { href: next } : undefined }, _embedded: { records } };
}

describe("HorizonClient", () => {
  it("never issues two requests closer than the minimum interval", async () => {
    const h = harness(() => ({ status: 200, body: { ok: true } }));
    await h.client.getJson("/a");
    await h.client.getJson("/b");
    await h.client.getJson("/c");
    expect(h.times[1]! - h.times[0]!).toBeGreaterThanOrEqual(1250);
    expect(h.times[2]! - h.times[1]!).toBeGreaterThanOrEqual(1250);
    expect(h.counters.get("requests")).toBe(3);
  });

  it("turns HTTP 410 into RetentionBoundary and counts it", async () => {
    const h = harness(() => ({ status: 410, body: { title: "Gone" } }));
    await expect(h.client.getJson("/ledgers/1/payments")).rejects.toBeInstanceOf(RetentionBoundary);
    expect(h.counters.get("retention_refusals")).toBe(1);
  });

  it("backs off and retries on 429, then succeeds", async () => {
    let n = 0;
    const h = harness(() => (++n < 3 ? { status: 429, body: {} } : { status: 200, body: { n } }));
    expect(await h.client.getJson("/x")).toEqual({ n: 3 });
    expect(h.counters.get("retries")).toBe(2);
    expect(h.times[2]! - h.times[1]!).toBeGreaterThan(h.times[1]! - h.times[0]!);
  });

  it("gives up after maxRetries and throws the last status", async () => {
    const h = harness(() => ({ status: 503, body: {} }));
    await expect(h.client.getJson("/x")).rejects.toThrow(/503/);
  });

  it("follows next links until an empty page and yields each page", async () => {
    const h = harness((url) => {
      if (url.endsWith("/p")) return { status: 200, body: page([1, 2], "https://h.example/p?cursor=2") };
      if (url.endsWith("cursor=2")) return { status: 200, body: page([3], "https://h.example/p?cursor=3") };
      return { status: 200, body: page([], null) };
    });
    const pages: unknown[][] = [];
    for await (const p of h.client.pages<number>("/p")) pages.push(p);
    expect(pages).toEqual([[1, 2], [3]]);
  });

  it("counts a short page that is followed by a non-empty one as truncated", async () => {
    const h = harness((url) => {
      if (url.includes("cursor=3")) return { status: 200, body: page([], null) };
      if (url.includes("cursor=1")) return { status: 200, body: page([2, 3], "https://h.example/p?cursor=3&limit=2") };
      return { status: 200, body: page([1], "https://h.example/p?cursor=1&limit=2") };
    });
    const all: number[] = [];
    for await (const p of h.client.pages<number>("/p?limit=2")) all.push(...p);
    expect(all).toEqual([1, 2, 3]);
    expect(h.counters.get("pages_truncated")).toBe(1);
  });

  it("serves a repeated URL from the cache without a request, and writes only on 200", async () => {
    let status = 500;
    const h = harness(() => ({ status, body: { v: 1 } }), { cacheDir: dir });
    await expect(h.client.getJson("/c")).rejects.toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
    status = 200;
    await h.client.getJson("/c");
    expect(readdirSync(dir)).toHaveLength(1);
    const before = h.counters.get("requests");
    expect(await h.client.getJson("/c")).toEqual({ v: 1 });
    expect(h.counters.get("requests")).toBe(before);
    expect(h.counters.get("cache_hits")).toBe(1);
  });
});
