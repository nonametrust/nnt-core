import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The indexer's mapper, run loop and everything else outside horizon/ works
// against `SourcePayment` / `SourceEffect` (source/types.ts), not against
// Horizon's own record shapes: the reader is the one seam that is supposed
// to absorb a Horizon change (spec section 2, "Horizon is on its way out").
// A module outside horizon/ importing HorizonPaymentRecord, or reaching past
// the reader into HorizonClient directly, defeats that seam quietly — it
// compiles, it may even pass its own tests, and the break only shows up the
// day Horizon's shape moves and two places need fixing instead of one.
//
// The rule, lexical over every tracked packages/indexer/src/**/*.ts file
// outside packages/indexer/src/horizon/ (lexical means a comment that spells
// out an offending import line trips it too; that fails safe, and such a
// comment has no reason to exist):
//   - no import or re-export whose specifier contains "horizon/records" —
//     the raw Horizon record types never leave horizon/, not even to the
//     composition root;
//   - no import or re-export whose specifier contains "horizon/client" or
//     "horizon/reader", except from packages/indexer/src/cli.ts and
//     packages/indexer/src/index.ts — cli.ts wires the concrete HorizonClient
//     and HorizonReader into a run (the composition root), and index.ts
//     re-exports the reader factory as the package's public surface
//     (index.ts's own comment: "nothing Horizon-specific is exported from
//     here except the reader factory"). Both are named, deliberate seams;
//     nothing else gets to reach past the reader.
//
// Test files are scanned too — a test that reaches into horizon/records.ts
// or horizon/client.ts to build its own fixtures is the same seam break,
// just from a test — except test files under src/horizon/ itself, which are
// the reader's own tests and are expected to know Horizon's shape.

const root = fileURLToPath(new URL("../", import.meta.url));
const pkgSrc = "packages/indexer/src/";
const horizonDir = `${pkgSrc}horizon/`;
const allowedForClientOrReader = new Set([`${pkgSrc}cli.ts`, `${pkgSrc}index.ts`]);

// One specifier per import/export "from" clause, plus dynamic import(...).
// [^;]*? between the keyword and `from` tolerates a multi-line named-import
// list; import statements in this codebase have no semicolon before their
// own `from` clause, so the non-greedy match cannot leak into the next
// statement.
const FROM_CLAUSE = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

interface Offense {
  rel: string;
  line: number;
  specifier: string;
  reason: "records" | "client-or-reader";
}

function scan(rel: string, text: string): Offense[] {
  const offenses: Offense[] = [];
  for (const re of [FROM_CLAUSE, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const specifier = m[1]!;
      if (specifier.includes("horizon/records")) {
        offenses.push({ rel, line: lineOf(text, m.index), specifier, reason: "records" });
      } else if (
        (specifier.includes("horizon/client") || specifier.includes("horizon/reader")) &&
        !allowedForClientOrReader.has(rel)
      ) {
        offenses.push({ rel, line: lineOf(text, m.index), specifier, reason: "client-or-reader" });
      }
    }
  }
  return offenses;
}

describe("indexer source outside horizon/", () => {
  // The sibling gate (no-stellar-address.test.ts) reported green the day it
  // was added because it enumerated tracked files while not yet tracked
  // itself. This gate vouches for nothing until it can see itself in the
  // list.
  it("this gate is tracked, so it cannot report green while unseen", () => {
    const self = relative(root, fileURLToPath(import.meta.url));
    expect(trackedFiles(), `${self} is not tracked; git add it before trusting this gate`)
      .toContain(self);
  });

  it("no module outside horizon/ imports the Horizon client or its record types", () => {
    const offenses: string[] = [];
    for (const rel of trackedFiles()) {
      if (!rel.startsWith(pkgSrc) || !rel.endsWith(".ts")) continue;
      if (rel.startsWith(horizonDir)) continue;
      const file = join(root, rel);
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      for (const o of scan(rel, text)) {
        offenses.push(`${o.rel}:${o.line}: imports "${o.specifier}" (${o.reason})`);
      }
    }
    expect(offenses, "these files reach past the reader into Horizon:\n" + offenses.join("\n"))
      .toEqual([]);
  });
});
