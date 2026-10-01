import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// G-compose: a store class that holds a clock is constructed in ONE module.
//
// WHY A LEXICAL RULE AND NOT A TYPE. `compose.test.ts` holds that everything
// `compose` returns shares one clock object. It cannot hold that nothing ELSE
// builds a repository: a second construction site somewhere in this package gets
// whatever clock its author had to hand, and the store accepts it -- measured,
// seven of the eight clock-bearing classes take their clock unchecked. The
// ledger records the other half of the same hole: "Two `compose` calls with two
// clocks are invisible to every gate." This rule closes the reachable half, which
// is a second construction inside this package, and the invisible half stays
// recorded rather than claimed shut.
//
// TEST FILES ARE SCANNED TOO, and that is the point rather than an oversight. A
// DB-backed test that built its own `TagRepository` would be testing an
// arrangement the wrapper never produces, and Task 8 rebuilds repositories per
// transaction -- through `compose`, because `Db` already admits one.
//
// THE PATTERN ADMITS MEMBER ACCESS, and that is a correction review paid for
// once: its own first pattern, `new \w*Repository(`, walked straight past
// `new store.TagRepository(`.
//
// WHAT IT CANNOT SEE, measured and recorded rather than claimed shut: a constructor
// held in a variable. `const Ctor = TagRepository; new Ctor(handle, clock)` names no
// suffix at the construction site and passes. A lexical rule cannot follow a value.
// What narrows it is that the alias must still IMPORT the class, and the store
// classes are only imported by `compose.ts` today -- but nothing enforces that, so
// this is a limit and not a second rule.

const srcDir = fileURLToPath(new URL("./", import.meta.url));
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx|js|mjs|cjs)$/;

/**
 * The one module allowed to construct them. Pinned by a test below, because
 * widening a set is the invisible way to switch a gate off.
 */
const EXEMPT = new Set(["compose.ts"]);

/**
 * Both suffixes, because both name a store class that takes a `Clock`:
 * `*Repository` and `AuditChain`. Written as suffixes rather than as the nine
 * names so that a class added to the store is caught on the day it is
 * constructed here rather than on the day someone remembers to extend a list.
 *
 * `\s+` after `new` rather than `\s*`, so `newRepository(` -- a function whose
 * name merely begins with those letters -- is not a construction. And the
 * member-access prefix repeats, so `new a.b.TagRepository(` is one too.
 */
const CONSTRUCTION = /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*(?:Repository|Chain))\s*\(/g;

interface SourceFile {
  rel: string;
  text: string;
}

/**
 * The text with its comments removed, line count preserved. Lifted from
 * `gates/no-module-imports-a-test.test.ts`, which records why the string
 * awareness is required: an apostrophe inside a comment terminates a
 * naive character class and the match then finds nothing.
 *
 * String CONTENTS are kept, as in `boundary.test.ts`'s `clear` view. The rule is
 * lexical: a string that spells out a construction trips it, and the fix is to
 * reword the string. The planted rows at the bottom of this file assemble their
 * tokens for exactly that reason, so this file does not accuse itself.
 */
function withoutComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlocks
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (c === "\\") {
          i++;
          continue;
        }
        if (quote !== null) {
          if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === "`") {
          quote = c;
          continue;
        }
        if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Every class this file constructs, in source order, with duplicates kept. */
export function constructions(text: string): string[] {
  return [...withoutComments(text).matchAll(CONSTRUCTION)].map((m) => m[1]!);
}

/** The offending lines of one file, or none if it is allowed to construct. */
export function constructionOffences(file: SourceFile): string[] {
  if (EXEMPT.has(file.rel)) return [];
  const out: string[] = [];
  withoutComments(file.text)
    .split("\n")
    .forEach((line, i) => {
      // A fresh matcher per line: CONSTRUCTION is global and carries lastIndex.
      for (const m of line.matchAll(new RegExp(CONSTRUCTION.source, "g"))) {
        out.push(`${i + 1}: ${m[1]!} -- ${line.trim()}`);
      }
    });
  return out;
}

/**
 * The files one tree contains, as this gate reads them.
 *
 * TAKES A DIRECTORY, and that is not generality for its own sake. The probe rows
 * below need a real symlink and a real broken symlink, and an earlier version made
 * them inside `src/` named `*.ts`. Measured: the engine's suite runs its files in
 * PARALLEL, so the floors gate's own scan stat'd the probe between its creation
 * and its removal and died with ENOENT -- a failure invisible when either file was
 * run alone, which is this branch's sixth lesson arriving at test level. A gate
 * that writes into the tree it scans breaks every other gate that scans it.
 *
 * `boundary.test.ts` gets away with the same trick because its probe is a
 * DIRECTORY with no source extension, so no other gate's file regex sees it. That
 * is luck rather than design, and this one does not rely on it: the probes live
 * outside every scanned tree and the real scan still runs over `srcDir`.
 */
function sourceFiles(dir: string = srcDir): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!SOURCE.test(entry.name)) continue;
    const abs = join(entry.parentPath, entry.name);
    // `statSync` FOLLOWS a symlink, which is the behaviour this rule wants: a
    // symlinked module compiles like any other, so it must be scanned like any
    // other, and the symlink row below holds that rather than only asserting it.
    //
    // WHAT THIS GUARD IS AND IS NOT. An earlier version carried the comment from
    // `single-date-reader.test.ts` -- "the dirent's own isFile() is false for a
    // symlink" -- which explains a guard against `entry.isFile()`, and this
    // enumeration never calls that. Measured: deleting the line SURVIVED, because
    // its only real effect is excluding a directory named `*.ts`. So it is
    // declared for what it does, and it is wrapped, because `statSync` THROWS on
    // a broken symlink and an unreadable entry must fail this gate loudly rather
    // than crash it or be skipped into silence.
    let isFile: boolean;
    try {
      isFile = statSync(abs).isFile();
    } catch (cause) {
      throw new Error(`${relative(dir, abs)} cannot be stat'd, so this gate cannot scan it`, {
        cause,
      });
    }
    if (!isFile) continue;
    out.push({ rel: relative(dir, abs), text: readFileSync(abs, "utf8") });
  }
  return out;
}

/**
 * Runs `body` against a throwaway tree that NO gate scans, and removes it again.
 *
 * Outside `src/` on purpose -- see `sourceFiles`. It is also untracked, so the
 * root gates that enumerate with `git ls-files` cannot see it either, and
 * `rmSync(..., { force: true })` in a `finally` means a thrown assertion still
 * leaves the tree clean.
 */
function withProbeTree(body: (dir: string) => void): void {
  const probe = fileURLToPath(new URL("../.compose-gate-probe/", import.meta.url));
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  try {
    body(probe);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** The nine store classes the composition root is responsible for. */
const COMPOSED_CLASSES = [
  "AuditChain",
  "BaselineRepository",
  "HotWindowRepository",
  "NamespaceRepository",
  "ObservationRepository",
  "PermanentRecordRepository",
  "TagRepository",
  "TriggerEventRepository",
  "VolatilityRepository",
];

describe("a store class that holds a clock", () => {
  it("is constructed nowhere in this package but the composition root", () => {
    const offenders = sourceFiles().flatMap((f) =>
      constructionOffences(f).map((o) => `${f.rel}:${o}`),
    );
    expect(
      offenders,
      "construct these through compose(), or they get a clock nobody checked:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("is scanned in at least this package, so the gate cannot pass by scanning nothing", () => {
    const files = sourceFiles();
    expect(files.length, "no engine sources found; the gate is scanning nothing").toBeGreaterThan(5);
    expect(
      files.some((f) => TEST.test(f.rel)),
      "no test files among them, so the test-file half of this rule is doing nothing",
    ).toBe(true);
    expect(
      files.map((f) => f.rel),
      "the composition root is not among the scanned files",
    ).toContain("compose.ts");
  });

  describe("the exemption", () => {
    it("names one file, so the allowance cannot widen quietly", () => {
      expect([...EXEMPT].sort()).toEqual(["compose.ts"]);
    });

    it("is doing work: the exempt module constructs each of the nine, in its own CODE", () => {
      // The other half of the pair. An exemption whose file constructs nothing is
      // indistinguishable from a gate switched off -- and this form of the test
      // does a second job: `compose` cannot quietly stop building one of the nine,
      // because the multiset below is compared exactly.
      const root = sourceFiles().find((f) => f.rel === "compose.ts");
      expect(root, "compose.ts is missing").toBeDefined();
      expect(constructions(root!.text).sort()).toEqual(COMPOSED_CLASSES);
    });
  });

  describe("the predicate, on files that do not exist", () => {
    // Every row assembles its token, so the tree scan above does not read this
    // file's own planted violations as real ones. A gate over a clean tree
    // returns the same empty list whether it checks anything or not.
    const plain = `const r = new ${"Tag"}Repository(db, clock);`;
    const member = `const r = new store.${"Tag"}Repository(db, clock);`;
    const nested = `const r = new a.b.${"Audit"}Chain(db, clock, ring);`;
    const spaced = `const r = new   ${"Baseline"}Repository(db, clock);`;
    const chain = `const c = new ${"Audit"}Chain(db, clock, ring);`;

    // The rel names a file that does not exist and is not planned. An earlier
    // version used `brief.ts`, which this task then created: adding a real module
    // to EXEMPT would have silently disarmed every row below, and a mutation run
    // showed exactly that.
    const asModule = (text: string): SourceFile => ({ rel: "no-such-module.ts", text });
    const asTest = (text: string): SourceFile => ({ rel: "no-such-module.test.ts", text });

    it.each([
      ["a bare construction", plain],
      ["one reached through a namespace import", member],
      ["one reached through two", nested],
      ["one with extra whitespace after new", spaced],
      ["the audit chain, which is not named Repository", chain],
    ])("refuses %s", (_form, line) => {
      expect(constructionOffences(asModule(line))).toHaveLength(1);
    });

    it("refuses it in a test file exactly as in a module", () => {
      expect(constructionOffences(asTest(plain))).toHaveLength(1);
    });

    it.each([
      ["a comment naming a construction", `// use new ${"Tag"}Repository(db, clock) here`],
      ["a block comment naming one", `/* new ${"Tag"}Repository(db, clock) */`],
      ["a function whose name starts with new", `const r = new${"Tag"}Repository(db, clock);`],
      ["a class named for neither suffix", "const d = new Date(at);"],
      ["a reference with no construction", "const t = tags.listLive;"],
      ["a type position", "let t: TagRepository | null = null;"],
    ])("allows %s", (_form, line) => {
      expect(constructionOffences(asModule(line))).toEqual([]);
    });

    it("allows the construction inside the exempt file, and only there", () => {
      expect(constructionOffences({ rel: "compose.ts", text: plain })).toEqual([]);
      expect(constructionOffences({ rel: "compose-extra.ts", text: plain })).toHaveLength(1);
    });

    it("reports EVERY construction on one line, not just the first", () => {
      const two = `const a = new ${"Tag"}Repository(db, clock), b = new ${"Baseline"}Repository(db, clock);`;
      expect(constructionOffences(asModule(two))).toHaveLength(2);
    });

    it("names the class it found, so the message says which one to move", () => {
      expect(constructionOffences(asModule(plain))[0]).toContain("TagRepository");
    });

    it("FAILS LOUDLY on an entry it cannot stat, rather than crashing or skipping it", () => {
      // The other half of what the stat line does. A broken symlink named `*.ts`
      // makes `statSync` throw, and the two wrong answers are a raw ENOENT from
      // inside a gate nobody can read, and a `catch {} continue` that skips the
      // file into silence -- which is how an unscanned module passes a gate.
      withProbeTree((probe) => {
        symlinkSync(join(probe, "absent-target.ts"), join(probe, "broken.ts"), "file");
        expect(() => sourceFiles(probe)).toThrow(/broken\.ts cannot be stat'd/);
      });
      // The control: the real tree, which has no broken links, scans clean.
      expect(sourceFiles().length).toBeGreaterThan(5);
    });

    it("scans a SYMLINKED module, which compiles like any other", () => {
      // Held on a real symlink made and removed inside the test, in the idiom of
      // `boundary.test.ts`'s own symlink row. Without it the enumeration's
      // handling of a symlink is a claim in a comment: deleting the stat line
      // survived every other row in this file.
      withProbeTree((probe) => {
        writeFileSync(join(probe, "target.ts"), `export const r = new ${"Tag"}Repository(db, clock);\n`);
        symlinkSync(join(probe, "target.ts"), join(probe, "link.ts"), "file");
        const viaLink = sourceFiles(probe).find((f) => f.rel === "link.ts");
        expect(viaLink, "the symlinked module was not enumerated at all").toBeDefined();
        expect(
          constructionOffences(viaLink!),
          "a construction reached through a symlink",
        ).toHaveLength(1);
      });
    });
  });
});
