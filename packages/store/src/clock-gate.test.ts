import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Every instant this package writes comes from the injected clock, and this
// is the gate on it.
//
// It is not a style rule. The whole retention design is a simulated calendar:
// `expiresAt` takes no clock so a backfill of last year expires a grace after
// last year's month closed, the sweep is told `now` rather than asking, and
// the producer cap's window is measured against the instant the caller
// supplied. Every one of those is provable in milliseconds because the clock
// is an argument. One `new Date()` inside a repository and the property is
// gone, and the suite that would notice is the one that no longer can, since
// the test would be comparing the wall clock against itself.
//
// The plan's own note was to exempt `clock.ts` ALONE. That is wrong and the
// tagging gate this copies already knew it: test files construct instants
// deliberately -- `fixedClock(new Date("2027-03-05"))` is the fixture, not a
// defect -- so they are skipped here exactly as `boundary.test.ts:139` skips
// them. What is held is that no MODULE reads the wall clock.
const srcDir = fileURLToPath(new URL("./", import.meta.url));

const SOURCE = /\.(ts|mts|cts|tsx)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx)$/;

// Copied deliberately rather than imported: this predicate and the tagging
// package's are the same rule held in two places that may not depend on each
// other, and the self-check below is what keeps a copy honest. Any mention of
// `Date.now`, called or merely referenced, and any `new Date` not followed by
// an argument -- JavaScript admits `new Date` with no parentheses at all, and
// that is the current instant as much as `new Date()` is. `new Date(x)` with
// an instant passed in is what this package is expected to write. The scan is
// per line, so `new Date(` with its argument on the next line is refused too;
// put the argument on the same line. `Date` in a type position never follows
// `new` and is untouched.
const CLOCK = /\bDate\.now\b|\bnew\s+Date\b(?!\s*\(\s*[^\s)])/;

// The one module allowed to read it, which is the whole point of having one.
const EXEMPT = new Set(["clock.ts"]);

interface SourceFile {
  rel: string;
  text: string;
  isTest: boolean;
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!SOURCE.test(entry.name)) continue;
    const abs = join(entry.parentPath, entry.name);
    // stat follows a symlink; the dirent's own isFile() is false for one.
    if (!statSync(abs).isFile()) continue;
    const rel = relative(srcDir, abs);
    out.push({ rel, text: readFileSync(abs, "utf8"), isTest: TEST.test(entry.name) });
  }
  return out;
}

function clockReads(text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (CLOCK.test(line)) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

describe("the store reads no clock but its own", () => {
  it("finds the modules it is meant to be scanning", () => {
    // A gate over an empty list passes. This one walks a package whose
    // modules move between directories, so it says out loud how many it
    // found and that the exempt file is among them -- a glob that stopped
    // matching would otherwise read as a clean bill of health.
    const files = sourceFiles().filter((f) => !f.isTest);
    expect(files.length).toBeGreaterThan(15);
    expect(files.map((f) => f.rel)).toContain("clock.ts");
    expect(files.map((f) => f.rel)).toContain("repositories/observation.ts");
  });

  it("reads no wall clock outside clock.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.isTest || EXEMPT.has(file.rel)) continue;
      for (const hit of clockReads(file.text)) offenders.push(`${file.rel}:${hit}`);
    }
    expect(offenders, "these lines read the wall clock:\n" + offenders.join("\n")).toEqual([]);
  });

  it("exempts one file and names it, so the allowance cannot widen quietly", () => {
    // Pinned lexically, because widening the set is invisible otherwise:
    // adding a module that happens to read no clock today passes, and the
    // day someone adds a `new Date()` to it the gate is already looking the
    // other way. Measured -- adding two modules to EXEMPT left every other
    // test here green.
    expect([...EXEMPT]).toEqual(["clock.ts"]);
  });

  it("still finds the clock inside clock.ts, so the exemption is doing work", () => {
    // Without this the exemption could be widened to the whole tree and
    // nothing would notice: a gate whose allowance is never exercised is
    // indistinguishable from a gate that was switched off.
    const clock = sourceFiles().find((f) => f.rel === "clock.ts");
    expect(clock).toBeDefined();
    expect(clockReads(clock!.text).length).toBeGreaterThan(0);
  });

  // The predicate, proven on planted lines before it is trusted over the
  // tree. Each refused form is a way to read the current instant; each
  // allowed form is what this package legitimately writes, and is the case a
  // widened pattern would break.
  describe("the clock predicate", () => {
    it.each([
      ["a call", "const t = Date.now();"],
      ["a reference, called later", "const clock = Date.now;"],
      ["new Date with empty parentheses", "const t = new Date();"],
      ["new Date with only whitespace inside", "const t = new Date( );"],
      ["new Date with no parentheses", "const t = new Date;"],
      ["new Date with the argument on the next line", "const t = new Date("],
    ])("refuses %s", (_form, line) => {
      expect(clockReads(line)).toEqual([`1: ${line}`]);
    });

    it.each([
      ["new Date given an instant", "const t = new Date(at);"],
      ["new Date given a literal", "const t = new Date(0);"],
      ["Date in a type position", "function next(at: Date): Date {"],
      ["Date as a generic argument", "const seen: Map<string, Date> = new Map();"],
      ["a constructor whose name starts with Date", "const r = new DateRange();"],
    ])("allows %s", (_form, line) => {
      expect(clockReads(line)).toEqual([]);
    });
  });
});
