import type { Counters } from "../counters.js";
import { isContractAddress, resolveAccount } from "../mapper/address.js";
import type { SourceReader } from "../source/reader.js";
import type {
  AccountId, EffectType, LedgerRange, MemoType, SourceAsset, SourceEffect, SourceMemo, SourcePayment,
} from "../source/types.js";
import { HorizonClient, HorizonStatusError, RetentionBoundary } from "./client.js";
import type { HorizonEffectRecord, HorizonPaymentRecord } from "./records.js";

const PAGE_LIMIT = 200;
const EFFECT_TYPES: ReadonlySet<string> = new Set<EffectType>([
  "trustline_created", "trustline_removed", "trustline_updated",
  "claimable_balance_claimant_created", "account_flags_updated",
]);

/** A Horizon operation id is (ledger << 32) | (tx index << 12) | op index. */
export function ledgerOfOperation(opId: string): number {
  return Number(BigInt(opId) >> 32n);
}

/** The first possible operation id of a ledger, usable as a paging cursor. */
export function cursorForLedger(ledger: number): string {
  return (BigInt(ledger) << 32n).toString();
}

function ledgerOfEffect(effectId: string): number {
  return ledgerOfOperation(effectId.split("-")[0] ?? "0");
}

function opOfEffect(effectId: string): string {
  return BigInt(effectId.split("-")[0] ?? "0").toString();
}

function toIso(horizonTime: string): string {
  return new Date(horizonTime).toISOString();
}

function asset(assetType: string | undefined, code: string | undefined, issuer: string | undefined): SourceAsset {
  if (assetType === "native" || assetType === undefined) return { code: "XLM", issuer: null };
  return { code: code ?? "", issuer: issuer ?? null };
}

function assetFromString(s: string): SourceAsset {
  if (s === "native") return { code: "XLM", issuer: null };
  const [code, issuer] = s.split(":");
  return { code: code ?? "", issuer: issuer ?? null };
}

/**
 * Horizon behind the SourceReader seam. Reads oldest-first from the range's
 * first possible operation id, stops at the first record past the range, and
 * refuses a range that starts before the retention floor rather than
 * reporting it empty (spec section 11).
 */
export class HorizonReader implements SourceReader {
  constructor(private readonly client: HorizonClient, private readonly counters: Counters) {}

  async *payments(account: AccountId, range: LedgerRange): AsyncIterable<SourcePayment> {
    await this.assertServed(range);
    const path = `/accounts/${account}/payments?order=asc&limit=${PAGE_LIMIT}&join=transactions&cursor=${cursorForLedger(range.from)}`;
    for await (const page of this.client.pages<HorizonPaymentRecord>(path)) {
      for (const rec of page) {
        const result = this.readRecord(rec, range);
        if (result === "stop") return;
        yield* result;
      }
    }
  }

  /**
   * The per-record decision shared by `payments` and `globalPayments`, so the
   * two scans cannot drift on what they count: a range-in-order stop signal,
   * a skip of a record before the range, or the counted read (and, on a
   * failed transaction, the counted skip) before normalising.
   */
  private readRecord(rec: HorizonPaymentRecord, range: LedgerRange): Iterable<SourcePayment> | "stop" {
    const ledger = ledgerOfOperation(rec.id);
    if (ledger > range.to) return "stop";
    if (ledger < range.from) return [];
    this.counters.inc(`records_read.${rec.type}`);
    if (!rec.transaction_successful) {
      // A drop with a reason, not a bare counter: the record was read and
      // refused, so it belongs in the report's drop table like every other
      // record the indexer decided not to map.
      this.counters.drop("failed_transaction", `op:${rec.id}`);
      return [];
    }
    return this.normalisePayment(rec, ledger);
  }

  private *normalisePayment(rec: HorizonPaymentRecord, ledger: number): Iterable<SourcePayment> {
    const base = {
      opId: rec.id, ledger, txHash: rec.transaction_hash, createdAt: toIso(rec.created_at),
    };
    const memo = rec.transaction ? memoOf(rec.transaction) : undefined;
    const withMemo = <T extends object>(p: T): T & { memo?: SourceMemo } => (memo ? { ...p, memo } : p);
    switch (rec.type) {
      case "payment":
      case "path_payment_strict_send":
      case "path_payment_strict_receive": {
        const from = side(rec.from, rec.from_muxed_id);
        const to = side(rec.to, rec.to_muxed_id);
        if (!from || !to) { this.counters.drop("invalid_account_id", `op:${rec.id}`); return; }
        const p: SourcePayment = withMemo({
          ...base,
          kind: rec.type === "payment" ? "payment" : "path_payment",
          from: from.base, to: to.base,
          ...(from.muxedId !== undefined ? { fromMuxedId: from.muxedId } : {}),
          ...(to.muxedId !== undefined ? { toMuxedId: to.muxedId } : {}),
          amount: rec.amount ?? "0",
          asset: asset(rec.asset_type, rec.asset_code, rec.asset_issuer),
          ...(rec.type === "payment" ? {} : {
            sourceAmount: rec.source_amount ?? "0",
            sourceAsset: asset(rec.source_asset_type, rec.source_asset_code, rec.source_asset_issuer),
          }),
        });
        yield p;
        return;
      }
      case "create_account": {
        const from = side(rec.funder, undefined);
        const to = side(rec.account, undefined);
        if (!from || !to) { this.counters.drop("invalid_account_id", `op:${rec.id}`); return; }
        yield withMemo({
          ...base, kind: "create_account", from: from.base, to: to.base,
          amount: rec.starting_balance ?? "0", asset: { code: "XLM", issuer: null },
        });
        return;
      }
      case "invoke_host_function": {
        const changes = rec.asset_balance_changes ?? [];
        for (const [i, c] of changes.entries()) {
          if (c.type !== "transfer") { this.counters.drop("sac_non_transfer", `op:${rec.id}#${i}`); continue; }
          const from = side(c.from, undefined) ?? contractSide(c.from);
          const to = side(c.to, c.destination_muxed_id) ?? contractSide(c.to);
          if (!from || !to) { this.counters.drop("invalid_account_id", `op:${rec.id}#${i}`); continue; }
          yield withMemo({
            ...base, kind: "sac_transfer", from: from.base, to: to.base,
            ...(to.muxedId !== undefined ? { toMuxedId: to.muxedId } : {}),
            amount: c.amount, asset: asset(c.asset_type, c.asset_code, c.asset_issuer), transferIndex: i,
          });
        }
        return;
      }
      default:
        this.counters.drop("unsupported_type", `op:${rec.id}`);
    }
  }

  async *effects(account: AccountId, range: LedgerRange): AsyncIterable<SourceEffect> {
    await this.assertServed(range);
    const path = `/accounts/${account}/effects?order=asc&limit=${PAGE_LIMIT}&cursor=${cursorForLedger(range.from)}-0`;
    for await (const page of this.client.pages<HorizonEffectRecord>(path)) {
      for (const rec of page) {
        const ledger = ledgerOfEffect(rec.id);
        if (ledger > range.to) return;
        if (ledger < range.from) continue;
        this.counters.inc(`effects_read.${rec.type}`);
        if (!EFFECT_TYPES.has(rec.type)) { this.counters.drop("effect_ignored", `effect:${rec.id}`); continue; }
        const e: SourceEffect = {
          effectId: rec.id, opId: opOfEffect(rec.id), ledger, createdAt: toIso(rec.created_at),
          account: rec.account, type: rec.type as EffectType,
        };
        if (rec.asset !== undefined) e.asset = assetFromString(rec.asset);
        else if (rec.asset_type !== undefined) e.asset = asset(rec.asset_type, rec.asset_code, rec.asset_issuer);
        if (rec.amount !== undefined) e.amount = rec.amount;
        yield e;
      }
    }
  }

  async memo(txHash: string): Promise<SourceMemo | null> {
    try {
      const tx = await this.client.getJson<{ hash: string; memo_type: string; memo?: string }>(`/transactions/${txHash}`);
      return memoOf(tx);
    } catch (e) {
      if (e instanceof HorizonStatusError && e.status === 404) return null;
      throw e;
    }
  }

  /** The retention wall moves forward; a cached answer would be a wall that fell in the past. */
  async retentionFloor(): Promise<number> {
    const page = await this.client.getJson<{ _embedded: { records: Array<{ sequence: number }> } }>("/ledgers?order=asc&limit=1", { noCache: true });
    const first = page._embedded.records[0];
    if (!first) throw new Error("Horizon returned no ledgers");
    return first.sequence;
  }

  /** The head of the chain; cached, `follow` would never see a ledger it has not already read. */
  async latestLedger(): Promise<number> {
    const page = await this.client.getJson<{ _embedded: { records: Array<{ sequence: number }> } }>("/ledgers?order=desc&limit=1", { noCache: true });
    const last = page._embedded.records[0];
    if (!last) throw new Error("Horizon returned no ledgers");
    return last.sequence;
  }

  /**
   * Instants to ledger sequences, by bisection over /ledgers/{seq}. About
   * twenty-five requests per bound on a fourteen-month window. A closed
   * ledger never changes, so the bisection itself is cached and a repeated
   * run pays only the two uncached frontier requests.
   */
  async resolveRange(fromIso: string, toIso: string): Promise<LedgerRange> {
    const floor = await this.retentionFloor();
    const latest = await this.latestLedger();
    const closedAt = async (seq: number): Promise<number> => {
      const l = await this.client.getJson<{ closed_at: string }>(`/ledgers/${seq}`);
      return Date.parse(l.closed_at);
    };
    // First ledger closed at or after `t`.
    const firstAtOrAfter = async (t: number): Promise<number> => {
      let lo = floor, hi = latest;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await closedAt(mid)) >= t) hi = mid; else lo = mid + 1;
      }
      return lo;
    };
    const from = await firstAtOrAfter(Date.parse(fromIso));
    const to = (await firstAtOrAfter(Date.parse(toIso))) - 1;
    if (from > to) throw new Error(`empty range: ${fromIso} to ${toIso} covers no ledger`);
    return { from, to };
  }

  /** All payment-family records on the network inside the range; for account selection. */
  async *globalPayments(range: LedgerRange): AsyncIterable<SourcePayment> {
    await this.assertServed(range);
    const path = `/payments?order=asc&limit=${PAGE_LIMIT}&cursor=${cursorForLedger(range.from)}`;
    for await (const page of this.client.pages<HorizonPaymentRecord>(path)) {
      for (const rec of page) {
        const result = this.readRecord(rec, range);
        if (result === "stop") return;
        yield* result;
      }
    }
  }

  async accountExists(id: AccountId): Promise<boolean> {
    try {
      await this.client.getJson(`/accounts/${id}`);
      return true;
    } catch (e) {
      if (e instanceof HorizonStatusError && e.status === 404) return false;
      throw e;
    }
  }

  private floorCache: number | null = null;
  private async assertServed(range: LedgerRange): Promise<void> {
    if (this.floorCache === null) this.floorCache = await this.retentionFloor();
    if (range.from < this.floorCache) {
      this.counters.inc("retention_refusals");
      throw new RetentionBoundary(
        `range starts at ledger ${range.from}, Horizon serves from ${this.floorCache}`,
        "/ledgers?order=asc&limit=1",
      );
    }
  }
}

function side(id: string | undefined, muxedId: string | undefined): { base: AccountId; muxedId?: string } | null {
  if (id === undefined) return null;
  const r = resolveAccount(id);
  if (r === null) return null;
  if (muxedId !== undefined) return { base: r.base, muxedId };
  return r;
}

/**
 * `invoke_host_function` only: a Soroban transfer's other side is routinely a
 * contract (a pool or a DEX paying the followed wallet, or the wallet paying
 * one). Kept verbatim, with no muxed id — a contract is never muxed. Not
 * folded into `side()`, which stays G/M only for the classic payment family,
 * where a contract can never be a party.
 */
function contractSide(id: string | undefined): { base: AccountId; muxedId?: string } | null {
  if (id === undefined) return null;
  return isContractAddress(id) ? { base: id } : null;
}

function memoOf(tx: { hash: string; memo_type: string; memo?: string }): SourceMemo {
  const type = (["none", "text", "id", "hash", "return"].includes(tx.memo_type) ? tx.memo_type : "none") as MemoType;
  return type === "text" ? { txHash: tx.hash, type, text: tx.memo ?? "" } : { txHash: tx.hash, type };
}
