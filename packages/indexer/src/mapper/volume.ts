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
 * payment family that is one record on today's Horizon. For a Soroban
 * invocation it is one record per asset_balance_changes transfer, and each
 * transfer is mapped to its own observation, one per record (section below
 * on `ref`). Either way every record of the group is mapped and yields
 * exactly one result, an observation or a drop with a reason; a classic
 * group that ever held two records would otherwise lose the second one
 * silently.
 */
export function mapVolume(group: SourcePayment[], followed: AccountId, ctx: MapContext): MapResult[] {
  const first = group[0];
  if (!first) return [];
  const ref = `op:${first.opId}`;
  if (!isBaseAccount(followed)) return [{ ok: false, reason: "invalid_account_id", ref }];
  if (first.kind === "sac_transfer") return group.map((p) => mapSacRecord(p, followed, ctx));
  // Every record of the group, not just the first: a record that is mapped
  // by nobody is a record that left the identity
  // records_read.payments == written.payments + dropped.payments (run.ts)
  // one short, and it would be invisible, having produced neither an
  // observation nor a drop.
  return group.flatMap((p) => mapClassic(p, followed, ctx, `op:${p.opId}`));
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
      // A self-payment (from === to === followed) is one record and one
      // observation: the "in" side already covers it, so no second result
      // and no self_payment drop, or the record would count twice against
      // records_read.payments.
    } else {
      const amount = p.sourceAmount ?? p.amount;
      const asset = p.sourceAsset ?? p.asset;
      out.push(build(p, followed, "out", amount, asset, p.fromMuxedId, ctx, ref));
    }
  }
  return out;
}

/**
 * The contract owner ruled that `source.ref` identifies one value movement,
 * not an operation (2026-09-15): for a Soroban invocation, each entry of
 * `asset_balance_changes` is its own movement, so it gets its own ref,
 * `op:<id>#<transferIndex>`. `transferIndex` is the entry's position inside
 * the operation's `asset_balance_changes` array, which Horizon derives from
 * the transaction meta's event order; that order is immutable once the
 * ledger closes and identical in any source that reads the same meta, which
 * is exactly what a ref needs. A semantic separator such as asset plus
 * direction is not unique — two transfers of the same asset in the same
 * direction inside one invocation would collide on it — so the index is used
 * instead of a derived key.
 *
 * Each record is mapped independently: a record where the followed account
 * is `to` yields one "in" observation; a record where it is `from` (and not
 * `to`) yields one "out" observation; a self-transfer (`from === to ===
 * followed`) yields one "in" observation, because the `to` branch already
 * covers it; a record the followed account is not party to is a
 * `not_followed` drop. `transferIndex` is required to form a ref for any of
 * these observations; a SAC record without one is a `validation_failed` drop
 * against the operation's own ref, since no per-movement ref can be formed.
 */
function mapSacRecord(p: SourcePayment, followed: AccountId, ctx: MapContext): MapResult {
  const opRef = `op:${p.opId}`;
  const isTo = p.to === followed;
  const isFrom = p.from === followed;
  if (!isTo && !isFrom) return { ok: false, reason: "not_followed", ref: opRef };
  if (p.transferIndex === undefined) return { ok: false, reason: "validation_failed", ref: opRef };
  const ref = `${opRef}#${p.transferIndex}`;
  if (isTo) return build(p, followed, "in", p.amount, p.asset, p.toMuxedId, ctx, ref);
  return build(p, followed, "out", p.amount, p.asset, p.fromMuxedId, ctx, ref);
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
