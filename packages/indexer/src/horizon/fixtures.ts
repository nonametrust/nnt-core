import type { HorizonEffectRecord, HorizonPaymentRecord } from "./records.js";
import { randomAccount } from "../testing/keys.js";

// Builders for Horizon-shaped records made at run time. No Horizon response
// is ever recorded into the repository: a recording carries real account ids
// and the root gate refuses them. This is the one place such records are
// built, so a future recording tool has one place to be refused.

/**
 * Overrides may carry `undefined` to remove a default field (a create_account
 * record has no `from`), which `Partial<T>` forbids under
 * exactOptionalPropertyTypes; the builders strip undefined keys.
 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

function withOverrides<T extends object>(base: T, over: Overrides<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

export function nextOpId(ledger: number, index = 1): string {
  return ((BigInt(ledger) << 32n) + BigInt(index << 12)).toString();
}

export function paymentRecord(over: Overrides<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  const id = over.id ?? nextOpId(100);
  return withOverrides(
    {
      id,
      paging_token: id,
      type: "payment",
      created_at: "2026-09-01T08:00:05Z",
      transaction_hash: "ab".repeat(32),
      transaction_successful: true,
      source_account: over.from ?? randomAccount(),
      from: randomAccount(),
      to: randomAccount(),
      amount: "0.2500000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: randomAccount(),
    },
    over,
  );
}

export function effectRecord(over: Overrides<HorizonEffectRecord> = {}): HorizonEffectRecord {
  const op = nextOpId(100);
  return withOverrides(
    {
      id: `${op.padStart(19, "0")}-0000000001`,
      paging_token: `${op}-1`,
      type: "trustline_created",
      created_at: "2026-08-20T11:02:31Z",
      account: randomAccount(),
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: randomAccount(),
    },
    over,
  );
}

/**
 * Horizon's cursor means "records after this paging token". A cursor that is
 * no record's token (cursorForLedger gives one) starts at the first record
 * whose token, read as the integer before any dash, is greater.
 */
function startIndex(all: Array<{ paging_token: string }>, cursor: string | null): number {
  if (cursor === null) return 0;
  const exact = all.findIndex((r) => r.paging_token === cursor);
  if (exact >= 0) return exact + 1;
  const c = BigInt(cursor.split("-")[0] ?? "0");
  const i = all.findIndex((r) => BigInt(r.paging_token.split("-")[0] ?? "0") > c);
  return i < 0 ? all.length : i;
}

/**
 * A fake Horizon that pages a fixed list per path in pages of `limit`,
 * honouring order=asc|desc and cursor. Routes are keyed by the path before
 * the query string; a route may also be a fixed status and body, for 404,
 * 410 and single-resource endpoints.
 */
export function fakeHorizon(
  routes: Record<string, unknown[] | { status: number; body?: unknown }>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (route === undefined) return new Response("{}", { status: 404 });
    if (!Array.isArray(route)) return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const cursor = url.searchParams.get("cursor");
    let all = route as Array<{ paging_token: string }>;
    if (url.searchParams.get("order") === "desc") all = [...all].reverse();
    const start = startIndex(all, cursor);
    const records = all.slice(start, start + limit);
    const last = records[records.length - 1];
    const next = new URL(url);
    if (last) next.searchParams.set("cursor", last.paging_token);
    const body = { _links: { next: { href: next.toString() } }, _embedded: { records } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
