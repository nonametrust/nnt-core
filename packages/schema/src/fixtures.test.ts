import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CHANNELS } from "./channel.js";
import { validateObservation } from "./payloads.js";

const dir = new URL("../fixtures/", import.meta.url).pathname;
const packageRoot = new URL("../", import.meta.url).pathname;

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

  // No tracked file in this package may contain a real Stellar address. The
  // study this engine comes from shipped five real addresses in fixtures that
  // its README called synthetic, and its compiled artefacts identify defrauded
  // accounts. The gate rejects anything shaped like a StrKey account or muxed
  // account, checksum-valid or not, so a synthetic identifier has to be
  // obviously synthetic: short, like GPROVIDERADDRESS.
  it("no fixture or source file contains a Stellar-shaped address", () => {
    const strkey = /\b(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})\b/;
    const skip = new Set(["node_modules", "dist"]);
    const offenders: string[] = [];
    for (const entry of readdirSync(packageRoot, { recursive: true, withFileTypes: true })) {
      const file = join(entry.parentPath, entry.name);
      const rel = relative(packageRoot, file);
      if (!entry.isFile() || rel.split("/").some((seg) => skip.has(seg))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (strkey.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "these lines contain a Stellar-shaped address:\n" + offenders.join("\n"))
      .toEqual([]);
  });
});
