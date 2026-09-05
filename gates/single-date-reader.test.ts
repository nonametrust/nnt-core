import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// `datedAt` in packages/schema/src/timing.ts is the only reader of a date off
// an observation. After narrowing on evidenceKind, observedAt and validFrom
// are both readable with full type support, and reading validFrom where a date
// was meant is the substitution that produced the study's S3 defect: a
// standing condition credited to every window including the seven-day one,
// while controls could not measure it at all.
//
// This gate lived inside packages/schema and derived its scan root from its
// own location, so it covered one package. The arithmetic most likely to break
// the claim is the window and decay code, which lands in other packages, so
// the gate sits at the repository root and scans every package instead. A new
// package enters under it on the day it is created, with no exemption.
//
// Exemptions are paths relative to packages/, never basenames: a later
// store/src/timing.ts must not inherit schema/src/timing.ts's exemption.
//
// The match is lexical. A line that names one of the fields anywhere, in a
// comment or a string literal as much as in code, is an offender: `o["validFrom"]`
// is a genuine read, and a gate with no tokenizer stays conservative rather
// than guess at which mentions are reads. A comment that trips it is reworded.
//
// Unlike the address gate beside this one, files come from the filesystem and
// not from `git ls-files`, so an untracked module is scanned too. That is what
// lets a probe file prove the gate fires without ever being committed.
const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));
const EXEMPT = new Set([
  "schema/src/observation.ts", // defines the fields
  "schema/src/timing.ts", // reads them, and is the only module that may
]);

// Every extension the tsconfig admits, so none of them is a way past, and both
// suffixes vitest collects, matching the build exclusion.
const SOURCE = /\.(ts|mts|cts|tsx)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx)$/;
const DATE_FIELDS = /\b(observedAt|validFrom|validUntil)\b/;

function packageSrcDirs(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(packagesDir, d.name, "src"))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

describe("dates on an observation", () => {
  // A scan over an empty list is green for free. The gate vouches for nothing
  // until it has found the package that defines the fields.
  it("are scanned in at least the package that defines them, so the gate cannot pass by scanning nothing", () => {
    const dirs = packageSrcDirs();
    expect(dirs.length, "no packages/*/src found; the gate is scanning nothing").toBeGreaterThan(0);
    expect(dirs.some((d) => d.endsWith("schema/src")), "packages/schema/src is not among the scanned trees")
      .toBe(true);
  });

  it("are read only by datedAt in packages/schema/src/timing.ts", () => {
    const offenders: string[] = [];
    for (const srcDir of packageSrcDirs()) {
      for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
        if (!SOURCE.test(entry.name) || TEST.test(entry.name)) continue;
        const file = join(entry.parentPath, entry.name);
        // stat follows a symlink; the dirent's own isFile() is false for one,
        // which let a symlinked module ship through tsc while a gate skipped it.
        if (!statSync(file).isFile()) continue;
        const rel = relative(packagesDir, file);
        if (EXEMPT.has(rel)) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (DATE_FIELDS.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      "these lines name a date field of an observation; go through datedAt() in packages/schema/src/timing.ts instead:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
