import { OBSERVATION_SCHEMA_VERSION, type WireObservation } from "@nonametrust/schema";
import type { AccountId, SourceMemo } from "../source/types.js";
import { isBaseAccount } from "./address.js";
import { KINDS } from "./kinds.js";
import { source, type MapContext, type MapResult } from "./context.js";

/**
 * A memo belongs to the transaction, not to the operation, so the reference
 * is the transaction hash and there is one content observation per
 * (transaction, followed namespace). One per payment operation would emit the
 * same text once per operation and the tagging pipeline would count one memo
 * as several (spec section 5.3; proposed to the contract as the answer to its
 * first open point).
 *
 * Only text memos carry evidence. `id`, `hash` and `return` memos are
 * counted and not mapped; an empty text memo likewise.
 */
export function mapContent(memo: SourceMemo, followed: AccountId, createdAt: string, ctx: MapContext): MapResult {
  const ref = `tx:${memo.txHash}`;
  if (!isBaseAccount(followed)) return { ok: false, reason: "invalid_account_id", ref };
  if (memo.type !== "text") return { ok: false, reason: "memo_non_text", ref };
  const text = memo.text ?? "";
  if (text.length === 0) return { ok: false, reason: "memo_empty", ref };
  const observation: WireObservation = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    namespace: { kind: "wallet", id: followed },
    channel: "content",
    evidenceKind: "event",
    kind: KINDS.memo,
    observedAt: createdAt,
    source: source(ctx, ref),
    payload: { text, field: "memo" },
  };
  return { ok: true, observation };
}
