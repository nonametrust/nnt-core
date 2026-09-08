import { OBSERVATION_SCHEMA_VERSION, type NamespaceRef, type WireObservation } from "@nonametrust/schema";
import type { AccountId, SourceAsset, SourcePayment } from "../source/types.js";
import { isBaseAccount } from "./address.js";
import { KINDS } from "./kinds.js";
import { source, type MapContext, type MapResult } from "./context.js";

/**
 * Value moved. Direction is relative to the followed namespace: "in" when
 * value reached it, "out" when it left (contract section 6). One chain
 * payment yields an "in" observation for the receiver and an "out" one for
 * the sender, and the idempotency key, which carries the namespace, keeps
 * both; this mapper produces only the followed side.
 *
 * `group` holds every SourcePayment of one operation. For the classic
 * payment family that is one record. For a Soroban invocation it is one
 * record per asset_balance_changes transfer, and several transfers to one
 * account in one invocation are summed into one observation, because the key
 * admits one observation per (ref, channel, namespace) and the operation id
 * is the ref (spec section 5.6). A second asset in the same invocation is a
 * drop with reason sac_multi_asset, reported rather than worked around.
 */
export function mapVolume(group: SourcePayment[], followed: AccountId, ctx: MapContext): MapResult[] {
  const first = group[0];
  if (!first) return [];
  const ref = `op:${first.opId}`;
  if (!isBaseAccount(followed)) return [{ ok: false, reason: "invalid_account_id", ref }];
  if (first.kind === "sac_transfer") return mapSac(group, followed, ctx, ref);
  return mapClassic(first, followed, ctx, ref);
}

function mapClassic(p: SourcePayment, followed: AccountId, ctx: MapContext, ref: string): MapResult[] {
  const isTo = p.to === followed;
  const isFrom = p.from === followed;
  if (!isTo && !isFrom) return [{ ok: false, reason: "not_followed", ref }];
  const out: MapResult[] = [];
  if (isTo) {
    out.push(build(p, followed, "in", p.amount, p.asset, p.toMuxedId, ctx, ref));
  }
  if (isFrom) {
    if (isTo) {
      out.push({ ok: false, reason: "self_payment", ref });
    } else {
      const amount = p.sourceAmount ?? p.amount;
      const asset = p.sourceAsset ?? p.asset;
      out.push(build(p, followed, "out", amount, asset, p.fromMuxedId, ctx, ref));
    }
  }
  return out;
}

function mapSac(group: SourcePayment[], followed: AccountId, ctx: MapContext, ref: string): MapResult[] {
  const out: MapResult[] = [];
  for (const direction of ["in", "out"] as const) {
    const mine = group.filter((p) => (direction === "in" ? p.to === followed : p.from === followed));
    if (mine.length === 0) continue;
    const firstAsset = mine[0]!.asset;
    const same = mine.filter((p) => sameAsset(p.asset, firstAsset));
    const other = mine.filter((p) => !sameAsset(p.asset, firstAsset));
    const total = same.reduce((acc, p) => addDecimal(acc, p.amount), "0");
    const muxed = direction === "in" ? mine[0]!.toMuxedId : mine[0]!.fromMuxedId;
    out.push(build(mine[0]!, followed, direction, total, firstAsset, muxed, ctx, ref));
    if (other.length > 0) out.push({ ok: false, reason: "sac_multi_asset", ref });
  }
  if (out.length === 0) out.push({ ok: false, reason: "not_followed", ref });
  return out;
}

function build(
  p: SourcePayment,
  followed: AccountId,
  direction: "in" | "out",
  amount: string,
  asset: SourceAsset,
  muxedId: string | undefined,
  ctx: MapContext,
  ref: string,
): MapResult {
  const namespace: NamespaceRef = muxedId === undefined
    ? { kind: "wallet", id: followed }
    : { kind: "wallet", id: followed, muxedId };
  const observation: WireObservation = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    namespace,
    channel: "volume",
    evidenceKind: "event",
    kind: kindOf(p),
    observedAt: p.createdAt,
    source: source(ctx, ref),
    payload: { amount, assetCode: asset.code, direction },
    salienceHints: { amount },
  };
  return { ok: true, observation };
}

function kindOf(p: SourcePayment): string {
  switch (p.kind) {
    case "payment": return KINDS.payment;
    case "path_payment": return KINDS.pathPayment;
    case "create_account": return KINDS.createAccount;
    case "sac_transfer": return KINDS.sacTransfer;
  }
}

function sameAsset(a: SourceAsset, b: SourceAsset): boolean {
  return a.code === b.code && a.issuer === b.issuer;
}

/**
 * Stellar amounts carry seven decimals and travel as strings; a JSON number
 * would round them. Summing is done on stroops (integers) and rendered back
 * without a leading zero and without trailing garbage, in the form the
 * schema's decimalStringSchema admits.
 */
export function addDecimal(a: string, b: string): string {
  const stroops = (s: string): bigint => {
    const [whole, frac = ""] = s.split(".");
    return BigInt(whole ?? "0") * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
  };
  const total = stroops(a) + stroops(b);
  const whole = total / 10_000_000n;
  const frac = (total % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}
