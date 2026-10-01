import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// No module in this repository imports a test file.
//
// WHY IT IS A GATE AND WHY IT IS AT THE ROOT. Every clock gate in this tree
// SKIPS test files, deliberately: a fixture pinning `new Date("2027-03-05")` is
// a fixture and not a defect. So a helper named `util.test.ts` is scanned by
// nothing — and if a module imports it, that module's dependency reads the wall
// clock with no gate looking. Measured in the store: a `zz_helper.test.ts`
// exporting `() => Date.now()`, imported by a store module, left the store's
// clock gate and every root gate green, typechecked clean, and emitted
// `dist/zz_helper.test.js`.
//
// The only thing that caught any part of it was CI's "no test file reaches
// dist" step, which runs after a build, catches the FILE rather than the clock
// read, and does not run when a developer runs `pnpm test`.
//
// This rule was first written inside `packages/engine/src/boundary.test.ts`,
// where it covered one package. The hole it closes exists in every package, so
// it belongs here — in the idiom of `single-date-reader.test.ts`: the scan root
// is `packages/`, and a new package enters under it on the day it is created.
const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));

// Every extension the compiler admits and the plain-JavaScript ones: a `.js`
// beside a `.d.ts` typechecks, imports cleanly, and is invisible to a
// TypeScript-only pattern.
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx|js|mjs|cjs)$/;

// Anchored at statement position, because a gate file quotes import syntax as
// DATA and a lexical scan cannot tell a quoted example from a real import.
const SPECIFIER =
  /^[ \t]*(?:import|export)\b[^"'`;]*?\bfrom[ \t]*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']|^[ \t]*(?:const|let|var|export)\b[^;]*?\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;

/**
 * The text with its comments removed, line count preserved.
 *
 * Required before matching a specifier, both ways round: an apostrophe inside a
 * comment in the import clause terminates `[^"'`;]*?` and the import matches
 * NOTHING, and a commented-out import matches when it should not. Both were
 * measured on the gate this rule was lifted out of.
 */
function withoutComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlocks
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (c === "\\") { i++; continue; }
        if (quote !== null) { if (c === quote) quote = null; continue; }
        if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
        if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of withoutComments(text).matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) found.push(spec);
  }
  return found;
}

/**
 * Whether a specifier names a test module. The extension is optional because
 * TypeScript's NodeNext resolution wants `./util.test.js` for `util.test.ts`,
 * and a bare `./util.test` resolves too.
 */
export function isTestModule(spec: string): boolean {
  return TEST.test(spec) || /\.(test|spec)$/.test(spec);
}

/**
 * The test modules a file imports, given whether the file is itself a test. A
 * test importing a test is ordinary — shared fixtures live that way — so only a
 * MODULE is refused.
 */
export function testImports(file: { isTest: boolean; text: string }): string[] {
  if (file.isTest) return [];
  return specifiers(file.text).filter((spec) => isTestModule(spec));
}

interface SourceFile {
  rel: string;
  text: string;
  isTest: boolean;
}

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

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const srcDir of packageSrcDirs()) {
    for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!SOURCE.test(entry.name)) continue;
      const abs = join(entry.parentPath, entry.name);
      // stat follows a symlink; the dirent's own isFile() is false for one.
      if (!statSync(abs).isFile()) continue;
      out.push({
        rel: relative(packagesDir, abs),
        text: readFileSync(abs, "utf8"),
        isTest: TEST.test(entry.name),
      });
    }
  }
  return out;
}

describe("no module imports a test file", () => {
  it("scans every package, so the gate cannot pass by scanning nothing", () => {
    const dirs = packageSrcDirs();
    expect(dirs.length, "no packages/*/src found; the gate is scanning nothing").toBeGreaterThan(0);
    for (const required of ["store", "tagging", "schema", "engine", "indexer"]) {
      expect(
        dirs.some((d) => d.endsWith(join(required, "src"))),
        `packages/${required}/src is not among the scanned trees`,
      ).toBe(true);
    }
    // And it is seeing test files as well as modules, or the isTest split below
    // is untested over the tree.
    const files = sourceFiles();
    expect(files.some((f) => f.isTest), "no test files found; the isTest split is doing nothing").toBe(true);
    expect(files.some((f) => !f.isTest), "no modules found").toBe(true);
  });

  it("finds no module importing one", () => {
    const offenders = sourceFiles().flatMap((f) => testImports(f).map((spec) => `${f.rel}: ${spec}`));
    expect(
      offenders,
      "these modules import a test file, which no clock gate scans and which the " +
        "build then carries into dist; move the helper into a module:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  // The predicate, on files that do not exist. A tree scan over a clean tree
  // returns the same empty list whether it checks anything or not, so the rule
  // is held here and merely applied above.
  describe("the predicate", () => {
    const asModule = (text: string) => ({ isTest: false, text });
    const asTest = (text: string) => ({ isTest: true, text });

    it.each([
      ["a test module with the resolution extension", './util.test.js'],
      ["a spec module", './helpers.spec.js'],
      ["a test module with no extension", './util.test'],
      ["a test module in a subdirectory", './testing/fixtures.test.js'],
      ["a plain-JavaScript test module", './util.test.mjs'],
    ])("sees %s as a test module", (_form, spec) => {
      expect(isTestModule(spec)).toBe(true);
    });

    it.each([
      ["an ordinary module", "./policy.js"],
      ["a module whose name merely contains test", "./testing.js"],
      ["a directory named testing", "./testing/harness.js"],
      ["a package", "@nonametrust/store"],
      ["a node builtin", "node:crypto"],
    ])("does not see %s as a test module", (_form, spec) => {
      expect(isTestModule(spec)).toBe(false);
    });

    it("refuses a module importing one and allows a test importing one", () => {
      expect(testImports(asModule('import { nowMs } from "./util.test.js";'))).toEqual([
        "./util.test.js",
      ]);
      // A test sharing a fixture with another test is ordinary.
      expect(testImports(asTest('import { nowMs } from "./util.test.js";'))).toEqual([]);
      expect(testImports(asModule('import { nowMs } from "./util.js";'))).toEqual([]);
    });

    it("sees the import however it is written", () => {
      for (const line of [
        'import { h } from "./util.test.js";',
        'export { h } from "./util.test.js";',
        'import "./util.test.js";',
        'const m = await import("./util.test.js");',
        'const m = require("./util.test.js");',
      ]) {
        expect(testImports(asModule(line)), line).toEqual(["./util.test.js"]);
      }
    });

    it("reads past a comment in the import clause, and not a commented-out import", () => {
      const withComment = ['import {', '  h, // the store\'s only use', '} from "./util.test.js";'].join("\n");
      expect(testImports(asModule(withComment))).toEqual(["./util.test.js"]);
      expect(testImports(asModule('// import { h } from "./util.test.js";'))).toEqual([]);
    });

    it("does not read a quoted example as an import", () => {
      const quoted = `      expect(reads('import { h } from "./util.test.js";')).toEqual([]);`;
      expect(testImports(asModule(quoted))).toEqual([]);
    });
  });
});
