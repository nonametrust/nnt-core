import { OBSERVATION_SCHEMA_VERSION, type ProtocolPayload, type WireObservation } from "@nonametrust/schema";
import type { SourceAsset, SourceEffect } from "../source/types.js";
import { isBaseAccount } from "./address.js";
import { KINDS, type Kind } from "./kinds.js";
import { KNOWN_ISSUERS, isKnownIssuer, type KnownIssuer } from "./issuers.js";
import { source, type MapContext, type MapResult } from "./context.js";

/**
 * Protocol-level facts about the followed account (contract section 6).
 *
 * `payload.event` is ours, never the source's effect name (contract section
 * 11, item 9, and the decision on issue #3). The engine keys a `protocol`
 * baseline on `(namespace, channel, aspect)` with `event` as the aspect, so a
 * source-named `event` makes the key source-dependent: one counterparty read
 * through two readers splits into two histories, and no test catches it
 * because both are valid. The vocabulary is built on `kind` (issue #3), which
 * is why the two fields carry the same spelling here; they stay separate
 * fields because they answer different questions — `kind` what happened,
 * `event` which protocol fact it was.
 *
 * A trustline that opens is a state and never rewritten; its closing is a
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
        payload: assetPayload(KINDS.trustlineOpen, e.asset, issuers),
      };
      return { ok: true, observation };
    }
    case "trustline_removed":
      return event(base, KINDS.trustlineClosed, e.createdAt, assetPayload(KINDS.trustlineClosed, e.asset, issuers));
    case "trustline_updated":
      return { ok: false, reason: "trustline_updated_skipped", ref };
    case "claimable_balance_claimant_created":
      return event(base, KINDS.claimableBalanceOffered, e.createdAt, assetPayload(KINDS.claimableBalanceOffered, e.asset, issuers));
    case "account_flags_updated":
      return event(base, KINDS.accountFlagsChanged, e.createdAt, { event: KINDS.accountFlagsChanged });
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

/** `eventName` is our name for the protocol fact, taken from `KINDS`, never the source's effect name. */
function assetPayload(eventName: Kind, asset: SourceAsset | undefined, issuers: readonly KnownIssuer[]): ProtocolPayload {
  if (!asset) return { event: eventName };
  if (asset.issuer === null) return { event: eventName, assetCode: asset.code, issuerKnown: true };
  return {
    event: eventName,
    assetCode: asset.code,
    assetIssuer: asset.issuer,
    issuerKnown: isKnownIssuer(asset.issuer, issuers),
  };
}
