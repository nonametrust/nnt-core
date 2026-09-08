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

/**
 * The idempotency key for a volume observation carries (ref, channel,
 * namespace) and nothing about direction or asset: a Soroban invocation that
 * both pays the followed account and takes from it (a swap through a
 * contract) cannot yield two observations under one operation id without two
 * of them colliding on that key, and the contract forbids varying `ref` to
 * dodge it. So at most one volume observation comes out of one invocation
 * for one followed namespace. The "in" side wins over "out" when both are
 * present, because value reaching the counterparty is the evidence the
 * volume channel exists to carry; every other transfer record in the group —
 * the losing direction's records, and any record of a different asset than
 * the winning direction's first — still yields its own drop, so the loss
 * stays visible per record rather than folded away.
 */
function mapSac(group: SourcePayment[], followed: AccountId, ctx: MapContext, ref: string): MapResult[] {
  const ins = group.filter((p) => p.to === followed);
  const outs = group.filter((p) => p.from === followed && p.to !== followed);
  const foreign = group.filter((p) => p.to !== followed && p.from !== followed);

  const out: MapResult[] = foreign.map((): MapResult => ({ ok: false, reason: "not_followed", ref }));

  if (ins.length > 0) {
    out.push(...sumDirection(ins, followed, "in", ctx, ref));
    out.push(...outs.map((): MapResult => ({ ok: false, reason: "sac_bidirectional", ref })));
  } else if (outs.length > 0) {
    out.push(...sumDirection(outs, followed, "out", ctx, ref));
  }
  return out;
}

function sumDirection(
  records: SourcePayment[],
  followed: AccountId,
  direction: "in" | "out",
  ctx: MapContext,
  ref: string,
): MapResult[] {
  const firstAsset = records[0]!.asset;
  const same = records.filter((p) => sameAsset(p.asset, firstAsset));
  const other = records.filter((p) => !sameAsset(p.asset, firstAsset));
  const total = same.reduce((acc, p) => addDecimal(acc, p.amount), "0");
  const muxed = direction === "in" ? records[0]!.toMuxedId : records[0]!.fromMuxedId;
  return [
    build(records[0]!, followed, direction, total, firstAsset, muxed, ctx, ref),
    ...other.map((): MapResult => ({ ok: false, reason: "sac_multi_asset", ref })),
  ];
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
