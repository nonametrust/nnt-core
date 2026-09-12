import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// This package depends on @nonametrust/schema and on nothing else, and that
// is what makes the milestone provable without a database: tagging is
// arithmetic, and arithmetic whose determinism must hold over a fixed corpus
// should not need a cluster to show it. The parent spec's dependency table
// says so; this file is the gate on it, because a dependency added to
// package.json or an import added to a module would otherwise be noticed by
// nobody until the store's suite started failing in here.
//
// Three more properties are held lexically, in the idiom of the root gates.
// The clock is an argument and never read, so the day-twelve to
// day-twenty-one corpus runs in milliseconds. No test opens a database,
// because a suite that needs one would fail for the reason the store's
// deliberately does. And the decayed strength of a tag is an input, so the
// package never names the module that computes it.
const srcDir = fileURLToPath(new URL("./", import.meta.url));
const pkgDir = fileURLToPath(new URL("../", import.meta.url));

const SOURCE = /\.(ts|mts|cts|tsx)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx)$/;
// Static imports and re-exports with a `from`, bare side-effect imports, and
// dynamic imports of a string literal. A dynamic import of an expression is
// not matched and is refused below by a separate check, so it is not a way
// past.
const SPECIFIER =
  /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_EXPRESSION = /\bimport\s*\(\s*[^"')]/;
// Any mention of Date.now, called or merely referenced, and any `new Date`
// not followed by an argument. JavaScript admits `new Date` with no
// parentheses at all, and that is the current instant as much as `new Date()`
// is, so the construction is refused unless an opening parenthesis is followed
// by something other than whitespace or a closing one. `new Date(x)` with an
// instant passed in is what the package is expected to write. The scan is per
// line, so `new Date(` with its argument on the next line is refused as well;
// put the argument on the same line. `Date` in a type position never follows
// `new` and is untouched.
const CLOCK = /\bDate\.now\b|\bnew\s+Date\b(?!\s*\(\s*[^\s)])/;
const DATABASE = /\bkysely\b|["']pg["']|@nonametrust\/store|NNT_TEST_DATABASE_URL/;

interface SourceFile {
  rel: string;
  abs: string;
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
    out.push({
      rel: relative(srcDir, abs),
      abs,
      text: readFileSync(abs, "utf8"),
      isTest: TEST.test(entry.name),
    });
  }
  return out;
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) found.push(spec);
  }
  return found;
}

// The lines of a module that read the wall clock, as `line: text`. The gate
// below runs this over every non-test module; the planted cases further down
// run it over single lines, so what they prove is the predicate the gate uses
// and not a copy of it.
function clockReads(text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (CLOCK.test(line)) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

function allowed(file: SourceFile, spec: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    // A relative path is allowed only while it stays under src. `../../store`
    // is relative and is exactly the import this gate exists to refuse.
    const target = resolve(dirname(file.abs), spec);
    return target.startsWith(srcDir);
  }
  if (spec === "@nonametrust/schema") return true;
  if (file.isTest && (spec === "vitest" || spec.startsWith("node:"))) return true;
  return false;
}

describe("the package boundary", () => {
  it("scans this file, so the gate cannot pass by scanning nothing", () => {
    expect(sourceFiles().map((f) => f.rel)).toContain("boundary.test.ts");
  });

  it("declares @nonametrust/schema as its only dependency", () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@nonametrust/schema"]);
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    // vitest and typescript come from the root; a package-level devDependency
    // that is not a type package is a runtime dependency in disguise.
    for (const dev of Object.keys(pkg.devDependencies ?? {})) {
      expect(dev, `${dev} is not a @types package`).toMatch(/^@types\//);
    }
  });

  it("imports only @nonametrust/schema, itself, and in tests vitest and node builtins", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (DYNAMIC_EXPRESSION.test(file.text)) {
        offenders.push(`${file.rel}: dynamic import of a non-literal`);
      }
      for (const spec of specifiers(file.text)) {
        if (!allowed(file, spec)) offenders.push(`${file.rel}: ${spec}`);
      }
    }
    expect(offenders, "these imports leave the boundary:\n" + offenders.join("\n")).toEqual([]);
  });

  it("reads no clock, so the instant of every computation is an argument", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.isTest) continue;
      for (const hit of clockReads(file.text)) offenders.push(`${file.rel}:${hit}`);
    }
    expect(offenders, "these lines read the wall clock:\n" + offenders.join("\n")).toEqual([]);
  });

  // The clock predicate, proven on planted lines before it is trusted over
  // the tree. Each refused form is a way to read the current instant; each
  // allowed form is what the package legitimately writes, and is the case a
  // widened pattern could break.
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

    it("reports the line number of an offender inside a module", () => {
      const lines = ["export function at(instant: Date): Date {", "  return instant;", "}", "", "const started = new Date;"];
      expect(clockReads(lines.join("\n"))).toEqual(["5: const started = new Date;"]);
    });
  });

  it("names no database, in tests included", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      // This file names the tokens it refuses, in the pattern above. It is
      // skipped here and here only; its imports are still checked above.
      if (file.rel === "boundary.test.ts") continue;
      file.text.split("\n").forEach((line, i) => {
        if (DATABASE.test(line)) offenders.push(`${file.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "these lines name a database or the store:\n" + offenders.join("\n")).toEqual([]);
  });
});
