import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// This package depends on `@nonametrust/schema`, `@nonametrust/store` and
// `@nonametrust/tagging` and on NOTHING ELSE, and it reaches each of them only
// through its public surface.
//
// WHY THIS FILE EXISTS, and it is not symmetry with tagging's gate of the same
// name. Three holes were measured, each in what the composer gate does NOT say:
//
// 1. `gates/engine-is-the-only-composer.test.ts` holds a LOWER bound on this
//    package's manifest -- that it declares the store and tagging -- and no
//    upper one. Adding `"pg": "^8.13.0"` and writing `new pg.Pool().query(...)`
//    in a module passed install, typecheck, all 79 engine tests and all 34 root
//    gates. The engine would then write SQL past the store's repositories,
//    which is the one thing §3 and R20 exist to prevent: every invariant here is
//    held by Postgres through a repository, and a second connection is a second
//    set of manners. The id gate is walkable the same way by any `uuid` package.
// 2. A DEEP IMPORT is committed by the consumer, not by the store. R20 makes the
//    store export `openDb` and the `Db` type, and its `package.json` has no
//    `exports` field, so `@nonametrust/store/dist/db.js` really does resolve --
//    measured: typecheck exit 0, every gate green. The composer gate reads a
//    deep subpath as "reaches the store", which the engine is ALLOWED to do, so
//    the refusal cannot live there.
// 3. `createRequire` and `require()` are not `import`, and no specifier pattern
//    in this repository looked for them. Measured in the store:
//    `createRequire(import.meta.url)("@nonametrust/tagging")` resolved tagging's
//    dist and ran it, with every gate green and typecheck clean.
//
// Tagging's `boundary.test.ts` is the template, and the one rule of its that
// does NOT carry over is named rather than dropped: tagging refuses every
// mention of a database because its whole milestone is provable without one. The
// engine composes the store, so it names a database by design; what it may not
// do is open one itself.
const srcDir = fileURLToPath(new URL("./", import.meta.url));
const pkgDir = fileURLToPath(new URL("../", import.meta.url));

// Every extension the compiler admits, plus the plain-JavaScript ones. A
// `clocky.js` beside a `clocky.d.ts` typechecks, imports cleanly and is invisible
// to a TypeScript-only pattern -- measured, and `tsc` then emits nothing for it,
// so the built package is silently broken as well as unscanned.
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx|js|mjs|cjs)$/;

// Static imports and re-exports with a `from`, bare side-effect imports, dynamic
// imports of a string literal, and `require` of one.
//
// ANCHORED AT STATEMENT POSITION, and the anchor is load-bearing rather than
// tidy. A gate that quotes import syntax as DATA -- `expect(reads('import {
// randomUUID } from "node:crypto";'))` -- hands that string to a lexical scan
// which cannot tell a quoted example from a real import. Measured: this file
// refused `clock-gate.test.ts` for the very rows that prove its import blanker
// works. An ESM import is a top-level statement, so `^[ \t]*` costs nothing real
// and excludes every quoted example, which sits inside an expression. The
// character classes still admit newlines, so a multi-line import matches whole.
const SPECIFIER =
  /^[ \t]*(?:import|export)\b[^"'`;]*?\bfrom[ \t]*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']|^[ \t]*(?:const|let|var|export)\b[^;]*?\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;
const DYNAMIC_EXPRESSION = /\b(?:import|require)\s*\(\s*[^"')]/;
// A module turned into a CommonJS resolver, which is a second module system this
// gate would have to re-learn. Refused outright instead.
//
// BUILT FROM PARTS ON PURPOSE, and the reason is a measured collision between
// two gates rather than cleverness. The root composer gate refuses this same
// bare word across every package, and a bare word in a PATTERN DEFINITION is
// code and not a quoted example -- so no anchor and no string-blanking can tell
// the two apart, and writing the token here literally made the root gate refuse
// this file for the line declaring what it refuses. Tagging's gate solves the
// same problem by skipping itself, which works only while the rule and the gate
// live in one tree; two gates in two trees cannot skip each other without one of
// them stopping scanning the other. So the token is assembled, and then neither
// gate needs an exemption.
const CREATE_REQUIRE = new RegExp(`\\b${"create"}${"Require"}\\b`);

/**
 * The text with its comments removed, line count preserved.
 *
 * REQUIRED BEFORE MATCHING A SPECIFIER, and that is a measured defect and not
 * hygiene. `SPECIFIER`'s clause runs `[^"'`;]*?` between `import` and `from`, so
 * an APOSTROPHE inside a comment in the import clause terminates it:
 *
 *   import {
 *     requirePositive, // the store's only use
 *   } from "@nonametrust/tagging";
 *
 * matched nothing, in the composer gate and in tagging's gate both, while
 * resolving and running normally. The `'` in "store's" is what did it.
 */
function withoutComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlocks
    .split("\n")
    .map((line) => {
      // Quote-tracked, so a `//` inside a string literal is not a comment: the
      // store's clock gate lost a clock read to a url in a string that way.
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

/**
 * Comments removed AND the contents of quoted runs blanked, quotes kept, line
 * count preserved.
 *
 * For the checks that look for a SHAPE rather than for a specifier: a gate that
 * plants `"const m = await import(name);"` as a refusal row contains exactly the
 * text that row refuses, so the check fired on the row proving it works. A real
 * `await import(name)` is not inside quotes; a planted one always is.
 *
 * NOT used for specifier extraction, because a specifier IS the contents of a
 * quoted run -- blanking it first returned a list of empty strings. Measured, by
 * doing it.
 *
 * Comments are removed BEFORE the quote tracker runs, and that order is itself a
 * fix: over raw text every apostrophe in prose opens a string that never closes,
 * so the blanking walks out of step with the file from the first "Tagging's"
 * onward.
 */
function codeOnly(text: string): string {
  return withoutComments(text)
    .split("\n")
    .map((line) => {
      // PER LINE, with the quote state RESET at every newline, and that is a
      // measured fix rather than a simplification.
      //
      // A whole-file pass reads a REGEX LITERAL's character class as string
      // delimiters: `/["']([^"']+)["']/` -- the specifier pattern in this very
      // file -- leaves an odd number of quotes open, and from that line onward
      // the parse is INVERTED, code blanked and string contents kept. Measured:
      // this gate then refused itself for a planted row it had already blanked,
      // forty lines further down. A per-line reset cannot poison the rest of a
      // file; at worst it is wrong about the one line it is on.
      //
      // WHAT THIS GIVES UP, stated: `import(` inside a MULTI-LINE template
      // literal is not blanked, so such a line is refused. That errs toward
      // refusing and never toward missing, which is the direction a gate should
      // fail in.
      let out = "";
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote !== null) {
          if (c === "\\") { out += "  "; i += 1; continue; }
          if (c === quote) { quote = null; out += c; continue; }
          out += " ";
          continue;
        }
        if (c === "'" || c === '"' || c === "`") { quote = c; out += c; continue; }
        out += c;
      }
      return out;
    })
    .join("\n");
}

/** The three packages this one may reach, and the only three. */
const ALLOWED_PACKAGES = ["@nonametrust/schema", "@nonametrust/store", "@nonametrust/tagging"];

/**
 * A driver or a connection pool this package must not hold. The store owns the
 * only connection in this system; an engine that opens a second one is an engine
 * whose writes are not subject to the store's repositories.
 */
const DATABASE_DRIVER = /\bkysely\b|["']pg["']|\bnew\s+Pool\b|\bPoolClient\b/;

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
  for (const m of withoutComments(text).matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) found.push(spec);
  }
  return found;
}

/**
 * Whether this specifier reaches past one of the allowed packages' public
 * surfaces -- the package name followed by anything.
 */
export function isDeepImport(spec: string): boolean {
  return ALLOWED_PACKAGES.some((name) => spec.startsWith(`${name}/`));
}

/**
 * Whether this specifier points at a module whose name marks it a test. A
 * non-test module importing one drags it into `dist`: measured, a
 * `src/util.test.ts` exporting a helper and imported by `policy.ts` was skipped
 * by the clock gate as a test file, typechecked, and emitted `dist/util.test.js`.
 * The repository's "no test file reaches dist" check lives only in CI.
 */
export function isTestModule(spec: string): boolean {
  return /\.(test|spec)\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(spec) || /\.(test|spec)$/.test(spec);
}

/**
 * Whether this relative specifier stays inside this package's own `src`.
 *
 * REAL PATHS ON BOTH SIDES, because a lexical answer is wrong here and it was
 * measured to be. A symlinked DIRECTORY inside a package makes
 * `./tg/policy.js` resolve to another package's source while looking local; in
 * the store that ran tagging's code with every gate green. `realpathSync`
 * follows it, and falls back to the lexical path when the target does not exist
 * so a broken import is reported as an import and not as a crash.
 */
function staysInside(fileAbs: string, spec: string): boolean {
  const landed = resolve(dirname(fileAbs), spec);
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  // The specifier carries a `.js` extension that TypeScript resolves to `.ts`,
  // so the path itself may not exist; its directory does.
  return real(dirname(landed)).startsWith(real(srcDir));
}

/** Whether this specifier is allowed at all, from a file in this package. */
export function isAllowed(file: SourceFile, spec: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) return staysInside(file.abs, spec);
  if (ALLOWED_PACKAGES.includes(spec)) return true;
  // `node:crypto` is `ids.ts`'s, and the clock gate exempts that module by name.
  if (spec.startsWith("node:")) return true;
  if (file.isTest && spec === "vitest") return true;
  return false;
}


// ---------------------------------------------------------------- the judges
//
// Each rule below is a FUNCTION over one file, and both the tree scan and the
// planted rows at the bottom of this file call it. That indirection is not
// structure for its own sake: it is what makes the rules mutation-visible.
//
// Measured, and this is the whole reason. Deleting the deep-import branch, the
// test-module branch, the `createRequire` branch, the `require` alternative in
// the specifier pattern, the real-path resolution, and the `js` extensions --
// six separate rules -- left EVERY test in this repository green, because the
// tree is clean and a tree scan over a clean tree returns the same empty list
// whether it checks anything or not. A rule exercised only by a violation is a
// rule held by the absence of violations, which is not holding it at all.
//
// So every judge gets a synthetic file that violates it and a synthetic file
// that does not.

/** Specifiers this file may not import at all, plus the two shapes no reader can follow. */
export function importOffences(file: SourceFile): string[] {
  const out: string[] = [];
  const code = codeOnly(file.text);
  if (DYNAMIC_EXPRESSION.test(code)) out.push("dynamic import or require of a non-literal");
  if (CREATE_REQUIRE.test(code)) out.push("a second module system");
  for (const spec of specifiers(file.text)) {
    if (!isAllowed(file, spec)) out.push(`imports ${spec}`);
  }
  return out;
}

/** Imports that reach past one of the three packages' public surfaces. */
export function deepImportOffences(file: SourceFile): string[] {
  return specifiers(file.text)
    .filter((spec) => isDeepImport(spec))
    .map((spec) => `reaches past a surface: ${spec}`);
}

/** A non-test module importing a test file, which drags it into dist. */
export function testModuleOffences(file: SourceFile): string[] {
  if (file.isTest) return [];
  return specifiers(file.text)
    .filter((spec) => isTestModule(spec))
    .map((spec) => `imports a test file: ${spec}`);
}

/** Lines reaching for a database driver. */
export function driverOffences(file: SourceFile): string[] {
  const out: string[] = [];
  withoutComments(file.text).split("\n").forEach((line, i) => {
    if (DATABASE_DRIVER.test(line)) out.push(`${i + 1}: ${line.trim()}`);
  });
  return out;
}

/** What a manifest must and must not declare, judged over a parsed object. */
export function manifestOffences(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): string[] {
  const out: string[] = [];
  const deps = Object.keys(manifest.dependencies ?? {}).sort();
  const expected = [...ALLOWED_PACKAGES].sort();
  if (deps.join(",") !== expected.join(",")) {
    out.push(`dependencies are ${deps.join(", ")}, expected exactly ${expected.join(", ")}`);
  }
  if (manifest.peerDependencies !== undefined) out.push("declares peerDependencies");
  if (manifest.optionalDependencies !== undefined) out.push("declares optionalDependencies");
  for (const dev of Object.keys(manifest.devDependencies ?? {})) {
    if (!dev.startsWith("@types/")) out.push(`devDependency ${dev} is not a @types package`);
  }
  return out;
}

describe("the engine's boundary", () => {
  it("scans this file, so the gate cannot pass by scanning nothing", () => {
    const files = sourceFiles().map((f) => f.rel);
    expect(files).toContain("boundary.test.ts");
    for (const required of ["policy.ts", "ids.ts", "index.ts"]) {
      expect(files, `${required} is not being scanned`).toContain(required);
    }
  });

  it("declares exactly the three packages it composes, and nothing else", () => {
    // The UPPER bound the composer gate does not hold. Measured: `pg` added here
    // passed install, typecheck, and every test in the repository.
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Parameters<
      typeof manifestOffences
    >[0];
    expect(manifestOffences(pkg), manifestOffences(pkg).join("\n")).toEqual([]);
  });

  it("imports only those three, itself, node builtins, and vitest in tests", () => {
    // NO FILE IS SKIPPED, this one included: the patterns are written so a
    // quoted example and an assembled token are not mistaken for the real
    // thing. A gate that has to skip itself is a gate with one unscanned file.
    const offenders = sourceFiles().flatMap((f) => importOffences(f).map((o) => `${f.rel}: ${o}`));
    expect(offenders, "these imports leave the boundary:\n" + offenders.join("\n")).toEqual([]);
  });

  it("reaches each package through its surface and never past it", () => {
    const offenders = sourceFiles().flatMap((f) => deepImportOffences(f).map((o) => `${f.rel}: ${o}`));
    expect(
      offenders,
      "these imports reach past a package's public surface; ask for an export instead:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("lets no module import a test file, which would carry it into dist", () => {
    const offenders = sourceFiles().flatMap((f) => testModuleOffences(f).map((o) => `${f.rel}: ${o}`));
    expect(
      offenders,
      "these modules import a test file; move the helper into a module:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("opens no database of its own", () => {
    // This file names the drivers it refuses, and a driver name is a bare word
    // rather than a quoted specifier, so no anchor separates the two. Skipped
    // here and here only; its imports are checked above like every other
    // file's, and the planted rows below are what hold this rule instead.
    const offenders = sourceFiles()
      .filter((f) => f.rel !== "boundary.test.ts")
      .flatMap((f) => driverOffences(f).map((o) => `${f.rel}:${o}`));
    expect(
      offenders,
      "these lines reach for a database driver; go through a repository:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  // The predicates, proven on planted specifiers before they are trusted over
  // the tree.
  describe("the predicates", () => {
    const file: SourceFile = { rel: "brief.ts", abs: join(srcDir, "brief.ts"), text: "", isTest: false };
    const testFile: SourceFile = { ...file, rel: "brief.test.ts", isTest: true };

    it.each([
      ["the store's surface", "@nonametrust/store"],
      ["tagging's surface", "@nonametrust/tagging"],
      ["the schema's surface", "@nonametrust/schema"],
      ["a sibling module", "./policy.js"],
      ["a node builtin", "node:crypto"],
    ])("allows %s", (_form, spec) => {
      expect(isAllowed(file, spec)).toBe(true);
    });

    it.each([
      ["a database driver", "pg"],
      ["a query builder", "kysely"],
      ["an id library, which walks past the clock gate", "uuid"],
      ["a relative climb out of the package", "../../store/src/db.js"],
      ["vitest outside a test", "vitest"],
    ])("refuses %s", (_form, spec) => {
      expect(isAllowed(file, spec)).toBe(false);
    });

    it("allows vitest in a test and refuses it in a module", () => {
      expect(isAllowed(testFile, "vitest")).toBe(true);
      expect(isAllowed(file, "vitest")).toBe(false);
    });

    it.each([
      ["the store's internals", "@nonametrust/store/dist/db.js"],
      ["a repository by path", "@nonametrust/store/dist/repositories/tag.js"],
      ["tagging's internals", "@nonametrust/tagging/dist/scale.js"],
    ])("sees %s as reaching past the surface", (_form, spec) => {
      expect(isDeepImport(spec)).toBe(true);
      // And a deep import is still "allowed" by the import predicate, which is
      // why it needs its own check: the specifier names a package this one may
      // depend on, so only the deep-path test refuses it.
      expect(isAllowed(file, spec)).toBe(false);
    });

    it.each([
      ["the surface itself", "@nonametrust/store"],
      ["a package whose name merely starts with an allowed one", "@nonametrust/storeroom"],
      ["a sibling module", "./policy.js"],
    ])("does not see %s as a deep import", (_form, spec) => {
      expect(isDeepImport(spec)).toBe(false);
    });

    it.each([
      ["a test module by relative path", "./util.test.js"],
      ["a spec module", "./helpers.spec.js"],
      ["a test module with no extension", "./util.test"],
    ])("sees %s as a test module", (_form, spec) => {
      expect(isTestModule(spec)).toBe(true);
    });

    it.each([
      ["an ordinary module", "./policy.js"],
      ["a module whose name merely contains test", "./testing.js"],
      ["a package", "@nonametrust/store"],
    ])("does not see %s as a test module", (_form, spec) => {
      expect(isTestModule(spec)).toBe(false);
    });

    it("refuses a dynamic import or require no reader can resolve", () => {
      // The predicate the composer gate carries and never exercised: mutating
      // its regex to match nothing left all 34 root gates green, because the
      // tree is clean and no planted row ran it.
      expect(DYNAMIC_EXPRESSION.test("const m = await import(name);")).toBe(true);
      expect(DYNAMIC_EXPRESSION.test("const m = await import(`./${k}.js`);")).toBe(true);
      expect(DYNAMIC_EXPRESSION.test("const m = require(name);")).toBe(true);
      expect(DYNAMIC_EXPRESSION.test('const m = await import("./policy.js");')).toBe(false);
      expect(DYNAMIC_EXPRESSION.test('const m = require("./policy.js");')).toBe(false);
    });

    it("finds a require of a literal, which no pattern in this repository looked for", () => {
      // Measured in the store: `createRequire(import.meta.url)("@nonametrust/tagging")`
      // resolved tagging's dist and ran it with every gate green.
      expect(specifiers('const t = require("@nonametrust/tagging");')).toEqual([
        "@nonametrust/tagging",
      ]);
      // The planted line is assembled too, for the same reason the pattern is.
      const planted = `const require = ${"create"}${"Require"}(import.meta.url);`;
      expect(CREATE_REQUIRE.test(planted)).toBe(true);
      expect(CREATE_REQUIRE.test("const m = require('./policy.js');")).toBe(false);
    });

    it("finds a specifier through a comment inside the import clause", () => {
      // The apostrophe that terminated the character class. Both this gate and
      // tagging's matched NOTHING here before comments were stripped first.
      const module = [
        "import {",
        "  requirePositive, // the store's only use",
        "} from '@nonametrust/tagging';",
      ].join("\n");
      expect(specifiers(module)).toEqual(["@nonametrust/tagging"]);
      const blockComment = 'import { tag /* see below; */ } from "@nonametrust/tagging";';
      expect(specifiers(blockComment)).toEqual(["@nonametrust/tagging"]);
    });

    it("does not read a quoted example as an import", () => {
      // The anchor's own job, and the reason `clock-gate.test.ts` may plant
      // import syntax as data.
      const quoted = `      expect(reads('import { x } from "pg";')).toEqual([]);`;
      expect(specifiers(quoted)).toEqual([]);
      const inArray = `      const multi = ['import {', "  x,", '} from "pg";'].join("\\n");`;
      expect(specifiers(inArray)).toEqual([]);
    });

    it("finds a specifier in each form an import can take", () => {
      const module = [
        'import { a } from "@nonametrust/store";',
        'export { b } from "@nonametrust/tagging";',
        'import "./side-effect.js";',
        'const m = await import("@nonametrust/schema");',
      ].join("\n");
      expect(specifiers(module)).toEqual([
        "@nonametrust/store",
        "@nonametrust/tagging",
        "./side-effect.js",
        "@nonametrust/schema",
      ]);
    });

    // The judges, on synthetic files. Every row here exists because deleting the
    // branch it covers left the whole repository green: a clean tree cannot tell
    // a scan that checks something from one that checks nothing.
    describe("the judges, on files that do not exist", () => {
      const asModule = (text: string): SourceFile => ({
        rel: "brief.ts",
        abs: join(srcDir, "brief.ts"),
        text,
        isTest: false,
      });
      const asTest = (text: string): SourceFile => ({ ...asModule(text), rel: "brief.test.ts", isTest: true });

      it("refuses a driver import and a pool", () => {
        expect(importOffences(asModule('import pg from "pg";'))).toEqual(["imports pg"]);
        expect(driverOffences(asModule("const pool = new Pool();"))).toHaveLength(1);
        expect(driverOffences(asModule('const q = "select 1";'))).toEqual([]);
      });

      it("sees a require of a package, which no pattern here looked for before", () => {
        // tagging IS allowed; what this row holds is that the specifier was SEEN
        // at all, which the deep-import and test-module judges also rest on.
        expect(specifiers('const t = require("@nonametrust/tagging");')).toEqual([
          "@nonametrust/tagging",
        ]);
        expect(importOffences(asModule('const t = require("pg");'))).toEqual(["imports pg"]);
      });

      it("refuses the resolver that makes a second module system reachable", () => {
        const assembled = `const r = ${"create"}${"Require"}(import.meta.url);`;
        expect(importOffences(asModule(assembled))).toEqual(["a second module system"]);
        expect(importOffences(asModule("const r = 1;"))).toEqual([]);
      });

      it("refuses an unresolvable dynamic import", () => {
        expect(importOffences(asModule("const m = await import(name);"))).toEqual([
          "dynamic import or require of a non-literal",
        ]);
        expect(importOffences(asModule('const m = await import("./policy.js");'))).toEqual([]);
      });

      it("refuses a deep import and allows the surface", () => {
        expect(deepImportOffences(asModule('import { openDb } from "@nonametrust/store/dist/db.js";')))
          .toEqual(["reaches past a surface: @nonametrust/store/dist/db.js"]);
        expect(deepImportOffences(asModule('import { openDb } from "@nonametrust/store";'))).toEqual([]);
      });

      it("refuses a module importing a test file, and allows a test importing one", () => {
        expect(testModuleOffences(asModule('import { h } from "./util.test.js";')))
          .toEqual(["imports a test file: ./util.test.js"]);
        expect(testModuleOffences(asTest('import { h } from "./util.test.js";'))).toEqual([]);
        expect(testModuleOffences(asModule('import { h } from "./util.js";'))).toEqual([]);
      });

      it("finds a specifier written past a comment in the import clause", () => {
        const withComment = ["import {", "  a, // the engine's only use", '} from "pg";'].join("\n");
        expect(importOffences(asModule(withComment))).toEqual(["imports pg"]);
      });

      it("reads a quoted example as data and not as an import", () => {
        const quoted = `      expect(reads('import { x } from "pg";')).toEqual([]);`;
        expect(importOffences(asModule(quoted))).toEqual([]);
      });

      it("scans a plain .js module, which a TypeScript-only pattern cannot see", () => {
        // `tsc` emits nothing for a `.js` without `allowJs`, so such a module is
        // both unscanned and missing from dist.
        expect(SOURCE.test("clocky.js")).toBe(true);
        expect(SOURCE.test("clocky.mjs")).toBe(true);
        expect(SOURCE.test("clocky.cjs")).toBe(true);
        expect(SOURCE.test("notes.md")).toBe(false);
      });

      it("refuses a manifest that declares more, less, or the wrong kind", () => {
        const ok = { dependencies: Object.fromEntries(ALLOWED_PACKAGES.map((n) => [n, "workspace:*"])) };
        expect(manifestOffences(ok)).toEqual([]);
        expect(manifestOffences({ ...ok, dependencies: { ...ok.dependencies, pg: "^8" } })).toHaveLength(1);
        expect(manifestOffences({ dependencies: { "@nonametrust/schema": "workspace:*" } })).toHaveLength(1);
        expect(manifestOffences({ ...ok, peerDependencies: { pg: "^8" } })).toContain("declares peerDependencies");
        expect(manifestOffences({ ...ok, optionalDependencies: { pg: "^8" } })).toContain(
          "declares optionalDependencies",
        );
        expect(manifestOffences({ ...ok, devDependencies: { uuid: "^9" } })).toHaveLength(1);
        expect(manifestOffences({ ...ok, devDependencies: { "@types/node": "^22" } })).toEqual([]);
      });
    });

    it("follows a symlinked directory rather than trusting the path", () => {
      // A lexical answer is wrong here: `./tg/policy.js` under a symlinked
      // `tg` -> ../../tagging/src looks local and is not. There is no such
      // symlink in this package, so what is held is the predicate's shape --
      // it asks the filesystem, and `staysInside` resolves real paths on both
      // sides. The tree-level proof is the composer gate's, which refuses the
      // same plant in the store.
      expect(staysInside(join(srcDir, "policy.ts"), "./ids.js")).toBe(true);
      expect(staysInside(join(srcDir, "policy.ts"), "../package.json")).toBe(false);
      expect(staysInside(join(srcDir, "policy.ts"), "../../store/src/db.js")).toBe(false);
    });
  });
});
