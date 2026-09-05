import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "./channel.js";
import { validateObservation } from "./payloads.js";

const dir = new URL("../fixtures/", import.meta.url).pathname;

function fixture(channel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, `${channel}.json`), "utf8"));
}

describe("golden fixtures", () => {
  it("has one fixture per channel", () => {
    const names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    expect(names.sort()).toEqual([...CHANNELS].sort());
  });

  it("every fixture validates", () => {
    for (const c of CHANNELS) {
      const raw = JSON.parse(readFileSync(join(dir, `${c}.json`), "utf8"));
      expect(validateObservation(raw).ok, `${c} fixture failed`).toBe(true);
    }
  });

  it("re-reading the same source event yields the same key", () => {
    const raw = JSON.parse(readFileSync(join(dir, "volume.json"), "utf8"));
    const a = validateObservation(raw);
    const b = validateObservation({
      ...raw,
      source: { ...raw.source, fetchedAt: "2027-01-01T00:00:00.000Z" },
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.idempotencyKey).toBe(b.value.idempotencyKey);
  });

  // The seven fixtures are one counterparty's history, so a reader can follow
  // them as a story rather than as seven unrelated samples.
  it("all fixtures share one namespace", () => {
    const namespaces = new Set(CHANNELS.map((c) => JSON.stringify(fixture(c).namespace)));
    expect([...namespaces]).toHaveLength(1);
  });

  // Both arms of the evidence union must be exercised by the fixtures, so a
  // change that breaks one arm fails here and not first in the indexer.
  it("protocol is the one state fixture, holding with an open end; the rest are events", () => {
    for (const c of CHANNELS) {
      const f = fixture(c);
      if (c === "protocol") {
        expect(f.evidenceKind).toBe("state");
        expect(f.validUntil).toBeNull();
        expect(f).not.toHaveProperty("observedAt");
      } else {
        expect(f.evidenceKind, `${c} should be an event`).toBe("event");
        expect(f).not.toHaveProperty("validFrom");
      }
    }
  });

  // One chain event may yield several observations, one per channel. The
  // volume and content fixtures are deliberately read off the same operation
  // and must still be distinct observations.
  it("the seven fixtures carry seven distinct idempotency keys", () => {
    const keys = new Set<string>();
    for (const c of CHANNELS) {
      const r = validateObservation(fixture(c));
      if (r.ok) keys.add(r.value.idempotencyKey);
    }
    expect(keys.size).toBe(CHANNELS.length);
    expect(fixture("volume").source).toEqual(fixture("content").source);
  });

  // The advertised pay-to address lives in the 402 response, which the gateway
  // sees; the chain indexer only sees payments landing somewhere else. And one
  // observation is one transition: the day-twelve revert is a second
  // observation with its own reference, not a flag on this one.
  it("the address change is one transition, seen by the gateway", () => {
    const f = fixture("address_integrity");
    expect((f.source as { producer: string }).producer).toBe("x402-gateway");
    expect(Object.keys(f.payload as object).sort()).toEqual(["current", "previous"]);
  });

  // The day-twelve scenario is two observations, not one with a flag: the
  // advertised address moves away in the morning and moves back the same day,
  // each seen by the gateway under its own request reference. The anomaly the
  // engine looks for is exactly that pair within one day.
  describe("day twelve", () => {
    const dayTwelve = join(dir, "day-twelve");
    const away = JSON.parse(readFileSync(join(dayTwelve, "address-moved-away.json"), "utf8"));
    const back = JSON.parse(readFileSync(join(dayTwelve, "address-moved-back.json"), "utf8"));

    it("both observations validate", () => {
      expect(validateObservation(away).ok, "moved-away failed").toBe(true);
      expect(validateObservation(back).ok, "moved-back failed").toBe(true);
    });

    it("the move back reverses the move away", () => {
      expect(back.payload.previous).toBe(away.payload.current);
      expect(back.payload.current).toBe(away.payload.previous);
    });

    it("the two carry different source references and derive different keys", () => {
      expect(back.source.ref).not.toBe(away.source.ref);
      const a = validateObservation(away);
      const b = validateObservation(back);
      if (a.ok && b.ok) expect(a.value.idempotencyKey).not.toBe(b.value.idempotencyKey);
      else expect.fail("one of the day-twelve observations did not validate");
    });

    it("both happen on day twelve, and the move back comes after the move away", () => {
      expect(away.observedAt).toMatch(/^2026-09-12T/);
      expect(back.observedAt).toMatch(/^2026-09-12T/);
      expect(Date.parse(back.observedAt)).toBeGreaterThan(Date.parse(away.observedAt));
    });
  });

  // The gate that no tracked file contains a Stellar-shaped address lives at
  // the repository root, gates/no-stellar-address.test.ts, and scans every
  // tracked file, these fixtures included. It used to live here and covered
  // one package; the repository goes public at the v0 tag, so it covers all.
});
