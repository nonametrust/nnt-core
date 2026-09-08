import { describe, it, expect } from "vitest";
import { validateObservation } from "@nonametrust/schema";
import { mapProtocol } from "./protocol.js";
import { issuerDigest } from "./issuers.js";
import type { MapContext } from "./context.js";
import type { SourceEffect } from "../source/types.js";
import { randomAccount } from "../testing/keys.js";

const ctx: MapContext = { network: "stellar:pubnet", producerVersion: "0.1.0", fetchedAt: "2026-09-08T10:00:00.000Z" };

function effect(over: Partial<SourceEffect> = {}): SourceEffect {
  return {
    effectId: "0214701113857-0000000001", opId: "214701113857", ledger: 49,
    createdAt: "2026-08-20T11:02:31.000Z", account: randomAccount(),
    type: "trustline_created", asset: { code: "USDC", issuer: randomAccount() },
    ...over,
  };
}

function ok(r: ReturnType<typeof mapProtocol>) {
  if (!r.ok) throw new Error(r.reason);
  return r.observation;
}

describe("mapProtocol", () => {
  it("maps trustline_created as a state with the effect name verbatim and issuerKnown filled", () => {
    const e = effect();
    const o = ok(mapProtocol(e, ctx));
    expect(o.channel).toBe("protocol");
    expect(o.evidenceKind).toBe("state");
    expect(o.kind).toBe("trustline_open");
    expect(o).toMatchObject({ validFrom: "2026-08-20T11:02:31.000Z", validUntil: null });
    expect(o.payload).toEqual({ event: "trustline_created", assetCode: "USDC", assetIssuer: e.asset!.issuer, issuerKnown: false });
    expect(o.source.ref).toBe("op:214701113857");
    expect(validateObservation(o).ok).toBe(true);
  });

  it("marks a known issuer", () => {
    const e = effect();
    const list = [{ digest: issuerDigest(e.asset!.issuer!), assetCode: "USDC", homeDomain: "t", note: "t" }];
    expect((ok(mapProtocol(e, ctx, list)).payload as { issuerKnown: boolean }).issuerKnown).toBe(true);
  });

  it("maps trustline_removed as an event with its own ref, never touching the state", () => {
    const e = effect({ type: "trustline_removed", opId: "214701113999", effectId: "0214701113999-0000000001", createdAt: "2026-08-25T00:00:00.000Z" });
    const o = ok(mapProtocol(e, ctx));
    expect(o.evidenceKind).toBe("event");
    expect(o.kind).toBe("trustline_closed");
    expect(o).toMatchObject({ observedAt: "2026-08-25T00:00:00.000Z" });
    expect(o.source.ref).toBe("op:214701113999");
    expect((o.payload as { event: string }).event).toBe("trustline_removed");
  });

  it("skips trustline_updated", () => {
    expect(mapProtocol(effect({ type: "trustline_updated" }), ctx))
      .toEqual({ ok: false, reason: "trustline_updated_skipped", ref: "op:214701113857" });
  });

  it("maps a claimable balance offered to the claimant", () => {
    const e = effect({ type: "claimable_balance_claimant_created", amount: "10.0000000" });
    const o = ok(mapProtocol(e, ctx));
    expect(o.kind).toBe("claimable_balance_offered");
    expect(o.evidenceKind).toBe("event");
    expect(o.namespace.id).toBe(e.account);
    expect(o.payload).toEqual({ event: "claimable_balance_claimant_created", assetCode: "USDC", assetIssuer: e.asset!.issuer, issuerKnown: false });
  });

  it("maps a native claimable balance without issuer fields", () => {
    const e = effect({ type: "claimable_balance_claimant_created", asset: { code: "XLM", issuer: null } });
    expect(ok(mapProtocol(e, ctx)).payload).toEqual({ event: "claimable_balance_claimant_created", assetCode: "XLM", issuerKnown: true });
  });

  it("maps account_flags_updated with no asset fields", () => {
    const { asset: _unused, ...e } = effect({ type: "account_flags_updated" });
    const o = ok(mapProtocol(e, ctx));
    expect(o.kind).toBe("account_flags_changed");
    expect(o.payload).toEqual({ event: "account_flags_updated" });
  });

  it("refuses an account that is not a base account", () => {
    expect(mapProtocol(effect({ account: "GOLDADDRESS" }), ctx))
      .toEqual({ ok: false, reason: "invalid_account_id", ref: "op:214701113857" });
  });
});
