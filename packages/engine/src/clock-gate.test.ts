import { createHash } from "node:crypto";
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

// Every extension the compiler admits, PLUS the plain-JavaScript ones. Measured:
// a `clocky.js` beside a `clocky.d.ts`, imported by a module, held a
// `Date.now()` that this gate could not see, typechecked clean, and then emitted
// nothing into `dist` -- so the built package was broken as well as unscanned.
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx|js|mjs|cjs)$/;

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
  // `hrtime` and `uptime` both; `process.uptime()` measures from process start
  // rather than from the epoch and is a clock read all the same.
  ["process.hrtime", (l) => /\bprocess\s*\.\s*(hrtime|uptime)\b/.test(l)],
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
// One form the store's list does not carry, and it is the engine's alone: the
// engine formats no dates, so any `Intl.DateTimeFormat` here is either a clock
// read (`format()` with no argument returns TODAY) or presentation the engine
// has no business doing. The store may legitimately format, so this is not
// pushed onto its list; the drift test only requires that this list be a
// SUPERSET of the store's.
const ENGINE_ONLY_CLOCK_FORMS: ReadonlyArray<Form> = [
  ["Intl date formatter", (l) => /\bIntl\s*\.\s*DateTimeFormat\b/.test(l)],
];

const ID_FORMS: ReadonlyArray<Form> = [
  ["randomUUID", (l) => /\brandomUUID\b/.test(l)],
  ["Math.random", (l) => /\bMath\s*\.\s*random\b/.test(l)],
  // `crypto.getRandomValues` and `randomBytes` are the same hole one layer
  // down: an id built out of bytes is still an id the core invented.
  // `randomFill` and `generateKey` are the same hole one spelling over: review
  // built a working id out of `generateKeySync("hmac", ...).export()`.
  ["random bytes", (l) => /\b(getRandomValues|randomBytes|randomInt|randomFill|randomFillSync|generateKey|generateKeySync)\b/.test(l)],
];

const ALL_FORMS: ReadonlyArray<Form> = [...CLOCK_FORMS, ...ENGINE_ONLY_CLOCK_FORMS, ...ID_FORMS];

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

// The characters after which a `/` begins a REGEX LITERAL rather than a
// division, plus the keywords that do the same. Needed because a regex's
// contents must never be read as code: a `//` inside one starts no comment, a
// quote inside one opens no string, and a `/*` inside one opens no block.
const REGEX_MAY_FOLLOW = "([{,;:=!&|?+-~^<>*%";
const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case",
  "do", "else", "yield", "await",
]);

/**
 * The end of the regex literal starting at `start`, or null when what starts
 * there is not one. Handles `\` escapes and `[...]` classes, inside which a `/`
 * does not close the literal. A newline before the close means it was a
 * division, not a regex.
 */
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
 * The module with its COMMENTS removed and everything else kept, line count
 * preserved so line numbers still point at the source. String contents are
 * KEPT on purpose: `const q = "select current_date"` is a clock read this gate
 * refuses, and blanking strings would lose every SQL form on the list.
 *
 * THREE THINGS THIS HANDLES, EACH BECAUSE A VERSION WITHOUT IT LOST A RULE.
 *
 * 1. A comment opener inside a STRING. The first version ran the block-comment
 *    regex before tracking quotes, so `const glob = "dist/*"` opened a comment
 *    that the next `*\/` -- a regex, or any later doc comment -- closed, and
 *    every clock read between them vanished.
 *
 * 2. A comment opener inside a REGEX. `const re = /^https?:\/\//;` ends in
 *    `\/\/`; with `\` treated as an escape only inside quotes, that `//` read
 *    as a line comment and blanked the rest of its line -- so
 *    `const re = /^https?:\/\//; const t = Date.now();` walked past. A URL
 *    scheme regex is ordinary code, and this was the most realistic of the four
 *    regressions a second review measured. Regex literals are now skipped
 *    whole, so nothing inside one is interpreted.
 *
 * 3. A DESYNC bounded to one line. A single- or double-quoted string cannot
 *    span a line in JavaScript, so a quote still open at a newline means the
 *    scanner was wrong -- and carrying that state onward INVERTS the parse:
 *    string contents get read as code, and a `//` inside a real string then
 *    blanks real code. That is how `/["]/` followed by a line holding a url and
 *    a clock read walked past. Such a quote is dropped at the newline, so the
 *    damage cannot leave the line it started on. A backtick is NOT dropped,
 *    because a template legitimately spans lines.
 *
 * What it still does not do: a regex is only recognised where one may begin, by
 * the character or keyword before it, so `/` after an identifier is a division.
 * A regex containing `current_date` would be read as a clock read. Both err
 * toward REFUSING, which is the direction this gate should fail in -- unlike the
 * inversion above, which erred toward missing.
 */
function code(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let inBlock = false;
  let lastChar = "";
  let lastWord = "";
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inBlock) {
      if (c === "*" && next === "/") { out += "  "; i += 2; inBlock = false; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
      if (c === quote) { quote = null; out += c; i += 1; continue; }
      if (c === "\n") {
        if (quote !== "`") quote = null;
        out += "\n";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") { out += "  "; i += 2; inBlock = true; continue; }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/") {
      const mayStart =
        lastChar === "" || REGEX_MAY_FOLLOW.includes(lastChar) ||
        (/[A-Za-z]/.test(lastChar) && KEYWORDS_BEFORE_REGEX.has(lastWord));
      const end = mayStart ? endOfRegex(text, i) : null;
      if (end !== null) {
        out += text.slice(i, end);
        lastChar = "/";
        lastWord = "";
        i = end;
        continue;
      }
    }
    if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; out += c; i += 1; continue; }
    out += c;
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) lastWord = /[A-Za-z0-9_$]/.test(lastChar) ? lastWord + c : c;
      else lastWord = "";
      lastChar = c;
    }
    i += 1;
  }
  return out;
}

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
 *
 * STATEMENTS, not lines, and that distinction is the second bug in this
 * function rather than a nicety. The first version tested each line for
 * `import ... from`, which blanks a one-line import and misses this:
 *
 *   import {
 *     randomUUID,
 *   } from "node:crypto";
 *
 * The middle line is not an import by that test, so `randomUUID` on it kept the
 * exemption alive exactly as the single-line import had. Measured: with
 * `ids.ts` reformatted that way and its call replaced by a constant, all fifty
 * tests in this file passed. A fix checked only against the mutant it was
 * written for is the shape of the defect it was fixing.
 *
 * The span is bounded by `[^;]*?` rather than `[\s\S]*?`, so a match cannot
 * run from an `export const` through the rest of the file to some later
 * `from`: a multi-line import contains no semicolon before its own end.
 */
function withoutImports(text: string): string {
  const IMPORT_STATEMENT =
    /^[ \t]*(?:import|export)[^;]*?\bfrom[ \t]*(["'])[^"']*\1[ \t]*;?|^[ \t]*import[ \t]*(["'])[^"']*\2[ \t]*;?/gm;
  // Blanked, not deleted, so line numbers still point at the source.
  return text.replace(IMPORT_STATEMENT, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * The store's `CLOCK_FORMS` block, verbatim, and its digest.
 *
 * WHY A DIGEST AND NOT A PARSE. The first version of this check read the store's
 * form NAMES out of its source with a regex and compared the sets. Review made
 * the store's list grow in seven ways and the check saw ONE of them: a
 * single-quoted name walked past, a template-literal name walked past, a name
 * held in a `const` walked past, a name passed through a helper walked past, a
 * second list spread into the store's scan walked past, and widening an existing
 * pattern without adding a name walked past by design. A check that misses six
 * of seven changes is worse than no check, because its green is what the commit
 * message asks a reader to trust.
 *
 * So the whole block is hashed. ANY edit to the store's list turns this red, and
 * the red is the instruction: read what changed, copy the form across, and
 * update the digest in the same commit. That is a deliberate chore -- it is the
 * chore that keeps two copies of a scanner honest, and the alternative measured
 * worse.
 */
const STORE_CLOCK_FORMS_SHA256 = "b29de15e07833b2da6d27c2ab63c77c43feb0356f5d76737e70aec6959368699";

/**
 * The form-list identifiers a gate's source declares. A named function because
 * the drift test's inline version could be replaced by a hard-coded
 * `["CLOCK_FORMS"]` with nothing noticing -- the real store file has exactly one
 * list, so the rule was held by the tree being clean.
 */
function formListsIn(text: string): string[] {
  return [...new Set([...code(text).matchAll(/\b[A-Z][A-Z0-9_]*FORMS\b/g)].map((m) => m[0]))].sort();
}

/** The expressions a gate's source iterates its forms over. */
function formIterationsIn(text: string): string[] {
  return [...code(text).matchAll(/\bof\s+([^)]*?)\)\s*if\b/g)].map((m) => m[1]!.trim());
}

function storeClockFormsBlock(): string {
  const text = readFileSync(storeGate, "utf8");
  const start = text.indexOf("const CLOCK_FORMS");
  expect(start, "the store's gate no longer declares CLOCK_FORMS").toBeGreaterThan(-1);
  const end = text.indexOf("\n];", start);
  expect(end, "the store's CLOCK_FORMS list is not terminated as expected").toBeGreaterThan(start);
  return text.slice(start, end + 3);
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
      ["process.uptime", "const t = process.uptime();"],
      ["a formatter with no argument, which formats today", 'const d = new Intl.DateTimeFormat("en").format();'],
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


    it("does not lose a clock read to a string that contains a comment opener", () => {
      // MEASURED, and it left this gate green over the tree. The scanner used to
      // run the block-comment regex before it tracked quotes, so `"dist/*"`
      // opened a comment that the next `*/` closed -- and any regex literal or
      // later doc comment supplies one. Everything between them was blanked,
      // clock read included.
      const module = [
        'const glob = "dist/*";',
        "const t = Date.now();",
        "const re = /x*/;",
      ].join("\n");
      expect(nondeterminismReads(module)).toEqual([
        "2: Date.now: const t = Date.now();",
      ]);
      // And the other order: a comment opener in a string AFTER the read.
      expect(nondeterminismReads(['const t = Date.now();', 'const g = "a/*b";'].join("\n"))).toHaveLength(1);
    });

    it("scans a plain .js module, which a TypeScript-only pattern cannot see", () => {
      // The extension list, held. Measured: a `clocky.js` beside a `clocky.d.ts`,
      // imported by a module, held a `Date.now()` this gate could not see, and
      // `tsc` then emitted nothing for it -- so the built package was broken as
      // well as unscanned. Removing the JavaScript extensions from SOURCE left
      // every test green, because the engine has no `.js` module today.
      expect(SOURCE.test("clocky.js")).toBe(true);
      expect(SOURCE.test("clocky.mjs")).toBe(true);
      expect(SOURCE.test("clocky.cjs")).toBe(true);
      expect(SOURCE.test("policy.ts")).toBe(true);
      expect(SOURCE.test("notes.md")).toBe(false);
      // And the test-suffix list moves with it, or a `util.test.js` would be
      // scanned as a module.
      expect(TEST.test("util.test.js")).toBe(true);
      expect(TEST.test("util.test.ts")).toBe(true);
      expect(TEST.test("policy.ts")).toBe(false);
    });

    it("reads nothing inside a regex literal as code", () => {
      // REGRESSION ROWS. A version of this scanner treated `\\` as an escape only
      // inside quotes and carried quote state across lines, and a second review
      // measured four real clock reads walking past it. Each is a row now.
      //
      // A URL-scheme regex ends in `\\/\\/`, which read as a line comment and
      // blanked the rest of its line. The most realistic of the four.
      expect(nondeterminismReads('const re = /^https?:\\/\\//; const t = Date.now();')).toHaveLength(1);
      // A regex with an odd quote opened a fake string that the next real string
      // closed, so a url's `//` became code and blanked the read.
      expect(nondeterminismReads(['const re = /["]/;', 'const u = "https://x"; const t = Date.now();'].join("\n")))
        .toHaveLength(1);
      // A regex holding one backtick inverted template parity.
      expect(nondeterminismReads(['const n = (l) => (l.match(/`/g) ?? []).length;', 'const u = `https://x`; const t = Date.now();'].join("\n")))
        .toHaveLength(1);
      // And `/*` inside a character class opened a block comment that any later
      // `*/` closed -- a miss BOTH the old and the new scanner had.
      expect(nondeterminismReads(['const re = /[/*]/;', 'const t = Date.now();', '/** later */'].join("\n")))
        .toHaveLength(1);
      // The controls: legitimate code that must stay clean.
      expect(nondeterminismReads('const re = /^https?:\\/\\//;')).toEqual([]);
      expect(nondeterminismReads("const half = (a, b) => a / b; // not Date.now()")).toEqual([]);
      expect(nondeterminismReads(["const q = `", "  select 1", "`;"].join("\n"))).toEqual([]);
    });

    it("reports the line number of an offender inside a module", () => {
      const module = ["const a = 1;", "", "function f() {", "  // nothing", "  const id = randomUUID();", "}"];
      expect(nondeterminismReads(module.join("\n"))).toEqual([
        "5: randomUUID: const id = randomUUID();",
      ]);
    });

    // The import blanker, on planted lines. Review found the tree-level
    // exemption test was the ONLY thing holding it: replacing `withoutImports`
    // with the identity function survived, because the helper had no test and
    // the rule was held by hand-mutating `ids.ts`. That is the same shape as the
    // defect the helper exists to fix.
    describe("the import blanker", () => {
      it("blanks a one-line import", () => {
        expect(nondeterminismReads(withoutImports('import { randomUUID } from "node:crypto";'))).toEqual([]);
      });

      it("blanks a MULTI-LINE import, which a per-line test cannot", () => {
        const multi = ['import {', "  randomUUID,", '} from "node:crypto";'].join("\n");
        expect(nondeterminismReads(withoutImports(multi))).toEqual([]);
      });

      it("leaves a CALL alone, so the blanker cannot blank the thing it is looking for", () => {
        // The control. A blanker that blanks too much makes every mutant die for
        // the wrong reason, so this row is as load-bearing as the two above.
        const module = ['import { randomUUID } from "node:crypto";', "const id = randomUUID();"].join("\n");
        expect(nondeterminismReads(withoutImports(module))).toEqual([
          "2: randomUUID: const id = randomUUID();",
        ]);
      });

      it("preserves line numbers, so a refusal still points at the source", () => {
        const module = ['import {', "  randomUUID,", '} from "node:crypto";', "", "const id = randomUUID();"].join("\n");
        expect(nondeterminismReads(withoutImports(module))).toEqual([
          "5: randomUUID: const id = randomUUID();",
        ]);
      });

      it("does not run a match from an export through the rest of the file", () => {
        // The `[^;]*?` bound. With `[\s\S]*?` an `export const` would pair with
        // any later `from` and swallow the code between them.
        const module = [
          "export const source = {",
          "  next: () => randomUUID(),",
          "};",
          'const note = "taken from crypto";',
        ].join("\n");
        expect(nondeterminismReads(withoutImports(module))).toEqual([
          "2: randomUUID: next: () => randomUUID(),",
        ]);
      });
    });

    it("blanks a clock read inside a block comment", () => {
      // The block-comment arm of `code()`, which nothing exercised directly.
      expect(nondeterminismReads("/* Date.now() is refused here */")).toEqual([]);
      expect(nondeterminismReads(["/*", " * const t = Date.now();", " */"].join("\n"))).toEqual([]);
      // And the line after a block comment is still read.
      expect(nondeterminismReads(["/* nothing */", "const t = Date.now();"].join("\n"))).toHaveLength(1);
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

  it("carries every clock form the store's gate declares, byte for byte", () => {
    // THE DRIFT TEST, and the reason this file may be a copy at all.
    //
    // Each of the store's patterns except the first two was added after review
    // planted a spelling that walked past it. A copy frozen at today's list
    // would report green on a narrower one the day the store's grows, and
    // nothing would say so.
    const block = storeClockFormsBlock();
    const digest = createHash("sha256").update(block).digest("hex");
    expect(
      digest,
      "the store's CLOCK_FORMS block has changed.\n" +
        "Read the diff, carry any new form into this file's CLOCK_FORMS, then set\n" +
        "STORE_CLOCK_FORMS_SHA256 to " + digest + " in the same commit.",
    ).toBe(STORE_CLOCK_FORMS_SHA256);

    // THE SCAN SITE, pinned as well as the list. The digest covers the block
    // from `const CLOCK_FORMS` to its `];` and nothing else, so review grew what
    // the store refuses from OUTSIDE it: a second list declared a hundred lines
    // down and spread in at the iteration site -- `of [...CLOCK_FORMS,
    // ...EXTRA_FORMS]` -- left this test green while the store refused a form
    // this file does not carry. A digest over a list does not pin the list that
    // is actually used.
    const storeSource = readFileSync(storeGate, "utf8");
    const formLists = formListsIn(storeSource);
    expect(
      formLists,
      "the store's gate declares a form list this one does not know about:\n" + formLists.join("\n"),
    ).toEqual(["CLOCK_FORMS"]);
    // And the one place it is iterated reads that list and nothing joined to it.
    expect(
      formIterationsIn(storeSource),
      "the store iterates its forms somewhere this test cannot see",
    ).toEqual(["CLOCK_FORMS"]);

    // And the names, still compared, because the digest says THAT something
    // changed while this says WHAT is missing. Kept as a diagnostic and not as
    // the rule: review walked six of seven list changes past it.
    const mine = new Set(CLOCK_FORMS.map(([name]) => name));
    const theirs = [...code(block).matchAll(/\[\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(theirs.length, "read no form names out of the store's gate").toBeGreaterThan(10);
    const missing = theirs.filter((name) => !mine.has(name));
    expect(
      missing,
      "the store's clock gate declares forms this one does not; copy them across:\n" + missing.join("\n"),
    ).toEqual([]);
  });

  it("names a second form list spread in at the store's scan site", () => {
    // The extraction, proven on synthetic text. Hard-coding its result survived
    // mutation, because the real store file has exactly one list -- so the rule
    // was held by the tree being clean, again.
    const synthetic = [
      "const CLOCK_FORMS = [",
      '  ["Date.now", (l) => /x/.test(l)],',
      "];",
      "const EXTRA_FORMS = [",
      '  ["Temporal.Now", (l) => /y/.test(l)],',
      "];",
      "    for (const [name, matches] of [...CLOCK_FORMS, ...EXTRA_FORMS]) if (matches(t, s)) return name;",
    ].join("\n");
    expect(formListsIn(synthetic)).toEqual(["CLOCK_FORMS", "EXTRA_FORMS"]);
    expect(formIterationsIn(synthetic)).toEqual(["[...CLOCK_FORMS, ...EXTRA_FORMS]"]);
    // A single-list file yields exactly the one name and the bare iteration.
    const honest = [
      "const CLOCK_FORMS = [",
      '  ["Date.now", (l) => /x/.test(l)],',
      "];",
      "    for (const [name, matches] of CLOCK_FORMS) if (matches(t, s)) return name;",
    ].join("\n");
    expect(formListsIn(honest)).toEqual(["CLOCK_FORMS"]);
    expect(formIterationsIn(honest)).toEqual(["CLOCK_FORMS"]);
  });

  it("would notice the store's list changing, which is the only thing the digest is for", () => {
    // The digest's own proof. Without this the pin is a constant nobody has seen
    // fail, and a pin that has never been observed to fire is indistinguishable
    // from a pin of the wrong thing.
    const block = storeClockFormsBlock();
    for (const change of [
      block + '\n["process.uptime", (l) => /uptime/.test(l)],',
      block.replace('"Date.now"', "'Date.now'"),
      block.replace("const CLOCK_FORMS", "const CLOCK_FORMS /* reordered */"),
    ]) {
      expect(createHash("sha256").update(change).digest("hex")).not.toBe(STORE_CLOCK_FORMS_SHA256);
    }
  });

});
