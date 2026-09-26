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
    (l) => /(?<![.\w])(current_timestamp|clock_timestamp|current_date|localtimestamp)\b/i.test(l),
  ],
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
    .replace(/\/\/[^\n]*/g, "");
}

function clockReads(text: string): string[] {
  const found: string[] = [];
  // Backtick parity, so a `now()` on its own line inside a multi-line sql
  // template is still seen as SQL. Every query this package writes spans
  // lines, so a per-line "does this line hold a backtick" test missed all of
  // them -- including `migrate.ts`'s own `default now()`, which is how the
  // omission was found. Comments are blanked before this runs, so a backtick
  // in prose cannot skew the parity.
  let inSql = false;
  code(text)
    .split("\n")
    .forEach((line, i) => {
      for (const [name, matches] of CLOCK_FORMS) {
        if (matches(line, inSql)) {
          found.push(`${i + 1}: ${name}: ${line.trim()}`);
          break;
        }
      }
      const ticks = (line.match(/`/g) ?? []).length;
      if (ticks % 2 === 1) inSql = !inSql;
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
    ])("allows %s", (_form, line) => {
      expect(clockReads(line)).toEqual([]);
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
