import { readdirSync, readFileSync, statSync } from "node:fs";
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

const SOURCE = /\.(ts|mts|cts|tsx)$/;

// Static imports and re-exports with a `from`, bare side-effect imports, and
// dynamic imports of a string literal, as `tagging/src/boundary.test.ts`
// spells them. A dynamic import of an expression is not matched here and is
// refused by its own check below, so it is not a way past.
const SPECIFIER =
  /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_EXPRESSION = /\bimport\s*\(\s*[^"')]/;

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
  for (const m of text.matchAll(SPECIFIER)) {
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
  const landed = resolve(dirname(fileAbs), spec);
  const inside = (name: string): boolean => landed.startsWith(join(packagesDir, name) + sep);
  if (inside("store")) return own("store");
  if (inside("tagging")) return own("tagging");
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
  return !landed.startsWith(join(packagesDir, pkg, "src") + sep);
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

  it("refuses a dynamic import no reader can resolve", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (DYNAMIC_EXPRESSION.test(file.text)) offenders.push(`${file.rel}: dynamic import of a non-literal`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
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
