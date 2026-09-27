import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The engine reads no clock and mints no identifier, and this is the lint on
// it.
//
// WHY THE ENGINE NEEDS ITS OWN. Both shipped clock gates scan their own
// package and nothing else: `store/src/clock-gate.test.ts` derives its root
// from its own location, and so does `tagging/src/boundary.test.ts`. So on the
// day `packages/engine` was created it was the one package in the tree under
// no clock gate at all -- and the first version of M3's plan said exactly that
// in its risks section and then gave no task the job of fixing it. A rule
// stated in prose and held by nothing is what §3b of that plan forbids, in the
// document that contains §3b.
//
// WHY IT MATTERS MORE HERE THAN IN THE STORE. The brief is a pure function
// that takes its instant and its generated ids as INPUTS and returns a value
// plus a list of effects, so that the same inputs replay to the same output --
// which is what design §9's determinism claim rests on. One `clock.now()` or
// one `randomUUID()` reached for inside the core breaks replay silently: the
// output is still well-formed, still passes every assertion about its shape,
// and differs between two runs. That is why this gate refuses IDENTIFIERS as
// well as instants, which neither shipped gate does.
//
// A LINT, and the word is chosen, exactly as the store's gate chooses it. A
// lexical scan holds spellings and not semantics, and this one cannot be
// complete. What actually holds the property is the suite: the replay test
// runs the core twice with the clock ADVANCED between the two runs, so a
// planted clock read changes the answer and fails an assertion about the
// answer rather than about a line of source. This file's job is to catch the
// careless spelling early and in one place.
//
// THIS SCANNER IS A COPY, and saying so is the point. Every pattern below
// except the first two walked past the first version of the store's gate and
// was added after review planted it. A copy that drifts from its original is
// worse than no copy, because it reports green on a narrower list, so the last
// test in this file reads the store's own form names out of its source and
// refuses any this list does not carry.
//
// Test files are skipped, as both shipped gates skip them: a fixture pinning
// `new Date("2026-09-21")` is a fixture and not a defect. What is held is that
// no MODULE reaches for an instant or an identifier.
const srcDir = fileURLToPath(new URL("./", import.meta.url));
const storeGate = fileURLToPath(new URL("../../store/src/clock-gate.test.ts", import.meta.url));

const SOURCE = /\.(ts|mts|cts|tsx)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx)$/;

type Form = readonly [string, (line: string, inSql: boolean) => boolean];

// Each way of reaching the current instant, named, so a refusal says which one
// fired and a reader can see what is and is not covered. The list is the
// store's, name for name, and the drift test at the bottom holds it there.
const CLOCK_FORMS: ReadonlyArray<Form> = [
  ["Date.now", (l) => /\bDate\s*\??\s*\.\s*now\b/.test(l)],
  // `new Date` with nothing in the parentheses. JavaScript admits `new Date`
  // with no parentheses at all, and that is the current instant too.
  ["new Date with no argument", (l) => /\bnew\s+Date\b(?!\s*\(\s*[^\s)])/.test(l)],
  // `new (Date)()`, and any parenthesised constructor expression.
  ["new (Date)", (l) => /\bnew\s*\(\s*Date\s*\)/.test(l)],
  // Computed member access on Date.
  ["Date[...]", (l) => /\bDate\s*\[/.test(l)],
  // A bare `Date(...)` call, which returns the current instant as a string.
  // Not `new Date(x)`, which is what this package legitimately writes.
  ["Date() as a call", (l) => /(?<!\bnew\s{1,8})\bDate\s*\(/.test(l)],
  // A destructured `now`, as in `const { now } = Date`.
  ["destructured from Date", (l) => /\}\s*=\s*Date\b/.test(l)],
  ["Reflect.construct(Date", (l) => /\bReflect\s*\.\s*construct\s*\(\s*Date\b/.test(l)],
  ["performance clock", (l) => /\bperformance\s*\.\s*(now|timeOrigin)\b/.test(l)],
  ["process.hrtime", (l) => /\bprocess\s*\.\s*hrtime\b/.test(l)],
  // The database's clock. The engine writes no SQL of its own today -- it goes
  // through the store's repositories -- and the patterns are kept anyway,
  // because the day it opens a transaction and writes one statement is the day
  // a `now()` in it would be the easiest clock read in the tree to miss.
  //
  // The keywords are unambiguous anywhere: nothing in TypeScript is called
  // `current_timestamp`.
  [
    "SQL clock keyword",
    (l) =>
      /(?<![.\w])(current_timestamp|clock_timestamp|transaction_timestamp|statement_timestamp|current_date|localtimestamp)\b/i.test(l),
  ],
  // `age(x)` with ONE argument is `current_date - x`: the wall clock wearing a
  // subtraction, and the only server clock on this list without "timestamp" or
  // "date" in its name. Two arguments is a difference between two given
  // instants and reads no clock.
  ["one-argument SQL age", (l) => /(?<![.\w])age\s*\([^(),]*\)/i.test(l)],
  // A bare `now()` is NOT unambiguous: `now(): Date;` in a `Clock` interface
  // matches it, which in the store's gate made a whole test vacuous. The
  // database's clock arrives through a template, so the line must hold one.
  [
    "SQL now() in a template",
    (l, inSql) => (inSql || l.includes("`")) && /(?<![.\w])now\s*\(\s*\)/i.test(l),
  ],
];

// The ways of reaching an identifier or a random number, which no shipped gate
// refuses and this one must.
//
// R1 makes the brief's ids INPUTS so that a replay reproduces them. A
// `randomUUID()` inside the core is therefore not a style question: it is the
// determinism claim, failing in a way that leaves the output well-formed.
// `Math.random` is here for the same reason and not because anything wanted
// it -- it is the spelling someone reaches for when a unique-looking string is
// needed and `crypto` is not imported.
const ID_FORMS: ReadonlyArray<Form> = [
  ["randomUUID", (l) => /\brandomUUID\b/.test(l)],
  ["Math.random", (l) => /\bMath\s*\.\s*random\b/.test(l)],
  // `crypto.getRandomValues` and `randomBytes` are the same hole one layer
  // down: an id built out of bytes is still an id the core invented.
  ["random bytes", (l) => /\b(getRandomValues|randomBytes|randomInt|randomFillSync)\b/.test(l)],
];

const ALL_FORMS: ReadonlyArray<Form> = [...CLOCK_FORMS, ...ID_FORMS];

// The one module allowed to mint an identifier, and the reason it exists.
//
// `ids.ts` is the injection point: having exactly one is the design, the same
// way `clock.ts` is the store's. The engine has no exempt CLOCK module at all,
// which is a difference from the store worth stating -- the engine's instant
// comes from the store's own `Clock` object, injected, so `clock.now()` is an
// ordinary allowed call here and there is nothing to exempt.
const EXEMPT = new Set(["ids.ts"]);

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

/**
 * Comments blanked, line count preserved so line numbers still point at the
 * source. Without this a doc comment mentioning `Date.now()` counts as a clock
 * read -- which is how the store's exemption test once passed for a `clock.ts`
 * whose clock had been taken out entirely: the comment at its top was doing
 * all the work.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map(stripLineComment)
    .join("\n");
}

/**
 * The line with its `//` comment removed -- where `//` means a comment and not
 * two characters inside a string. A plain replace of everything after the
 * first `//` cut `const u = "https://x"; const t = Date.now();` down to
 * `const u = "https:` and the clock read was gone.
 *
 * Quotes are tracked rather than parsed: single, double and backtick, with
 * backslash escapes skipped. A `//` inside a template SUBSTITUTION is still
 * treated as code, which errs toward refusing and never toward missing a read.
 */
function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") { i++; continue; }
    if (quote !== null) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/**
 * The lines of a module that reach for an instant or an identifier, as
 * `line: form: text`. One function over both lists, so the exemption test
 * below can ask "does this module still reach for SOMETHING" of a module whose
 * something is an id and not a clock.
 */
function nondeterminismReads(text: string, forms: ReadonlyArray<Form> = ALL_FORMS): string[] {
  const lines = code(text).split("\n");
  // Backtick parity, so a `now()` on its own line inside a multi-line sql
  // template is still seen as SQL. Comments are blanked before this runs, so a
  // backtick in prose cannot skew the parity.
  const inSqlAt: boolean[] = [];
  let inSql = false;
  for (const line of lines) {
    inSqlAt.push(inSql);
    const ticks = (line.match(/`/g) ?? []).length;
    if (ticks % 2 === 1) inSql = !inSql;
  }

  const firstForm = (text_: string, sql: boolean): string | null => {
    for (const [name, matches] of forms) if (matches(text_, sql)) return name;
    return null;
  };

  const perLine = lines.map((line, i) => firstForm(line, inSqlAt[i]!));
  const found: string[] = [];
  lines.forEach((line, i) => {
    const own = perLine[i];
    if (own !== null) {
      found.push(`${i + 1}: ${own}: ${line.trim()}`);
      return;
    }
    // Nothing on this line alone. Try the line JOINED WITH THE NEXT ONE, but
    // only when the next line is clean too -- otherwise the offender is
    // reported twice, once on its own line and once on the window above it.
    //
    //   const now = new Date(Date
    //     .now());
    //
    // `new Date(Date` fails "new Date with no argument" because a `(D`
    // follows, and `.now())` alone carries no `Date`. Planted inside the
    // store's `expirePeriods`, this form left that gate GREEN while sixteen
    // FIXTURE tests went red instead -- tests of retention, not of the rule --
    // so the gate was credited for a kill it did not make.
    //
    // Two lines and not a whole-file join, because joining everything would
    // let any `Date` anywhere pair with any `.now()` anywhere. A THREE-line
    // split still walks past, and saying so is the point.
    const next = lines[i + 1];
    if (next === undefined || perLine[i + 1] !== null) return;
    const spanning = firstForm(`${line} ${next}`, inSqlAt[i]!);
    if (spanning !== null) {
      found.push(`${i + 1}: ${spanning} (across two lines): ${`${line} ${next}`.trim()}`);
    }
  });
  return found;
}

/**
 * The module with its IMPORT STATEMENTS blanked, line count preserved.
 *
 * Used by the exemption test and nowhere else. An exempt module earns its
 * exemption by CALLING something nondeterministic, and `import { randomUUID }
 * from "node:crypto"` is not a call -- but it does match the `randomUUID`
 * form, so it kept the exemption looking alive on its own.
 *
 * Measured, and this is why the function exists: replacing `ids.ts`'s
 * `randomUUID()` with a constant string left the exemption test GREEN, because
 * the import at the top was doing all the work. That is the store's own
 * recorded failure -- a doc comment standing in for a clock read -- one layer
 * over, and a gate whose allowance is never exercised cannot be told from one
 * switched off.
 *
 * The prohibition above does NOT use this: importing `randomUUID` into a
 * non-exempt module is an offence worth refusing on the import line alone,
 * because the call is then one edit away and in the same file.
 */
function withoutImports(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(import|export)\b[^;]*\bfrom\b|^\s*import\s*["']/.test(line) ? "" : line))
    .join("\n");
}

/**
 * The form names the store's gate declares, read out of its source. Used by
 * the drift test only: this file's own list is the one that runs.
 */
function storeFormNames(): string[] {
  const text = readFileSync(storeGate, "utf8");
  const start = text.indexOf("const CLOCK_FORMS");
  expect(start, "the store's gate no longer declares CLOCK_FORMS").toBeGreaterThan(-1);
  const end = text.indexOf("\n];", start);
  expect(end, "the store's CLOCK_FORMS list is not terminated as expected").toBeGreaterThan(start);
  // Comments first, or a comment naming `Date["now"]` is read as a form called
  // `now`. Measured: it was.
  const block = code(text.slice(start, end));
  return [...block.matchAll(/\[\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the engine reads no clock and mints no id", () => {
  it("finds the modules it is meant to be scanning", () => {
    // A gate over an empty list passes. This one names the modules it must
    // see, because a count alone has enough slack to lose one.
    const files = sourceFiles().filter((f) => !f.isTest).map((f) => f.rel);
    expect(files.length, "the engine has no modules; this gate is scanning nothing").toBeGreaterThan(0);
    for (const required of ["policy.ts", "ids.ts"]) {
      expect(files, `${required} is not being scanned`).toContain(required);
    }
  });

  it("reaches for no instant and no id outside the exempt module", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.isTest || EXEMPT.has(file.rel)) continue;
      for (const hit of nondeterminismReads(file.text)) offenders.push(`${file.rel}:${hit}`);
    }
    expect(
      offenders,
      "these lines reach for an instant or an id; take it as an argument instead:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("exempts one file and names it, so the allowance cannot widen quietly", () => {
    // Pinned lexically, because widening the set is invisible otherwise:
    // adding a module that happens to read no clock today passes, and the day
    // someone adds one the gate is already looking the other way.
    expect([...EXEMPT].sort()).toEqual(["ids.ts"]);
  });

  it("still finds a source of nondeterminism in the exempt module, in its CODE and not its comments or imports", () => {
    // The other half of the pair. Without the comment blanking, the store's
    // equivalent passed for a `clock.ts` whose clock had been replaced by
    // `new Date(0)`: the doc comment at the top mentioned `Date.now()` and
    // that was enough. A gate whose allowance is never exercised cannot be
    // told from one switched off.
    //
    // And without the IMPORT blanking this one passed for an `ids.ts` whose
    // `randomUUID()` had become the string `"fixed"`, because the import at the
    // top still named it. Measured as a surviving mutant, not reasoned about.
    for (const rel of EXEMPT) {
      const file = sourceFiles().find((f) => f.rel === rel);
      expect(file, `${rel} is missing`).toBeDefined();
      expect(
        nondeterminismReads(withoutImports(file!.text)).length,
        `${rel} no longer mints anything in its own code, so its exemption is holding nothing open`,
      ).toBeGreaterThan(0);
    }
  });

  // The predicate, proven on planted lines before it is trusted over the tree.
  // All but the first two clock forms walked past the first version of the
  // store's gate. Each allowed form is what this package legitimately writes
  // and is the case a widened pattern would break.
  describe("the predicate", () => {
    it.each([
      ["a call", "const t = Date.now();"],
      ["a reference, called later", "const clock = Date.now;"],
      ["spaced member access", "const t = Date . now();"],
      ["optional chaining", "const t = Date?.now();"],
      ["new Date with empty parentheses", "const t = new Date();"],
      ["new Date with only whitespace inside", "const t = new Date( );"],
      ["new Date with no parentheses", "const t = new Date;"],
      ["new Date with the argument on the next line", "const t = new Date("],
      ["a parenthesised constructor", "const t = new (Date)();"],
      ["computed member access", 'const t = Date["now"]();'],
      ["a bare Date call", "const s = Date();"],
      ["destructuring", "const { now } = Date;"],
      ["Reflect.construct", "const t = Reflect.construct(Date, []);"],
      ["the performance clock", "const t = performance.timeOrigin;"],
      ["process.hrtime", "const t = process.hrtime.bigint();"],
      ["the database's clock in a template", "await sql`select now()`.execute(db);"],
      ["current_timestamp in SQL", "const q = sql`where t < current_timestamp`;"],
      ["current_date outside a template", 'const q = "select current_date";'],
      ["transaction_timestamp in SQL", "const q = sql`select transaction_timestamp()`;"],
      ["one-argument age in SQL", "const q = sql`select age(created_at)`;"],
      ["a clock read after a url in a string", 'const u = "https://x/y"; const t = Date.now();'],
      // The id forms, which no shipped gate refuses.
      ["randomUUID from node:crypto", "const id = randomUUID();"],
      ["randomUUID off a namespace", "const id = crypto.randomUUID();"],
      ["Math.random", "const k = Math.random().toString(36);"],
      ["random bytes", "const b = randomBytes(16).toString('hex');"],
      ["getRandomValues", "crypto.getRandomValues(buf);"],
    ])("refuses %s", (_form, line) => {
      expect(nondeterminismReads(line)).toHaveLength(1);
    });

    it.each([
      ["new Date given an instant", "const t = new Date(at);"],
      ["new Date given a literal", "const t = new Date(0);"],
      ["Date in a type position", "function next(at: Date): Date {"],
      ["Date as a generic argument", "const seen: Map<string, Date> = new Map();"],
      ["a constructor whose name starts with Date", "const r = new DateRange();"],
      // The engine's instant comes from the store's injected Clock. This is
      // the call the whole package is expected to make, and the case a
      // widened pattern would break.
      ["the injected clock", "const now = this.clock.now();"],
      ["the injected clock through a local", "const now = clock.now();"],
      ["a method named now in an interface", "  now(): Date;"],
      // And the id equivalents: an id TAKEN as an argument, and an id source
      // called through its seam, are what the core is expected to write.
      ["an id taken as an argument", "function brief(at: Date, briefId: string) {"],
      ["an id source called through its seam", "const briefId = ids.next();"],
      ["a field named id", "const { observationId } = intent;"],
      ["a comment mentioning the clock", "// Date.now() is refused in this package."],
      ["a trailing comment mentioning randomUUID", "const id = given; // not randomUUID()"],
      ["a url in a string, with no clock after it", 'const u = "https://x/now()";'],
      ["age with two arguments, which reads no clock", "const q = sql`select age(a, b)`;"],
    ])("allows %s", (_form, line) => {
      expect(nondeterminismReads(line)).toEqual([]);
    });

    it("sees a clock read split across two lines, which a per-line scan cannot", () => {
      const split = ["  const now = new Date(Date", "    .now());"].join("\n");
      expect(nondeterminismReads(split)).toHaveLength(1);
      expect(nondeterminismReads(split)[0]).toMatch(/across two lines/);
      // The line number is the FIRST of the two, which is where a reader
      // starts looking.
      expect(nondeterminismReads(split)[0]).toMatch(/^1:/);
    });

    it("does not invent a split out of two innocent lines", () => {
      // The window's own cost, pinned: a line ending in a `Date` TYPE next to
      // a line reading the injected clock is the shape most likely to be
      // mistaken for a split, and it is what this package actually writes.
      expect(nondeterminismReads(["function next(at: Date): Date {", "  return this.clock.now();"].join("\n")))
        .toEqual([]);
      // Nor is an offender reported twice, once on its own line and once on
      // the window above it.
      expect(nondeterminismReads(["const a = 1;", "const t = Date.now();"].join("\n"))).toHaveLength(1);
    });

    it("reports the line number of an offender inside a module", () => {
      const module = ["const a = 1;", "", "function f() {", "  // nothing", "  const id = randomUUID();", "}"];
      expect(nondeterminismReads(module.join("\n"))).toEqual([
        "5: randomUUID: const id = randomUUID();",
      ]);
    });

    it("sees the database's clock on its own line inside a multi-line query", () => {
      const module = [
        "await sql`",
        "  insert into t (a, b)",
        "  values (1, now())",
        "`.execute(db);",
      ];
      expect(nondeterminismReads(module.join("\n"))).toEqual([
        "3: SQL now() in a template: values (1, now())",
      ]);
    });
  });

  it("carries every clock form the store's gate declares", () => {
    // THE DRIFT TEST, and the reason this file can be a copy at all.
    //
    // Each of the store's patterns except the first two was added after review
    // planted a spelling that walked past. A copy frozen at today's list would
    // report green on a narrower one the day the store's grows, and nothing
    // would say so -- a gate that has quietly stopped holding what its
    // original holds is worse than no gate, because its green is trusted.
    //
    // Names, not implementations: two packages may legitimately phrase a
    // pattern differently, and what must not happen is a FORM going
    // unrepresented here.
    const mine = new Set(CLOCK_FORMS.map(([name]) => name));
    const theirs = storeFormNames();
    expect(theirs.length, "read no form names out of the store's gate").toBeGreaterThan(5);
    const missing = theirs.filter((name) => !mine.has(name));
    expect(
      missing,
      "the store's clock gate declares forms this one does not; copy them across:\n" + missing.join("\n"),
    ).toEqual([]);
  });
});
