import { readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// `@nonametrust/store` and `@nonametrust/tagging` were kept apart on purpose:
// the store holds invariants and computes nothing a decision depends on, and
// tagging is arithmetic that must be provable over a fixed corpus without a
// cluster. `packages/engine` is the composition point they were kept apart
// FOR, and it is the only module allowed to import both.
//
// Why this is a gate and not a sentence. Each package already guards its own
// half from the inside -- tagging's `boundary.test.ts` refuses
// `@nonametrust/store` in its own tree -- but no shipped test says anything
// about the store's tree, and nothing at all says that the set of packages
// composing the two is a set of one. A third package quietly importing both
// would be caught by nobody, and the day it did, the reason the two were
// separated would be gone with nothing failing.
//
// The gate sits at the repository root and derives its scan root from
// `packages/`, in the idiom of `single-date-reader.test.ts`: a new package
// enters under it on the day it is created, with no exemption.
//
// Two ways past an import check, both closed below. A relative path is the
// first -- `../../store/src/db.js` is not a package specifier and reaches the
// store all the same -- so a relative specifier is resolved and judged by
// where it LANDS. A deep subpath is the second: `@nonametrust/store/dist/db.js`
// names the package with a suffix, which a `===` comparison misses, and
// `package.json` carries no `exports` field so that import really does
// resolve. Both are measured by the planted specifiers at the bottom of this
// file, which run the gate's own predicate rather than a copy of it.
//
// The match is lexical, and its reach is exactly its patterns: a dynamic
// import of a computed expression is not resolvable by reading, so it is
// refused outright rather than guessed at.
const packagesDir = fileURLToPath(new URL("../packages/", import.meta.url));

// Every extension the compiler admits, plus plain JavaScript: a `db.js` beside
// a `db.d.ts` typechecks, imports cleanly, and is invisible to a
// TypeScript-only pattern.
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;

// Static imports and re-exports with a `from`, bare side-effect imports, and
// dynamic imports or `require`s of a string literal.
//
// ANCHORED AT STATEMENT POSITION, unlike `tagging/src/boundary.test.ts`, which
// this was copied from. A gate file quotes import syntax as DATA, and a lexical
// scan cannot tell a quoted example from a real import; measured, this gate
// refused `packages/engine/src/boundary.test.ts` for the rows that prove that
// gate's predicates work. An ESM import is a top-level statement, so the anchor
// costs nothing real. The character classes still admit newlines, so a
// multi-line import matches whole.
//
// `require` IS MATCHED, and nothing in this repository looked for it before.
// Measured in the store: `createRequire(import.meta.url)("@nonametrust/tagging")`
// resolved tagging's dist and ran its code, with every gate green and typecheck
// clean. A specifier pattern that knows only `import` holds a rule about one of
// the two module systems Node runs.
const SPECIFIER =
  /^[ \t]*(?:import|export)\b[^"'`;]*?\bfrom[ \t]*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']|^[ \t]*(?:const|let|var|export)\b[^;]*?\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;
const DYNAMIC_EXPRESSION = /\b(?:import|require)\s*\(\s*[^"')]/;
// `createRequire` turns a module into a CommonJS resolver. Refused outright
// rather than followed: a gate that has to re-learn a second module system's
// resolution is a gate that will be wrong about it.
const CREATE_REQUIRE = /\bcreateRequire\b/;

/**
 * The text with its comments removed, line count preserved.
 *
 * REQUIRED BEFORE MATCHING A SPECIFIER, measured in both directions.
 *
 * A false NEGATIVE: `SPECIFIER` runs `[^"'`;]*?` between `import` and `from`, so
 * an apostrophe inside a comment in the import clause terminates it --
 *
 *   import {
 *     requirePositive, // the store's only use
 *   } from "@nonametrust/tagging";
 *
 * matched nothing here and nothing in tagging's gate, while resolving and
 * running normally. The `'` in "store's" is what did it.
 *
 * And a false POSITIVE: a commented-out `// import { tag } from
 * "@nonametrust/tagging"` in the store turned this gate red for a line that
 * imports nothing.
 */
function withoutComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlocks
    .split("\n")
    .map((line) => {
      // Quote-tracked, so a `//` inside a string literal is not a comment.
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
 * Comments removed AND the contents of quoted runs blanked, quotes kept.
 *
 * For the two checks that look for a SHAPE rather than a specifier. A gate that
 * plants `"const m = await import(name);"` as a refusal row contains exactly the
 * text that row refuses, so the check fires on the row proving it works -- which
 * it did, here, for the engine's boundary gate. Comments go first, or every
 * apostrophe in prose opens a string that never closes.
 *
 * Not used for specifier extraction: a specifier IS the contents of a quoted
 * run, and blanking it first returns a list of empty strings.
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

/**
 * A path with every symlink resolved, or the path itself when it does not
 * exist.
 *
 * WHY EVERY PATH COMPARISON GOES THROUGH THIS. A lexical answer to "does this
 * relative import stay inside its package" is wrong, and it was measured to be:
 * with `packages/store/src/tg` symlinked to `../../tagging/src`, a store module
 * importing `./tg/policy.js` ran tagging's code, and this gate, the store's
 * suite and `tsc` were all green. The path says `store/src/tg/policy.js`, which
 * is "inside"; the file is tagging's. The dirent-level `statSync` already in
 * this file handles a symlinked FILE; nothing handled a symlinked directory in
 * the middle of a resolved path.
 */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The package directory a path lies in, relative to a packages root, or null
 * when it lies outside it.
 */
function packageOf(dir: string, base: string): string | null {
  const rel = relative(base, dir);
  if (rel === "" || rel.startsWith("..")) return null;
  const first = rel.split(sep)[0];
  return first === undefined || first === "" ? null : first;
}

/** The two packages that may not meet outside the engine. */
const STORE = "@nonametrust/store";
const TAGGING = "@nonametrust/tagging";

/** The one package allowed to import both. */
const COMPOSER = "engine";

type Side = "store" | "tagging";

interface SourceFile {
  /** The package directory name, e.g. `store`. */
  pkg: string;
  /** Path relative to `packages/`, which is what a refusal prints. */
  rel: string;
  abs: string;
  text: string;
}

function packageNames(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        return statSync(join(packagesDir, name, "src")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const pkg of packageNames()) {
    const srcDir = join(packagesDir, pkg, "src");
    for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!SOURCE.test(entry.name)) continue;
      const abs = join(entry.parentPath, entry.name);
      // stat follows a symlink; the dirent's own isFile() is false for one,
      // which let a symlinked module ship through tsc while a gate skipped it.
      if (!statSync(abs).isFile()) continue;
      out.push({ pkg, rel: relative(packagesDir, abs), abs, text: readFileSync(abs, "utf8") });
    }
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
 * Which of the two kept-apart packages this specifier reaches from a file in
 * `pkg`, or `null` when it reaches neither. A package reaching ITSELF reaches
 * across nothing, so that answers `null` too.
 *
 * A package specifier matches the name itself or the name followed by a `/`,
 * never a prefix of a longer name: `@nonametrust/storeroom` is not the store.
 * A relative specifier is resolved against the importing file and judged by
 * the package directory it lands in, so a path that climbs out of its own
 * package is seen for what it reaches rather than for how it is spelled.
 *
 * The importing package is an argument because the first version of this
 * predicate left it out, and the planted lines below caught what that costs:
 * `./observation.js` inside `store/src/repositories` resolves under
 * `packages/store`, so every sibling import in the store was read as the
 * store importing the store. The tree-level checks stayed green by luck --
 * the offence they look for is the OTHER side -- which is the shape of a gate
 * that reports on something it is not measuring.
 */
export function reaches(pkg: string, fileAbs: string, spec: string): Side | null {
  const own = (side: Side): Side | null => (pkg === side ? null : side);
  const names = (name: string): boolean => spec === name || spec.startsWith(`${name}/`);
  if (names(STORE)) return own("store");
  if (names(TAGGING)) return own("tagging");
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  // The specifier's `.js` resolves to a `.ts` that may not exist, so the
  // DIRECTORY is what gets its symlinks resolved.
  const landedDir = dirname(resolve(dirname(fileAbs), spec));
  // ONE ANSWER, and the real path wins. An earlier version asked "is it inside
  // store? inside tagging?" with a lexical fallback OR-ed into each question,
  // and that is wrong in exactly the case the real path exists to catch: a
  // symlinked `store/src/tg` -> `tagging/src` is LEXICALLY inside store, so the
  // first question said yes, `own()` saw the importer was also store, and the
  // answer came back `null` -- the hole still open, now with a real-path call
  // sitting above it. Measured, by the planted symlink below.
  const target =
    packageOf(realOrSelf(landedDir), realOrSelf(packagesDir)) ?? packageOf(landedDir, packagesDir);
  if (target === "store") return own("store");
  if (target === "tagging") return own("tagging");
  return null;
}

/**
 * True when this relative specifier leaves the importing file's own package.
 * Checked separately from `reaches`, because escaping into `schema` is not a
 * composition offence and is still a hole the moment someone widens it.
 */
export function escapesItsPackage(pkg: string, fileAbs: string, spec: string): boolean {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return false;
  const landed = resolve(dirname(fileAbs), spec);
  const own = join(packagesDir, pkg, "src");
  // Both the lexical path AND the real one must stay inside. The lexical test
  // alone is walked past by a symlinked directory; the real test alone would
  // call a legitimate checkout-through-a-symlink an escape.
  const lexicallyInside = landed.startsWith(own + sep);
  const reallyInside = join(realOrSelf(dirname(landed)), "x").startsWith(realOrSelf(own) + sep);
  return !(lexicallyInside && reallyInside);
}

interface Dependencies {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Every declared dependency of a package, whatever field it was declared in. */
function declaredDependencies(pkg: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(packagesDir, pkg, "package.json"), "utf8"),
  ) as Dependencies;
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

/** The sides each package's own source reaches, by package name. */
function reachedByPackage(): Map<string, Set<Side>> {
  const out = new Map<string, Set<Side>>();
  for (const pkg of packageNames()) out.set(pkg, new Set());
  for (const file of sourceFiles()) {
    for (const spec of specifiers(file.text)) {
      const side = reaches(file.pkg, file.abs, spec);
      if (side !== null) out.get(file.pkg)!.add(side);
    }
  }
  return out;
}


/**
 * Every offence in one file, as the tree scan and the planted rows both see it.
 *
 * WHY THE TREE SCAN GOES THROUGH A FUNCTION. Deleting the `require`
 * alternative, the comment stripping, the real-path resolution and the
 * `js` extensions -- four rules -- left every test in this repository GREEN,
 * because the tree is clean and a scan over a clean tree returns the same empty
 * list whether it checks anything or not. A rule exercised only by a violation
 * is a rule held by the absence of violations. So each rule is a function, and
 * each function has a synthetic file that violates it.
 */
export function offencesIn(file: SourceFile): string[] {
  const out: string[] = [];
  const code = codeOnly(file.text);
  if (DYNAMIC_EXPRESSION.test(code)) out.push("dynamic import or require of a non-literal");
  if (CREATE_REQUIRE.test(code)) out.push("createRequire, a second module system this gate cannot follow");
  for (const spec of specifiers(file.text)) {
    const side = reaches(file.pkg, file.abs, spec);
    if (side !== null) out.push(`reaches ${side}: ${spec}`);
    if (escapesItsPackage(file.pkg, file.abs, spec)) out.push(`escapes its package: ${spec}`);
  }
  return out;
}

/**
 * Packages that no scan reaches, given each directory and whether it has a
 * `src`. The gate's header claims "a new package enters under it on the day it
 * is created, with no exemption"; that was FALSE, because `packageNames()` keeps
 * only directories that have a `src`, so a package laid out any other way had
 * never been seen. A pure function because the tree has no such package, and a
 * rule exercised only by a violation is held by the absence of violations.
 */
export function unscannedPackages(dirs: ReadonlyArray<readonly [string, boolean]>): string[] {
  return dirs.filter(([, hasSrc]) => !hasSrc).map(([name]) => name);
}

/**
 * The two packages, looked for in a manifest that must declare NEITHER.
 *
 * The root manifest is the case this exists for. `declaredDependencies` reads
 * `packages/<pkg>/package.json` only, and pnpm hoists a ROOT dependency into
 * `node_modules` where every package resolves it -- measured: with tagging in the
 * root devDependencies, a store module importing tagging resolved, ran and
 * typechecked, with the per-package manifest test green.
 */
export function hoistedOffences(declared: readonly string[], where: string): string[] {
  return [STORE, TAGGING]
    .filter((name) => declared.includes(name))
    .map((name) => `${where} declares ${name}, which hoists it into every package's resolution`);
}

/** Whether a manifest's declared dependencies keep the two apart. */
export function manifestKeepsThemApart(declared: readonly string[], pkg: string): string[] {
  const out: string[] = [];
  if (pkg !== COMPOSER) {
    for (const name of [STORE, TAGGING]) {
      if (declared.includes(name)) out.push(`${pkg} declares ${name}`);
    }
    return out;
  }
  for (const name of [STORE, TAGGING]) {
    if (!declared.includes(name)) out.push(`${COMPOSER} must declare ${name}`);
  }
  return out;
}

describe("the engine is the only composer", () => {
  // A scan over an empty list is green for free. The gate vouches for nothing
  // until it has found the three packages the rule is about, by name -- a
  // count alone would let a renamed or moved package drop out silently.
  it("scans the three packages the rule is about, so the gate cannot pass by scanning nothing", () => {
    const names = packageNames();
    for (const required of ["store", "tagging", COMPOSER]) {
      expect(names, `packages/${required}/src is not among the scanned trees`).toContain(required);
    }
    const files = sourceFiles();
    for (const required of ["store", "tagging", COMPOSER]) {
      expect(
        files.filter((f) => f.pkg === required).length,
        `no source files found under packages/${required}/src`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps tagging out of packages/store/src", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.pkg !== "store") continue;
      for (const spec of specifiers(file.text)) {
        if (reaches(file.pkg, file.abs, spec) === "tagging") offenders.push(`${file.rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      "the store imports tagging here; the composition belongs in packages/engine:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps the store out of packages/tagging/src", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.pkg !== "tagging") continue;
      for (const spec of specifiers(file.text)) {
        if (reaches(file.pkg, file.abs, spec) === "store") offenders.push(`${file.rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      "tagging imports the store here; the composition belongs in packages/engine:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("lets no package but the engine import both", () => {
    const composers: string[] = [];
    for (const [pkg, sides] of reachedByPackage()) {
      if (sides.has("store") && sides.has("tagging")) composers.push(pkg);
    }
    expect(
      composers.sort(),
      "these packages import both the store and tagging; only packages/engine may:\n" + composers.join("\n"),
    ).toEqual(composers.includes(COMPOSER) ? [COMPOSER] : []);
  });

  it("resolves no relative import out of its own package", () => {
    // Without this, every rule above is spelled around with `../../store/src`.
    // Kept separate from the composition check because climbing into schema
    // is not a composition offence and is a hole all the same.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const spec of specifiers(file.text)) {
        if (escapesItsPackage(file.pkg, file.abs, spec)) offenders.push(`${file.rel}: ${spec}`);
      }
    }
    expect(
      offenders,
      "these relative imports leave their own package; use the package specifier:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("refuses an import no reader can resolve, and the second module system", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      // Strings blanked, or a gate planting `await import(name)` as a refusal
      // row is refused for the row that proves it works. Measured: this check
      // fired on `engine/src/boundary.test.ts` for exactly that.
      const code = codeOnly(file.text);
      if (DYNAMIC_EXPRESSION.test(code)) {
        offenders.push(`${file.rel}: dynamic import or require of a non-literal`);
      }
      if (CREATE_REQUIRE.test(code)) {
        offenders.push(`${file.rel}: createRequire, a second module system this gate cannot follow`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("scans every directory under packages/, so none escapes by not having a src", () => {
    // The gate's own header says "a new package enters under it on the day it is
    // created, with no exemption". That was FALSE, measured: a
    // `packages/quux/lib/index.ts` importing both, with a manifest declaring
    // both, left every test here green -- because `packageNames()` keeps only
    // directories that have a `src`, so a package laid out any other way is not
    // a package this gate has ever seen. The claim is held now instead of
    // asserted.
    const dirs = readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const withoutSrc = unscannedPackages(
      dirs.map((name) => {
        try {
          return [name, statSync(join(packagesDir, name, "src")).isDirectory()] as const;
        } catch {
          return [name, false] as const;
        }
      }),
    );
    expect(
      withoutSrc,
      "these packages have no src/ and are therefore scanned by nothing:\n" + withoutSrc.join("\n"),
    ).toEqual([]);
  });

  it("keeps the two apart in the root manifest, which resolves for every package", () => {
    // The backstop had a hole under it. `declaredDependencies` reads
    // `packages/<pkg>/package.json` only, and pnpm hoists a ROOT dependency into
    // `node_modules` where every package resolves it -- so with
    // `"@nonametrust/tagging": "workspace:*"` in the root devDependencies, a
    // store module importing tagging RESOLVED, RAN, and typechecked clean, with
    // the per-package manifest test green. Measured.
    const root = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as Dependencies;
    const declared = [
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
      ...Object.keys(root.peerDependencies ?? {}),
      ...Object.keys(root.optionalDependencies ?? {}),
    ];
    const offences = hoistedOffences(declared, "the root manifest");
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("keeps the two apart in the manifests too, and the engine declares both", () => {
    // An import cannot resolve without a dependency, so the manifest is the
    // earlier half of the same rule -- and it is the half that can state the
    // engine's POSITIVE obligation on the day the package is created, before
    // it has a module composing anything.
    expect(declaredDependencies("store"), "the store declares tagging").not.toContain(TAGGING);
    expect(declaredDependencies("tagging"), "tagging declares the store").not.toContain(STORE);
    const composer = declaredDependencies(COMPOSER);
    expect(composer, `packages/${COMPOSER} must declare ${STORE}`).toContain(STORE);
    expect(composer, `packages/${COMPOSER} must declare ${TAGGING}`).toContain(TAGGING);
  });


    // The judges, on files that do not exist. Each row covers a branch whose
    // deletion left the whole repository green.
    describe("the judges, on files that do not exist", () => {
      const inStore = (text: string): SourceFile => ({
        pkg: "store",
        rel: "store/src/plant.ts",
        abs: join(packagesDir, "store", "src", "plant.ts"),
        text,
      });

      it("sees a require of the other package, which no pattern here looked for before", () => {
        expect(offencesIn(inStore('const t = require("@nonametrust/tagging");')))
          .toEqual(["reaches tagging: @nonametrust/tagging"]);
      });

      it("sees an import written past a comment in the import clause", () => {
        // The apostrophe in "store's" terminated the character class, so this
        // matched NOTHING while resolving and running normally.
        const withComment = [
          "import {",
          "  requirePositive, // the store's only use",
          '} from "@nonametrust/tagging";',
        ].join("\n");
        expect(offencesIn(inStore(withComment))).toEqual(["reaches tagging: @nonametrust/tagging"]);
      });

      it("does not see a commented-out import as an import", () => {
        // The same fix in the other direction: this once turned the gate red for
        // a line that imports nothing.
        expect(offencesIn(inStore('// import { tag } from "@nonametrust/tagging";'))).toEqual([]);
      });

      it("refuses the resolver that makes a second module system reachable", () => {
        const assembled = `const r = ${"create"}${"Require"}(import.meta.url);`;
        expect(offencesIn(inStore(assembled)))
          .toEqual(["createRequire, a second module system this gate cannot follow"]);
      });

      it("refuses an unresolvable dynamic import and allows a literal one", () => {
        expect(offencesIn(inStore("const m = await import(name);")))
          .toEqual(["dynamic import or require of a non-literal"]);
        expect(offencesIn(inStore('const m = await import("./observation.js");'))).toEqual([]);
      });

      it("reads a quoted example as data and not as an import", () => {
        const quoted = `      expect(reads('import { x } from "@nonametrust/tagging";')).toEqual([]);`;
        expect(offencesIn(inStore(quoted))).toEqual([]);
      });

      it("scans a plain .js module, which a TypeScript-only pattern cannot see", () => {
        expect(SOURCE.test("db.js")).toBe(true);
        expect(SOURCE.test("db.mjs")).toBe(true);
        expect(SOURCE.test("db.cjs")).toBe(true);
        expect(SOURCE.test("notes.md")).toBe(false);
      });

      it("names a package no scan reaches because it has no src", () => {
        expect(unscannedPackages([["store", true], ["engine", true]])).toEqual([]);
        expect(unscannedPackages([["store", true], ["quux", false]])).toEqual(["quux"]);
      });

      it("sees either package hoisted through a manifest that must declare neither", () => {
        expect(hoistedOffences(["typescript", "vitest"], "the root manifest")).toEqual([]);
        expect(hoistedOffences(["vitest", TAGGING], "the root manifest")).toHaveLength(1);
        expect(hoistedOffences([STORE, TAGGING], "the root manifest")).toHaveLength(2);
      });

      it("judges a manifest by which package it belongs to", () => {
        expect(manifestKeepsThemApart(["@nonametrust/schema"], "store")).toEqual([]);
        expect(manifestKeepsThemApart(["@nonametrust/schema", TAGGING], "store"))
          .toEqual([`store declares ${TAGGING}`]);
        expect(manifestKeepsThemApart([STORE], "tagging")).toEqual([`tagging declares ${STORE}`]);
        expect(manifestKeepsThemApart([STORE, TAGGING], COMPOSER)).toEqual([]);
        expect(manifestKeepsThemApart([TAGGING], COMPOSER)).toEqual([`${COMPOSER} must declare ${STORE}`]);
      });

      it("follows a symlinked directory rather than trusting the path", () => {
        // The measured hole: with `packages/store/src/tg` symlinked to
        // `../../tagging/src`, `./tg/policy.js` looked local and ran tagging's
        // code with every gate green. Held here on a REAL symlink, made and
        // removed inside the test, because a lexical fixture cannot prove a
        // filesystem question.
        const link = join(packagesDir, "store", "src", "__gate_probe_tg");
        try {
          symlinkSync(join(packagesDir, "tagging", "src"), link, "dir");
          const offences = offencesIn(inStore('import { requirePositive } from "./__gate_probe_tg/policy.js";'));
          expect(offences).toContain("reaches tagging: ./__gate_probe_tg/policy.js");
          expect(offences).toContain("escapes its package: ./__gate_probe_tg/policy.js");
        } finally {
          try { unlinkSync(link); } catch { /* never created */ }
        }
        // And the control: an ordinary sibling is neither.
        expect(offencesIn(inStore('import { read } from "./observation.js";'))).toEqual([]);
      });
    });

  // The predicate, proven on planted specifiers before it is trusted over the
  // tree. Each of these is a spelling that reaches a package the importer may
  // not reach, and the first version of a gate like this one caught only the
  // first of them.
  describe("the import predicate", () => {
    const storeFile = join(packagesDir, "store", "src", "repositories", "tag.ts");
    const taggingFile = join(packagesDir, "tagging", "src", "tag.ts");
    const schemaFile = join(packagesDir, "schema", "src", "timing.ts");

    it.each([
      ["the package itself", "store", storeFile, TAGGING, "tagging"],
      ["a deep subpath, which package.json has no exports field to refuse", "store", storeFile, `${TAGGING}/dist/tag.js`, "tagging"],
      ["the store from tagging", "tagging", taggingFile, STORE, "store"],
      ["a relative climb out of the package", "store", storeFile, "../../../tagging/src/tag.js", "tagging"],
      ["a relative climb from a third package", "schema", schemaFile, "../../store/src/db.js", "store"],
    ] as const)("sees %s", (_form, pkg, file, spec, side) => {
      expect(reaches(pkg, file, spec)).toBe(side);
    });

    it.each([
      ["a sibling module", "store", storeFile, "./observation.js"],
      ["the package's own root", "store", storeFile, "../db.js"],
      ["the schema, which both may import", "store", storeFile, "@nonametrust/schema"],
      ["a node builtin", "store", storeFile, "node:crypto"],
      ["a third-party package", "store", storeFile, "kysely"],
      // A prefix of a longer name is not the name. Without the `/` boundary a
      // `===` would miss the subpath above and a `startsWith` alone would
      // claim these.
      //
      // ASKED FROM A NEUTRAL PACKAGE, and that is the whole point of the row.
      // The first version asked it of a STORE file, where the self-reference
      // check answers `null` before the name is ever compared -- so replacing
      // the boundary with a bare `startsWith` left this row green and the rule
      // unheld. Measured: the mutant survived. Colliding fixture values making
      // a rule invisible is a failure this repository has now paid for five
      // times, and a gate's own planted lines are not exempt from it.
      ["a package whose name merely starts with the store's", "schema", schemaFile, "@nonametrust/storeroom"],
      ["a package whose name merely starts with tagging's", "schema", schemaFile, "@nonametrust/taggingtools"],
    ] as const)("allows %s", (_form, pkg, file, spec) => {
      expect(reaches(pkg, file, spec)).toBeNull();
    });

    it("separates escaping a package from reaching the other side", () => {
      // `../../schema/src/x.js` reaches neither of the two and is still a
      // hole; the two checks answer differently and both must.
      expect(reaches("store", storeFile, "../../../schema/src/observation.js")).toBeNull();
      expect(escapesItsPackage("store", storeFile, "../../../schema/src/observation.js")).toBe(true);
      expect(escapesItsPackage("store", storeFile, "./observation.js")).toBe(false);
      expect(escapesItsPackage("store", storeFile, "../db.js")).toBe(false);
      // A package specifier is not a relative path and is never an escape;
      // it is judged by `reaches` alone.
      expect(escapesItsPackage("store", storeFile, TAGGING)).toBe(false);
      // And the self-reference the first predicate got wrong: a sibling import
      // reaches across nothing, however it resolves.
      expect(reaches("store", storeFile, "./observation.js")).toBeNull();
      expect(reaches("store", storeFile, STORE)).toBeNull();
      expect(reaches("tagging", taggingFile, TAGGING)).toBeNull();
    });

    it("finds a specifier in each form an import can take", () => {
      const module = [
        `import { a } from "${TAGGING}";`,
        `export { b } from "${STORE}";`,
        `import "${TAGGING}/side-effect.js";`,
        `const m = await import("${STORE}/dist/db.js");`,
      ].join("\n");
      expect(specifiers(module)).toEqual([
        TAGGING,
        STORE,
        `${TAGGING}/side-effect.js`,
        `${STORE}/dist/db.js`,
      ]);
    });
  });
});
