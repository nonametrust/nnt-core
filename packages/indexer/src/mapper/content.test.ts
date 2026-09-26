import { describe, it, expect } from "vitest";
import { validateObservation } from "@nonametrust/schema";
import { mapContent } from "./content.js";
import type { MapContext } from "./context.js";
import { randomAccount } from "../testing/keys.js";

const ctx: MapContext = { network: "stellar:pubnet", producerVersion: "0.1.0", fetchedAt: "2026-09-08T10:00:00.000Z" };
const hash = "cd".repeat(32);

describe("mapContent", () => {
  it("maps a text memo once per transaction, keyed on the transaction hash", () => {
    const g = randomAccount();
    const r = mapContent({ txHash: hash, type: "text", text: "claim your reward" }, g, "2026-09-01T08:00:05.000Z", ctx);
    if (!r.ok) throw new Error(r.reason);
    expect(r.observation.channel).toBe("content");
    expect(r.observation.kind).toBe("memo");
    expect(r.observation.source.ref).toBe(`tx:${hash}`);
    expect(r.observation.payload).toEqual({ text: "claim your reward", field: "memo" });
    expect(r.observation.namespace).toEqual({ kind: "wallet", id: g });
    expect(validateObservation(r.observation).ok).toBe(true);
  });

  it("drops id, hash and return memos as memo_non_text", () => {
    const g = randomAccount();
    for (const type of ["id", "hash", "return", "none"] as const) {
      expect(mapContent({ txHash: hash, type }, g, "2026-09-01T08:00:05.000Z", ctx))
        .toEqual({ ok: false, reason: "memo_non_text", ref: `tx:${hash}` });
    }
  });

  it("drops an empty text memo as memo_empty", () => {
    const g = randomAccount();
    expect(mapContent({ txHash: hash, type: "text", text: "" }, g, "2026-09-01T08:00:05.000Z", ctx))
      .toEqual({ ok: false, reason: "memo_empty", ref: `tx:${hash}` });
  });

  it("refuses a followed id that is not a base account", () => {
    expect(mapContent({ txHash: hash, type: "text", text: "x" }, "GOLDADDRESS", "2026-09-01T08:00:05.000Z", ctx))
      .toEqual({ ok: false, reason: "invalid_account_id", ref: `tx:${hash}` });
  });
});
