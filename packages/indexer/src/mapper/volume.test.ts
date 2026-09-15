import { describe, it, expect } from "vitest";
import { validateObservation } from "@nonametrust/schema";
import { mapVolume } from "./volume.js";
import type { MapContext } from "./context.js";
import type { SourcePayment } from "../source/types.js";
import { randomAccount } from "../testing/keys.js";

const ctx: MapContext = { network: "stellar:pubnet", producerVersion: "0.1.0", fetchedAt: "2026-09-08T10:00:00.000Z" };

function payment(over: Partial<SourcePayment> = {}): SourcePayment {
  return {
    opId: "214720397313", ledger: 50, txHash: "ab".repeat(32), createdAt: "2026-09-01T08:00:05.000Z",
    kind: "payment", from: randomAccount(), to: randomAccount(),
    amount: "0.2500000", asset: { code: "USDC", issuer: randomAccount() },
    ...over,
  };
}

function ok(r: ReturnType<typeof mapVolume>[number]) {
  if (!r.ok) throw new Error(`dropped: ${r.reason}`);
  return r.observation;
}

describe("mapVolume", () => {
  it("maps a payment received by the followed account as direction in", () => {
    const p = payment();
    const o = ok(mapVolume([p], p.to, ctx)[0]!);
    expect(o.channel).toBe("volume");
    expect(o.kind).toBe("payment");
    expect(o.namespace).toEqual({ kind: "wallet", id: p.to });
    expect(o.payload).toEqual({ amount: "0.2500000", assetCode: "USDC", direction: "in" });
    expect(o.salienceHints).toEqual({ amount: "0.2500000" });
    expect(o.source.ref).toBe("op:214720397313");
    expect(o.source.network).toBe("stellar:pubnet");
    expect(validateObservation(o).ok).toBe(true);
  });

  it("maps the same payment for the sender as direction out", () => {
    const p = payment();
    const o = ok(mapVolume([p], p.from, ctx)[0]!);
    expect(o.namespace.id).toBe(p.from);
    expect((o.payload as { direction: string }).direction).toBe("out");
  });

  it("writes XLM for the native asset", () => {
    const p = payment({ asset: { code: "XLM", issuer: null } });
    expect((ok(mapVolume([p], p.to, ctx)[0]!).payload as { assetCode: string }).assetCode).toBe("XLM");
  });

  it("uses the source amount and asset on the sender side of a path payment", () => {
    const p = payment({ kind: "path_payment", sourceAmount: "1.0000000", sourceAsset: { code: "XLM", issuer: null } });
    const sender = ok(mapVolume([p], p.from, ctx)[0]!).payload as { amount: string; assetCode: string; direction: string };
    expect(sender).toEqual({ amount: "1.0000000", assetCode: "XLM", direction: "out" });
    const receiver = ok(mapVolume([p], p.to, ctx)[0]!).payload as { amount: string; assetCode: string };
    expect(receiver).toEqual({ amount: "0.2500000", assetCode: "USDC", direction: "in" });
    expect(ok(mapVolume([p], p.to, ctx)[0]!).kind).toBe("path_payment");
  });

  it("maps create_account with the funder out and the new account in", () => {
    const p = payment({ kind: "create_account", amount: "5.0000000", asset: { code: "XLM", issuer: null } });
    expect(ok(mapVolume([p], p.to, ctx)[0]!).kind).toBe("create_account");
    expect((ok(mapVolume([p], p.from, ctx)[0]!).payload as { direction: string }).direction).toBe("out");
  });

  it("carries the muxed id of the followed side into the namespace, never into the id", () => {
    const p = payment({ toMuxedId: "42" });
    const o = ok(mapVolume([p], p.to, ctx)[0]!);
    expect(o.namespace).toEqual({ kind: "wallet", id: p.to, muxedId: "42" });
    const sender = ok(mapVolume([p], p.from, ctx)[0]!);
    expect(sender.namespace).toEqual({ kind: "wallet", id: p.from });
  });

  it("drops a record whose followed side is not a checksum-valid base account", () => {
    const g = randomAccount();
    const bad = g.slice(0, -1) + (g.endsWith("A") ? "B" : "A");
    const p = payment({ to: bad });
    const r = mapVolume([p], bad, ctx)[0]!;
    expect(r).toEqual({ ok: false, reason: "invalid_account_id", ref: "op:214720397313" });
  });

  it("maps a self-payment once, as direction in", () => {
    const g = randomAccount();
    const p = payment({ from: g, to: g });
    const rs = mapVolume([p], g, ctx);
    expect(rs).toHaveLength(1);
    expect(ok(rs[0]!).payload).toMatchObject({ direction: "in" });
  });

  it("drops a record the followed account is not a party to", () => {
    const p = payment();
    expect(mapVolume([p], randomAccount(), ctx)[0]).toEqual({ ok: false, reason: "not_followed", ref: "op:214720397313" });
  });

  it("maps two SAC transfers of the same asset to one account as two observations, one ref per index", () => {
    const g = randomAccount();
    const issuer = randomAccount();
    const a = payment({ kind: "sac_transfer", to: g, amount: "1.5000000", asset: { code: "KALE", issuer }, transferIndex: 0 });
    const b = payment({ kind: "sac_transfer", to: g, amount: "2.2500000", asset: { code: "KALE", issuer }, transferIndex: 1 });
    const rs = mapVolume([a, b], g, ctx);
    expect(rs).toHaveLength(2);
    const first = ok(rs[0]!);
    const second = ok(rs[1]!);
    expect(first.kind).toBe("sac_transfer");
    expect(first.payload).toEqual({ amount: "1.5000000", assetCode: "KALE", direction: "in" });
    expect(first.source.ref).toBe("op:214720397313#0");
    expect(second.payload).toEqual({ amount: "2.2500000", assetCode: "KALE", direction: "in" });
    expect(second.source.ref).toBe("op:214720397313#1");
  });

  it("maps a SAC transfer in and a SAC transfer out in one invocation as one in and one out, different refs", () => {
    const g = randomAccount();
    const a = payment({ kind: "sac_transfer", to: g, amount: "1.0000000", asset: { code: "KALE", issuer: randomAccount() }, transferIndex: 0 });
    const b = payment({ kind: "sac_transfer", from: g, amount: "2.0000000", asset: { code: "USDC", issuer: randomAccount() }, transferIndex: 1 });
    const rs = mapVolume([a, b], g, ctx);
    expect(rs).toHaveLength(2);
    const first = ok(rs[0]!);
    const second = ok(rs[1]!);
    expect(first.payload).toMatchObject({ direction: "in", assetCode: "KALE" });
    expect(first.source.ref).toBe("op:214720397313#0");
    expect(second.payload).toMatchObject({ direction: "out", assetCode: "USDC" });
    expect(second.source.ref).toBe("op:214720397313#1");
  });

  it("maps a SAC self-transfer as one in observation", () => {
    const g = randomAccount();
    const p = payment({ kind: "sac_transfer", from: g, to: g, amount: "1.0000000", asset: { code: "KALE", issuer: randomAccount() }, transferIndex: 0 });
    const rs = mapVolume([p], g, ctx);
    expect(rs).toHaveLength(1);
    expect(ok(rs[0]!).payload).toMatchObject({ direction: "in" });
  });

  it("drops a SAC record the followed account is not a party to", () => {
    const p = payment({ kind: "sac_transfer", amount: "1.0000000", asset: { code: "KALE", issuer: randomAccount() }, transferIndex: 0 });
    const rs = mapVolume([p], randomAccount(), ctx);
    expect(rs).toEqual([{ ok: false, reason: "not_followed", ref: "op:214720397313" }]);
  });

  it("drops a SAC record with no transferIndex as validation_failed against the operation ref", () => {
    const g = randomAccount();
    const p = payment({ kind: "sac_transfer", to: g, amount: "1.0000000", asset: { code: "KALE", issuer: randomAccount() } });
    const rs = mapVolume([p], g, ctx);
    expect(rs).toEqual([{ ok: false, reason: "validation_failed", ref: "op:214720397313" }]);
  });
});
