import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { datedAt } from "./timing.js";

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

describe("datedAt", () => {
  it("returns the instant for an event", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a state, so a state can never be dated", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "account_young",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
      source: src, payload: {},
    })).toBeNull();
  });

  it("dates an event by observedAt, not by when it was fetched or ingested", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "volume", evidenceKind: "event", kind: "payment",
      observedAt: "2026-09-05T09:00:00.000Z", source: src, payload: {},
      ingestedAt: "2026-09-05T11:00:00.000Z",
    })).toBe("2026-09-05T09:00:00.000Z");
  });

  it("returns null for a closed state as well as an open one", () => {
    expect(datedAt({
      schemaVersion: "0.1.0", namespace: { kind: "wallet", id: "G" },
      channel: "protocol", evidenceKind: "state", kind: "account_young",
      validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2026-09-03T00:00:00.000Z",
      source: src, payload: {},
    })).toBeNull();
  });

  // The claim in channel.ts and timing.ts is that datedAt is the only reader
  // of a date off an observation. After narrowing on evidenceKind, observedAt
  // and validFrom are both readable with full type support, and reading
  // validFrom where a date was meant is the substitution that produced the S3
  // defect. This test is the gate for that claim: every module in this package
  // other than the type definition and the reader must not name those fields.
  it("no module outside timing.ts reads a date off an observation", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    // Exempt by path relative to src, not by basename: a later
    // src/windows/timing.ts must not inherit the exemption for free.
    const exempt = new Set(["observation.ts", "timing.ts"]);
    // Every extension the tsconfig admits, so none of them is a way past.
    const source = /\.(ts|mts|cts|tsx)$/;
    const test = /\.test\.(ts|mts|cts|tsx)$/;
    const dateFields = /\b(observedAt|validFrom|validUntil)\b/;
    const offenders: string[] = [];
    for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!source.test(entry.name) || test.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      // stat follows a symlink; the dirent's own isFile() is false for one,
      // which let a symlinked module ship through tsc while this gate skipped it.
      if (!statSync(file).isFile()) continue;
      const rel = relative(srcDir, file);
      if (exempt.has(rel)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (dateFields.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "these lines read a date field off an observation; go through datedAt() in timing.ts instead:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
