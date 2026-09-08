import { OBSERVATION_SCHEMA_VERSION, type ProtocolPayload, type WireObservation } from "@nonametrust/schema";
import type { SourceAsset, SourceEffect } from "../source/types.js";
import { isBaseAccount } from "./address.js";
import { KINDS } from "./kinds.js";
import { KNOWN_ISSUERS, isKnownIssuer, type KnownIssuer } from "./issuers.js";
import { source, type MapContext, type MapResult } from "./context.js";

/**
 * Protocol-level facts about the followed account (contract section 6).
 * `payload.event` is Horizon's effect name verbatim; `kind` is ours. A
 * trustline that opens is a state and never rewritten; its closing is a
 * separate event with the closing operation's own reference. `issuerKnown`
 * is written on every observation that carries an asset, never left absent,
 * because the airdrop trap turns on issuerKnown === false and an absent
 * field would read as "unknown" rather than "unknown issuer".
 */
export function mapProtocol(
  e: SourceEffect,
  ctx: MapContext,
  issuers: readonly KnownIssuer[] = KNOWN_ISSUERS,
): MapResult {
  const ref = `op:${e.opId}`;
  if (!isBaseAccount(e.account)) return { ok: false, reason: "invalid_account_id", ref };
  const base = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    namespace: { kind: "wallet" as const, id: e.account },
    channel: "protocol" as const,
    source: source(ctx, ref),
  };
  switch (e.type) {
    case "trustline_created": {
      const observation: WireObservation = {
        ...base,
        evidenceKind: "state",
        kind: KINDS.trustlineOpen,
        validFrom: e.createdAt,
        validUntil: null,
        payload: assetPayload("trustline_created", e.asset, issuers),
      };
      return { ok: true, observation };
    }
    case "trustline_removed":
      return event(base, KINDS.trustlineClosed, e.createdAt, assetPayload("trustline_removed", e.asset, issuers));
    case "trustline_updated":
      return { ok: false, reason: "trustline_updated_skipped", ref };
    case "claimable_balance_claimant_created":
      return event(base, KINDS.claimableBalanceOffered, e.createdAt, assetPayload(e.type, e.asset, issuers));
    case "account_flags_updated":
      return event(base, KINDS.accountFlagsChanged, e.createdAt, { event: "account_flags_updated" });
  }
}

function event(
  base: Pick<WireObservation, "schemaVersion" | "namespace" | "channel" | "source">,
  kind: string,
  observedAt: string,
  payload: ProtocolPayload,
): MapResult {
  const observation: WireObservation = { ...base, evidenceKind: "event", kind, observedAt, payload };
  return { ok: true, observation };
}

function assetPayload(eventName: string, asset: SourceAsset | undefined, issuers: readonly KnownIssuer[]): ProtocolPayload {
  if (!asset) return { event: eventName };
  if (asset.issuer === null) return { event: eventName, assetCode: asset.code, issuerKnown: true };
  return {
    event: eventName,
    assetCode: asset.code,
    assetIssuer: asset.issuer,
    issuerKnown: isKnownIssuer(asset.issuer, issuers),
  };
}
