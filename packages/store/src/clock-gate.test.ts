import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Every instant this package writes comes from the injected clock, and this
// is the lint on it.
//
// A LINT, and the word is chosen. The first version of this file claimed more
// than it held: adversarial review walked about a dozen ordinary,
// type-checking spellings past it -- `new (Date)()`, `Date["now"]()`, a
// destructured `now`, a bare `Date()`, `Date` and `.now()` on two lines, and
// a Postgres `now()` inside an sql template, which is the most natural
// evasion in a package built on pg. One of them was planted inside
// `expirePeriods` and this file stayed green. The predicate below is wider
// now and still cannot be complete: a lexical scan holds spellings, not
// semantics.
//
// So what actually guards the property is the SUITE, and saying so is the
// point. Every retention fixture pins a fixed instant -- 2026-09, 2027-03 --
// so a repository that started reading the wall clock fails eleven tests in
// `namespace.test.ts` before it gets here. Measured, with that same planted
// `new (Date)()`. This file's job is to catch the careless spelling early
// and in one place; the fixtures are what make the rule true.
//
// Why the rule matters at all: retention is a simulated calendar. Expiry is
// derived from the period and never from today, the sweep is told `now`
// rather than asking, the producer cap measures against the caller's
// instant. All of it is provable in milliseconds because the clock is an
// argument.
//
// Test files are skipped, as the tagging gate this copies skips them
// (`boundary.test.ts:139`): `fixedClock(new Date("2027-03-05"))` is a
// fixture, not a defect. What is held is that no MODULE reads the wall
// clock.
const srcDir = fileURLToPath(new URL("./", import.meta.url));

const SOURCE = /\.(ts|mts|cts|tsx)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx)$/;

// Each way of reaching the current instant, named, so a refusal says which
// one fired and a reader can see what is and is not covered. Every pattern
// below was a plant that walked past the first version of this file except
// the first two, which were all it had.
const CLOCK_FORMS: ReadonlyArray<readonly [string, (line: string, inSql: boolean) => boolean]> = [
  ["Date.now", (l) => /\bDate\s*\??\s*\.\s*now\b/.test(l)],
  // `new Date` with nothing in the parentheses. JavaScript admits `new Date`
  // with no parentheses at all, and that is the current instant too.
  ["new Date with no argument", (l) => /\bnew\s+Date\b(?!\s*\(\s*[^\s)])/.test(l)],
  // `new (Date)()`, and any parenthesised constructor expression.
  ["new (Date)", (l) => /\bnew\s*\(\s*Date\s*\)/.test(l)],
  // `Date["now"]`, `Date['now']`, `Date[k]`.
  ["Date[...]", (l) => /\bDate\s*\[/.test(l)],
  // A bare `Date(...)` call, which returns the current instant as a string.
  // Not `new Date(x)`, which is what this package legitimately writes.
  ["Date() as a call", (l) => /(?<!\bnew\s{1,8})\bDate\s*\(/.test(l)],
  // `const { now } = Date`.
  ["destructured from Date", (l) => /\}\s*=\s*Date\b/.test(l)],
  ["Reflect.construct(Date", (l) => /\bReflect\s*\.\s*construct\s*\(\s*Date\b/.test(l)],
  ["performance clock", (l) => /\bperformance\s*\.\s*(now|timeOrigin)\b/.test(l)],
  ["process.hrtime", (l) => /\bprocess\s*\.\s*hrtime\b/.test(l)],
  // The database's clock, which this package can reach from every query it
  // writes and which no amount of watching JavaScript would catch. `now()`
  // only where it is not a method call, so the injected `clock.now()` and
  // `this.clock.now()` are untouched.
  // Two separate checks, and the split is not cosmetic.
  //
  // The keywords are unambiguous anywhere: nothing in TypeScript is called
  // `current_timestamp`.
  [
    "SQL clock keyword",
    (l) =>
      /(?<![.\w])(current_timestamp|clock_timestamp|transaction_timestamp|statement_timestamp|current_date|localtimestamp)\b/i.test(l),
  ],
  // `age(x)` with ONE argument is `current_date - x`: the wall clock wearing
  // a subtraction, and the only server clock on this list that does not have
  // "timestamp" or "date" in its name. Two arguments is a difference between
  // two given instants and reads no clock, so the pattern insists there is no
  // comma before the closing parenthesis -- which also means it does not fire
  // on `age(` at the end of a line, and a multi-line `age(` is a form this
  // package does not write. Said here rather than left to be discovered.
  ["one-argument SQL age", (l) => /(?<![.\w])age\s*\([^(),]*\)/i.test(l)],
  // A bare `now()` is NOT unambiguous, and the first version of this pattern
  // was wrong about that in a way that made another test vacuous: `now():
  // Date;` in the `Clock` interface matched it, so `clock.ts` always looked
  // like it read a clock and the "exemption is doing work" test below passed
  // for a `clock.ts` whose clock had been removed. The database's clock
  // arrives through a template, so the line has to hold one.
  [
    "SQL now() in a template",
    (l, inSql) => (inSql || l.includes("`")) && /(?<![.\w])now\s*\(\s*\)/i.test(l),
  ],
];

// The two modules allowed to reach a clock, each for a stated reason.
//
// `clock.ts` is the injection point: having exactly one is the design.
//
// `migrate.ts` writes `applied_at timestamptz not null default now()` on the
// migration ledger. That is a deployment fact about when a DDL file ran, not
// a domain instant any decision reads, and a migration cannot be handed a
// simulated clock because it is the thing that creates the schema the clock's
// own tests run against. Named here rather than left to be discovered:
// review found it and the first version of this gate did not.
const EXEMPT = new Set(["clock.ts", "migrate.ts"]);

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
 * source. Without this a doc comment mentioning `Date.now()` counts as a
 * clock read -- which is how the exemption test below passed for a
 * `clock.ts` whose clock had been taken out entirely: the comment at its top
 * was doing all the work.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map(stripLineComment)
    .join("\n");
}

/**
 * The line with its `//` comment removed -- where `//` means a comment and
 * not two characters inside a string.
 *
 * A plain regex replace of everything from the first `//` to the end of the
 * line cut it wherever it was, so `const u = "https://x"; const t = Date.now();`
 * arrived at the predicate as `const u = "https:` and the clock read was
 * gone. Review planted exactly that and the gate stayed green. A url in a
 * string is not a contrived line in a package that talks to a database over
 * one.
 *
 * Quotes are tracked rather than parsed: single, double and backtick, with
 * backslash escapes skipped. That is enough for this file's job and stops
 * short of being a scanner -- a `//` inside a template SUBSTITUTION would
 * still be treated as code, which errs toward refusing and never toward
 * missing a clock read.
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

function clockReads(text: string): string[] {
  const lines = code(text).split("\n");
  // Backtick parity, so a `now()` on its own line inside a multi-line sql
  // template is still seen as SQL. Every query this package writes spans
  // lines, so a per-line "does this line hold a backtick" test missed all of
  // them -- including `migrate.ts`'s own `default now()`, which is how the
  // omission was found. Comments are blanked before this runs, so a backtick
  // in prose cannot skew the parity.
  const inSqlAt: boolean[] = [];
  let inSql = false;
  for (const line of lines) {
    inSqlAt.push(inSql);
    const ticks = (line.match(/`/g) ?? []).length;
    if (ticks % 2 === 1) inSql = !inSql;
  }

  const firstForm = (text_: string, sql: boolean): string | null => {
    for (const [name, matches] of CLOCK_FORMS) if (matches(text_, sql)) return name;
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
    // The scanner was per-line, and a clock read split across two lines
    // therefore matched nothing:
    //
    //   const now = new Date(Date
    //     .now());
    //
    // `new Date(Date` fails "new Date with no argument" because a `(D`
    // follows, and fails "Date() as a call" because the only `Date` before a
    // parenthesis is the one `new ` excludes. `.now())` alone carries no
    // `Date`. Planted inside `expirePeriods`: the gate stayed GREEN and
    // sixteen FIXTURE tests went red instead -- tests of retention, not of
    // this rule -- so the gate was being credited for a kill it did not make.
    // The commit that listed this among nine caught plants was wrong about it,
    // and re-running every mutant the branch claims is what found that out.
    //
    // Two lines and not a whole-file join, because joining everything would
    // let any `Date` anywhere pair with any `.now()` anywhere. Two is what a
    // hand-split expression needs and what a formatter produces. A THREE-line
    // split still walks past, and saying so is the point: this is a lexical
    // gate and its reach is exactly its patterns.
    const next = lines[i + 1];
    if (next === undefined || perLine[i + 1] !== null) return;
    const spanning = firstForm(`${line} ${next}`, inSqlAt[i]!);
    if (spanning !== null) {
      found.push(`${i + 1}: ${spanning} (across two lines): ${`${line} ${next}`.trim()}`);
    }
  });
  return found;
}

describe("the store reads no clock but its own", () => {
  it("finds the modules it is meant to be scanning", () => {
    // A gate over an empty list passes. This one walks a package whose
    // modules move between directories, so it names the ones it must see --
    // a count alone had three modules of slack, enough to lose a whole
    // directory without noticing.
    const files = sourceFiles().filter((f) => !f.isTest).map((f) => f.rel);
    expect(files.length).toBeGreaterThan(15);
    for (const required of [
      "clock.ts", "migrate.ts", "db.ts", "retention.ts", "crypto.ts",
      "repositories/observation.ts", "repositories/namespace.ts",
      "repositories/permanent-record.ts", "audit/chain.ts", "testing/harness.ts",
    ]) {
      expect(files, `${required} is not being scanned`).toContain(required);
    }
  });

  it("reads no clock outside the two exempt modules", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.isTest || EXEMPT.has(file.rel)) continue;
      for (const hit of clockReads(file.text)) offenders.push(`${file.rel}:${hit}`);
    }
    expect(offenders, "these lines read a clock:\n" + offenders.join("\n")).toEqual([]);
  });

  it("exempts two files and names them, so the allowance cannot widen quietly", () => {
    // Pinned lexically, because widening the set is invisible otherwise:
    // adding a module that happens to read no clock today passes, and the
    // day someone adds one the gate is already looking the other way.
    // Measured -- adding two modules left every other test here green.
    expect([...EXEMPT].sort()).toEqual(["clock.ts", "migrate.ts"]);
  });

  it("still finds a clock in each exempt module, in its CODE and not its comments", () => {
    // Without the comment blanking this passed for a `clock.ts` whose
    // `systemClock` had been changed to `new Date(0)`: the doc comment at
    // the top mentions `Date.now()` and that was enough. A gate whose
    // allowance is never exercised cannot be told from one switched off.
    for (const rel of EXEMPT) {
      const file = sourceFiles().find((f) => f.rel === rel);
      expect(file, `${rel} is missing`).toBeDefined();
      expect(clockReads(file!.text).length, `${rel} no longer reads a clock`).toBeGreaterThan(0);
    }
  });

  // The predicate, proven on planted lines before it is trusted over the
  // tree. All but the first two refused forms walked past the first version
  // of this gate. Each allowed form is what this package legitimately writes
  // and is the case a widened pattern would break.
  describe("the clock predicate", () => {
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
      ["current_date outside a template", "const q = \"select current_date\";"],
      ["clock_timestamp in SQL", "const q = sql`select clock_timestamp()`;"],
      // Three more server clocks the first list did not name. A closed set of
      // keywords is only as good as the set, and these three read a clock in
      // exactly the way `current_timestamp` does -- `age(x)` with one
      // argument is `current_date - x`, which is the wall clock wearing a
      // subtraction.
      ["transaction_timestamp in SQL", "const q = sql`select transaction_timestamp()`;"],
      ["statement_timestamp in SQL", "const q = sql`select statement_timestamp()`;"],
      ["one-argument age in SQL", "const q = sql`select age(created_at)`;"],
      // And a clock read on the same line as a string that happens to hold a
      // `//`. The comment blanker cut everything after the first `//` on a
      // line, wherever it was, so a url in a string swallowed the rest of
      // that line before the predicate ever saw it.
      ["a clock read after a url in a string", 'const u = "https://x/y"; const t = Date.now();'],
    ])("refuses %s", (_form, line) => {
      expect(clockReads(line)).toHaveLength(1);
    });

    it.each([
      ["new Date given an instant", "const t = new Date(at);"],
      ["new Date given a literal", "const t = new Date(0);"],
      ["Date in a type position", "function next(at: Date): Date {"],
      ["Date as a generic argument", "const seen: Map<string, Date> = new Map();"],
      ["a constructor whose name starts with Date", "const r = new DateRange();"],
      ["the injected clock", "const now = this.clock.now();"],
      ["the injected clock through a local", "const now = clock.now();"],
      ["a column called now_at", "const q = sql`select now_at from t`;"],
      ["a method named now in an interface", "  now(): Date;"],
      ["a method named now being implemented", "  now() { return this.at; }"],
      ["a comment mentioning the clock", "// Date.now() is refused in this package."],
      ["a trailing comment mentioning the clock", "const t = at; // not Date.now()"],
      ["a url in a string, with no clock after it", 'const u = "https://x/now()";'],
      ["age with two arguments, which reads no clock", "const q = sql`select age(a, b)`;"],
    ])("allows %s", (_form, line) => {
      expect(clockReads(line)).toEqual([]);
    });

    it("sees a clock read split across two lines, which a per-line scan cannot", () => {
      // The plant, verbatim. `new Date(Date` matches no pattern on its own
      // and `.now())` carries no `Date`, so before the two-line window this
      // form walked past the gate and was caught only by sixteen fixture
      // tests -- tests of retention, not of this rule.
      const split = ["  const now = new Date(Date", "    .now());"].join("\n");
      expect(clockReads(split)).toHaveLength(1);
      expect(clockReads(split)[0]).toMatch(/across two lines/);
      // And the line number is the FIRST of the two, which is where a reader
      // starts looking.
      expect(clockReads(split)[0]).toMatch(/^1:/);
    });

    it("does not invent a split out of two innocent lines", () => {
      // The window's own cost, pinned: a line ending in a `Date` TYPE next to
      // a line that reads the injected clock is the shape most likely to be
      // mistaken for a split, and it is what this package actually writes.
      expect(clockReads(["function next(at: Date): Date {", "  return this.clock.now();"].join("\n")))
        .toEqual([]);
      expect(clockReads(["const seen: Map<string, Date> = new Map();", "  const t = clock.now();"].join("\n")))
        .toEqual([]);
      // Nor is an offender reported twice, once on its own line and once on
      // the window above it.
      expect(clockReads(["const a = 1;", "const t = Date.now();"].join("\n"))).toHaveLength(1);
    });

    it("sees the database's clock on its own line inside a multi-line query", () => {
      // How every query in this package is actually written, and the case a
      // per-line backtick test missed: `migrate.ts`'s own `default now()`
      // sits four lines below the opening tick.
      const module = [
        "await sql`",
        "  create table if not exists schema_migration (",
        "    filename text primary key,",
        "    applied_at timestamptz not null default now()",
        "  )`.execute(db);",
      ];
      expect(clockReads(module.join("\n"))).toEqual([
        "4: SQL now() in a template: applied_at timestamptz not null default now()",
      ]);
    });

    it("reports the line number of an offender inside a module", () => {
      // Restored from the tagging gate, where this copy had dropped it: a
      // refusal that cannot say WHERE sends the reader off to grep a
      // package.
      const module = [
        "const a = 1;", "", "function f() {", "  // nothing", "  const t = new Date;", "}",
      ];
      expect(clockReads(module.join("\n"))).toEqual([
        "5: new Date with no argument: const t = new Date;",
      ]);
    });
  });
});
