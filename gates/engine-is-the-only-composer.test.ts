import { readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

// A module turned into a CommonJS resolver. Refused outright rather than
// followed: a gate that has to re-learn a second module system's resolution is a
// gate that will be wrong about it.
const CREATE_REQUIRE = /\bcreateRequire\b/;

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
  const out: string[] = [...unresolvableImports(file.text)];
  if (CREATE_REQUIRE.test(views(file.text).blanked)) {
    out.push("createRequire, a second module system this gate cannot follow");
  }
  for (const spec of specifiers(file.text)) {
    const side = reaches(file.pkg, file.abs, spec);
    // The COMPOSER may reach both; that is the whole point of it. Every other
    // package reaching either is the offence. The permission lives here rather
    // than at the call site so the planted rows exercise it too.
    if (side !== null && file.pkg !== COMPOSER) out.push(`reaches ${side}: ${spec}`);
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

  it("finds no offence in any package, through the same judge the rows below use", () => {
    // ONE LOOP, THROUGH `offencesIn`, and that is a fix rather than a tidy-up.
    // Four tree tests used to re-implement the judge inline, so the judge was
    // held by its planted rows while the TREE was held by copies of it --
    // measured: deleting the tree loop's `createRequire` check, its
    // unresolvable-import check, its `reaches(...) === "tagging"` check and the
    // store manifest's `not.toContain` each left all 47 root gates GREEN. That
    // is round one's failure -- a rule held by nothing -- one level up: the
    // judges were tested, the wiring to the tree was not.
    const offenders = sourceFiles().flatMap((f) => offencesIn(f).map((o) => `${f.rel}: ${o}`));
    expect(
      offenders,
      "the store and tagging must not meet outside packages/engine, and no import may\n" +
        "leave its own package or be unresolvable by reading:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("really scans the tree, proven on a file planted and removed here", () => {
    // THE WIRING, held. Setting the loop above to an empty list survives a clean
    // tree -- a tree scan over a tree with no violation returns the same answer
    // whether it scans or not -- and review measured exactly that for the four
    // inline loops this one replaced. So the scan is run against a real file
    // written into `packages/store/src` and deleted in a `finally`.
    const planted = join(packagesDir, "store", "src", "__composer_probe.ts");
    try {
      writeFileSync(planted, `import { POLICY_V0 } from "${TAGGING}";\nexport const p = POLICY_V0;\n`);
      const offenders = sourceFiles().flatMap((f) => offencesIn(f).map((o) => `${f.rel}: ${o}`));
      expect(offenders).toContain(`store/src/__composer_probe.ts: reaches tagging: ${TAGGING}`);
    } finally {
      try { unlinkSync(planted); } catch { /* never written */ }
    }
    // And with it gone the scan is empty again, so the assertion above is about
    // the plant and not about a tree that was already dirty.
    expect(sourceFiles().flatMap((f) => offencesIn(f))).toEqual([]);
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
          .toEqual(["import( with an argument no reader can resolve"]);
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

      it("wants exactly one string literal in an import call", () => {
        // `import("x", {})` passes import OPTIONS and `import("a" + "b")`
        // concatenates; both begin with a quote, so a first-character peek reads
        // both as resolvable and neither is.
        for (const line of [
          'const m = await import("@nonametrust/tagging", {});',
          'const m = await import("@nonametrust/" + "tagging");',
          "const m = await import(name);",
        ]) {
          expect(offencesIn(inStore(line)), line).toContain(
            "import( with an argument no reader can resolve",
          );
        }
        expect(offencesIn(inStore('const m = await import("./observation.js");'))).toEqual([]);
      });

      it("reads nothing inside a regex literal as code", () => {
        // A regex is skipped whole. Without that, `/"/` leaves a quote open for
        // the rest of its line and a real import after it is blanked -- a MISS,
        // not an over-refusal.
        const hidden = 'const ok = /"/.test(x); const m = await import(name);';
        expect(offencesIn(inStore(hidden))).toContain(
          "import( with an argument no reader can resolve",
        );
        // And a URL-scheme regex does not start a comment that swallows the line.
        const url = 'const re = /^https?:\\/\\//; import { tag } from "@nonametrust/tagging";';
        expect(offencesIn(inStore(url))).toContain(`reaches tagging: ${TAGGING}`);
      });

      it("lets the engine reach both and no one else reach either", () => {
        const inEngine = (text: string): SourceFile => ({
          pkg: COMPOSER,
          rel: `${COMPOSER}/src/brief.ts`,
          abs: join(packagesDir, COMPOSER, "src", "brief.ts"),
          text,
        });
        const both = `import { openDb } from "${STORE}";\nimport { tagObservation } from "${TAGGING}";\n`;
        expect(offencesIn(inEngine(both))).toEqual([]);
        // From the STORE the same two lines yield ONE offence, not two: a
        // package importing itself reaches across nothing, so only tagging is
        // the offence. Written out because the first version of this row
        // expected two and the self-reference rule is exactly what it must not
        // forget.
        expect(offencesIn(inStore(both))).toEqual([`reaches tagging: ${TAGGING}`]);
        // And from a third package, both are offences.
        const inSchema = (text: string): SourceFile => ({
          pkg: "schema",
          rel: "schema/src/plant.ts",
          abs: join(packagesDir, "schema", "src", "plant.ts"),
          text,
        });
        expect(offencesIn(inSchema(both))).toEqual([
          `reaches store: ${STORE}`,
          `reaches tagging: ${TAGGING}`,
        ]);
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
