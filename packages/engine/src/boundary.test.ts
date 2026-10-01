import { readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

// Static imports and re-exports with a `from`, bare side-effect imports, and
// dynamic imports or `require`s of a string literal. UNANCHORED, as the
// original was.
//
// AN ANCHORED VERSION OF THIS PATTERN SHIPPED AND DROPPED NINE REAL SHAPES.
// The anchor (`^[ \t]*`) was added to stop a gate's own quoted examples being
// read as imports, and it did that by narrowing the rule instead of by
// understanding it. Measured, each planted and each resolving and running with
// every gate green: a statement before the import on the same line
// (`const a = 1; import { x } from "..."`), a leading UTF-8 BOM, a newline
// between `from` and the specifier, `return import("...")`,
// `mod = await import("...")`, a bare `await import("...")`, `;import ...`, and
// a line indented with a non-breaking space.
//
// The quoted-example problem is solved below instead, by POSITION: a match is
// kept only when its first character is real code rather than text inside a
// string, a template or a regex. That needs no guess about statement shape.
const SPECIFIER =
  /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

// The characters and keywords after which a `/` begins a REGEX LITERAL rather
// than a division. A regex's contents must never be read as code: a `//` inside
// one starts no comment, a quote inside one opens no string.
const REGEX_MAY_FOLLOW = "([{,;:=!&|?+-~^<>*%";
const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case",
  "do", "else", "yield", "await",
]);

/** The end of the regex literal starting at `start`, or null if that is not one. */
function endOfRegex(text: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return null;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i += 1;
      while (i < text.length && /[a-z]/.test(text[i]!)) i += 1;
      return i;
    }
    i += 1;
  }
  return null;
}

/**
 * Two views of one module, produced in a single pass and **exactly the same
 * length as the input and as each other**, so an offset in one is an offset in
 * the other:
 *
 * - `clear`: comments blanked, everything else kept. A specifier is read from
 *   this, because a specifier IS the contents of a string literal.
 * - `blanked`: comments blanked AND the contents of strings, templates and
 *   regex literals blanked. This decides whether a position is real code.
 *
 * ONE PASS, TRACKING STRINGS, COMMENTS AND REGEX LITERALS TOGETHER, and each
 * part of that is a rule a simpler version lost:
 *
 * 1. Running a block-comment regex over RAW text first means
 *    `const glob = "dist/*"` opens a comment that the next `*\/` closes, and
 *    every line between them is blanked. Measured: an import in that span was
 *    invisible to this gate.
 * 2. A regex literal is skipped whole. `const ok = /"/.test(x)` would otherwise
 *    leave a quote open for the rest of its line, blanking a real `import(` after
 *    it -- measured, and it MISSED rather than over-refused.
 * 3. A single- or double-quoted string cannot span a line in JavaScript, so a
 *    quote still open at a newline means the scanner was wrong; it is dropped
 *    there, which bounds any remaining desync to one line. A backtick is kept,
 *    because a template legitimately spans lines.
 *
 * What it is not: a parser. A comment inside a template SUBSTITUTION is still
 * treated as template text.
 */
function views(text: string): { clear: string; blanked: string } {
  let clear = "";
  let blanked = "";
  let i = 0;
  let quote: string | null = null;
  let inBlock = false;
  let lastChar = "";
  let lastWord = "";
  const push = (a: string, b: string): void => { clear += a; blanked += b; };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inBlock) {
      if (c === "*" && next === "/") { push("  ", "  "); i += 2; inBlock = false; continue; }
      push(c === "\n" ? "\n" : " ", c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (c === "\\") { push(text.slice(i, i + 2), "  "); i += 2; continue; }
      if (c === quote) { quote = null; push(c, c); i += 1; continue; }
      if (c === "\n") {
        if (quote !== "`") quote = null;
        push("\n", "\n");
        i += 1;
        continue;
      }
      push(c, " ");
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") { push("  ", "  "); i += 2; inBlock = true; continue; }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") { push(" ", " "); i += 1; }
      continue;
    }
    if (c === "/") {
      const mayStart =
        lastChar === "" || REGEX_MAY_FOLLOW.includes(lastChar) ||
        (/[A-Za-z]/.test(lastChar) && KEYWORDS_BEFORE_REGEX.has(lastWord));
      const end = mayStart ? endOfRegex(text, i) : null;
      if (end !== null) {
        const body = text.slice(i, end);
        push(body, " ".repeat(body.length));
        lastChar = "/";
        lastWord = "";
        i = end;
        continue;
      }
    }
    if (c === "\\") { push(text.slice(i, i + 2), text.slice(i, i + 2)); i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; push(c, c); i += 1; continue; }
    push(c, c);
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) lastWord = /[A-Za-z0-9_$]/.test(lastChar) ? lastWord + c : c;
      else lastWord = "";
      lastChar = c;
    }
    i += 1;
  }
  return { clear, blanked };
}

/** The module with only its comments blanked, length preserved. */
function withoutComments(text: string): string {
  return views(text).clear;
}

/**
 * Every specifier this module imports, read from the clear view and filtered by
 * position so a quoted EXAMPLE is not an import.
 */
function specifiers(text: string): string[] {
  const { clear, blanked } = views(text);
  const found: string[] = [];
  for (const m of clear.matchAll(SPECIFIER)) {
    const at = m.index;
    if (at === undefined) continue;
    // The keyword must be real code. `blanked` holds a space wherever `clear`
    // holds literal content, and the two are the same length, so one character
    // comparison decides it -- and no anchor has to guess at statement shape.
    if (blanked[at] !== clear[at]) continue;
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) found.push(spec);
  }
  return found;
}

/**
 * The `import(` and `require(` calls whose argument is not exactly one string
 * literal -- which is every call no reader can resolve.
 *
 * A first-character peek was not enough: `await import("x", {})` passes import
 * OPTIONS and `import("a" + "b")` concatenates, and both begin with a quote, so
 * both were read as resolvable and neither is. Matched over the BLANKED view, so
 * a gate quoting `await import(name)` as a refusal row is not refused for it.
 */
function unresolvableImports(text: string): string[] {
  const { blanked } = views(text);
  const out: string[] = [];
  for (const m of blanked.matchAll(/\b(?:import|require)\s*\(/g)) {
    const at = m.index;
    if (at === undefined) continue;
    const rest = blanked.slice(at + m[0].length);
    // In the blanked view a resolvable call is: quote, blanks, the same quote,
    // optional space, `)`.
    if (/^\s*(["'])[^"'`\n]*\1\s*\)/.test(rest)) continue;
    out.push(`${m[0].trim()} with an argument no reader can resolve`);
  }
  return out;
}

/**
 * The node builtins this package may reach, named rather than admitted by
 * prefix. `node:crypto` is `ids.ts`'s; `node:fs`, `node:path` and `node:url` are
 * this gate's own and the clock gate's.
 */
const ALLOWED_BUILTINS = ["node:crypto", "node:fs", "node:path", "node:url"];

// A module turned into a CommonJS resolver, which is a second module system this
// gate would have to re-learn. Refused outright instead. Note this is a rule
// about a SPELLING, and `node:module` is refused above as a rule about the
// capability -- which is what actually closes the hole.
const CREATE_REQUIRE = /\bcreateRequire\b/;

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
export function staysInside(fileAbs: string, spec: string): boolean {
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
  // The separator is not optional: `realpathSync` strips a trailing slash, so
  // without it a sibling directory named `srcfoo` "starts with" `src` and an
  // import into it reads as staying inside. Measured.
  const inside = real(srcDir).replace(/\/$/, "") + sep;
  return (real(dirname(landed)) + sep).startsWith(inside);
}

/** Whether this specifier is allowed at all, from a file in this package. */
export function isAllowed(file: SourceFile, spec: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../")) return staysInside(file.abs, spec);
  if (ALLOWED_PACKAGES.includes(spec)) return true;
  // ONLY the builtins this package actually uses, named one by one rather than
  // admitted by prefix. `node:module` is a builtin AND it is the second module
  // system: `nm[["create","Require"].join("")](import.meta.url)` reaches the
  // store's internals with no `createRequire` token anywhere and no `require(`
  // either -- measured, resolved, and ran. A prefix allowance is a rule about a
  // namespace; what this gate needs is a rule about a capability. `node` without
  // the colon would also have admitted `nodemailer` and `node-fetch`.
  if (ALLOWED_BUILTINS.includes(spec)) return true;
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
  const out: string[] = [...unresolvableImports(file.text)];
  // Written as a plain pattern rather than assembled from parts. An earlier
  // version built the token out of `"create" + "Require"` and justified it with
  // a measurement that does not reproduce: a regex LITERAL spelling
  // `\bcreateRequire\b` cannot match itself, because the character before the
  // `c` is the `b` of `\b`, a word character. Review measured the literal
  // spelling leaving every root gate green. The capability is refused by
  // `node:module` not being an allowed builtin; this is the spelling.
  if (CREATE_REQUIRE.test(views(file.text).blanked)) out.push("a second module system");
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

    it("refuses every import call whose argument is not one string literal", () => {
      // A first-character peek was not enough, measured: `import("x", {})` passes
      // import OPTIONS and `import("a" + "b")` concatenates, and both begin with
      // a quote, so both read as resolvable and neither is.
      for (const line of [
        "const m = await import(name);",
        "const m = await import(`./${k}.js`);",
        "const m = require(name);",
        'const m = await import("./policy.js", { with: { type: "json" } });',
        'const m = await import("@nonametrust/store" + "/dist/db.js");',
      ]) {
        expect(unresolvableImports(line), line).toHaveLength(1);
      }
      for (const line of [
        'const m = await import("./policy.js");',
        "const m = require('./policy.js');",
        "const u = import.meta.url;",
      ]) {
        expect(unresolvableImports(line), line).toEqual([]);
      }
      // And a gate quoting one of those as a refusal row is not refused for it.
      expect(unresolvableImports('expect(reads("const m = await import(name);"));')).toEqual([]);
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
          "import( with an argument no reader can resolve",
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

      it("refuses each driver name, not just the one that happens to be planted", () => {
        // Each alternative of DATABASE_DRIVER gets its own row. Review deleted
        // `kysely`, `["\']pg["\']` and `PoolClient` one at a time and all three
        // mutants SURVIVED, because only `new Pool` was ever exercised through
        // this judge.
        expect(driverOffences(asModule('import { Kysely } from "kysely";'))).toHaveLength(1);
        expect(driverOffences(asModule('const x: PoolClient = c;'))).toHaveLength(1);
        expect(driverOffences(asModule("const pool = new Pool();"))).toHaveLength(1);
        expect(driverOffences(asModule('const name = "pg";'))).toHaveLength(1);
        // And what must NOT trip it: the word in prose, and an unrelated name.
        expect(driverOffences(asModule("const pageCount = 1;"))).toEqual([]);
        expect(driverOffences(asModule("const progress = 1;"))).toEqual([]);
      });

      it("admits only the builtins this package uses, by name and not by prefix", () => {
        for (const ok of ALLOWED_BUILTINS) {
          expect(isAllowed(asModule(""), ok), ok).toBe(true);
        }
        // `node:module` is a builtin and it IS the second module system:
        // `nm[["create","Require"].join("")](import.meta.url)` reaches another
        // package's internals with no `createRequire` token and no `require(`.
        // Measured: it resolved and ran.
        for (const refused of ["node:module", "node:vm", "node:child_process", "node:worker_threads"]) {
          expect(isAllowed(asModule(""), refused), refused).toBe(false);
        }
        // And a prefix check without the colon would have admitted these.
        for (const refused of ["nodemailer", "node-fetch"]) {
          expect(isAllowed(asModule(""), refused), refused).toBe(false);
        }
      });

      it("classifies a module and a test file apart, over the real tree", () => {
        // Review set every scanned file's `isTest` to true and no test noticed --
        // which would let a module import vitest and a test-file import go
        // unrefused. The classification is held here on real files.
        const files = sourceFiles();
        const byName = (rel: string) => files.find((f) => f.rel === rel);
        expect(byName("policy.ts")?.isTest, "policy.ts is not a test").toBe(false);
        expect(byName("ids.ts")?.isTest).toBe(false);
        expect(byName("boundary.test.ts")?.isTest, "boundary.test.ts is a test").toBe(true);
        expect(byName("policy.test.ts")?.isTest).toBe(true);
      });

      it("follows a real symlinked directory, which a lexical answer cannot", () => {
        // `staysInside` resolves real paths, and review measured that making it
        // lexical SURVIVED: this file's other rows only pin the predicate's
        // shape. Held here on a symlink made and removed inside the test, the
        // way the root composer gate holds its own.
        const link = join(srcDir, "__boundary_probe_tg");
        try {
          symlinkSync(join(srcDir, "..", "..", "tagging", "src"), link, "dir");
          expect(staysInside(join(srcDir, "policy.ts"), "./__boundary_probe_tg/policy.js")).toBe(false);
        } finally {
          try { unlinkSync(link); } catch { /* never created */ }
        }
        // The control: an ordinary sibling really is inside.
        expect(staysInside(join(srcDir, "policy.ts"), "./ids.js")).toBe(true);
      });

      it("does not treat a sibling directory whose name starts with src as inside", () => {
        // `realpathSync` strips a trailing slash, so without an explicit
        // separator `.../engine/srcfoo` "starts with" `.../engine/src`.
        expect(staysInside(join(srcDir, "policy.ts"), "../srcfoo/x.js")).toBe(false);
        expect(staysInside(join(srcDir, "policy.ts"), "../src/ids.js")).toBe(true);
      });

      it("reads nothing inside a regex literal as code", () => {
        const hidden = 'const ok = /"/.test(x); const m = await import(name);';
        expect(importOffences(asModule(hidden))).toContain(
          "import( with an argument no reader can resolve",
        );
        const url = 'const re = /^https?:\\/\\//; import pg from "pg";';
        expect(importOffences(asModule(url))).toContain("imports pg");
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
