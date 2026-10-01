import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// G-floors, R49: no module but `relatedness.ts` and `policy.ts` may NAME a floor.
//
// WHAT IT DOES NOT HOLD, measured, and stated first because an earlier version of
// this header claimed "the only way to lower a threshold or cite a reason is
// `isReason`" -- which is wider than any lexical rule can be. A review wrote a
// `thresholdFor` six ways and three of them passed this gate while reaching the
// identical defect: a bare literal (`strength >= 0.25`), a computed property name
// (`policy["active" + "Floor"]`), and no floor at all (`strength > 0`, so every live
// tag lowers).
//
// So this gate refuses NAMING a floor, which is what R49 asks for and what stops the
// obvious mistake.
//
// WHAT REFUSES A DIVERGENT LOWERING SET IS NOT THE CONSISTENCY TEST, and an earlier
// version of this header said it was. Task 6's consistency rows compare
// `thresholdFor` against the brief -- but the brief CALLS the same `countedTags`, so a
// strength-only lowering placed inside that shared function satisfies them perfectly:
// both sides are wrong together. Measured by a review, which is how the claim was
// corrected rather than reasoned.
//
// What holds R39 is three things, all value assertions rather than agreements:
// `brief.test.ts`'s enumeration ("never produces a hold no reason accounts for"),
// which now contains tags that are active and NOT reasons because without them it was
// blind to exactly this mutant; `threshold.test.ts`'s intent-scoped rows, which pin
// WHICH tags lower a threshold under two different floors; and `brief-db.test.ts`'s
// row under a policy where a seeded tag is active and not a reason, which is the same
// property on real rows.
//
// WHAT IT PROTECTS. R39 rules that one predicate decides both what lowers the
// threshold and what the brief may cite -- active AND related -- and `isReason`'s
// docstring says so. Nothing enforced it. Measured lexically at the time R49 was
// written: in the engine's non-test source `activeFloor` is compared in exactly
// one place and `relatednessFloor` in one, both in `relatedness.ts`, so nothing
// stopped a `thresholdFor` that filtered on `strength >= activeFloor` alone, and
// no test would have gone red because no test imported a threshold function yet.
//
// The claim itself was checked before being gated: enumerating 32 tag subsets
// against 10 amounts under the shipped policy with `isReason` applied to both jobs
// produced zero unaccounted holds below the base threshold. This gate is what
// keeps that true.
//
// THE RULE IS THE BARE IDENTIFIER, NOT `.activeFloor`. R49 names the dotted
// tokens; a dotted rule has three holes, and all three are one line of code:
// `const { activeFloor } = policy` destructures past it, `policy["activeFloor"]`
// indexes past it, and a renamed binding hides it. Refusing the identifier
// anywhere in a module's code closes all three, and costs nothing: the two files
// that may compare a floor are exempt, and every other module's mentions are in
// prose.
//
// STRING CONTENTS ARE KEPT, and that is load-bearing rather than inherited:
// `policy["activeFloor"]` IS a string, so a stripper that blanked strings would
// reopen the bypass it was written to close. Its limit, measured: a unicode escape
// inside the string (`"activeFlo\u006Fr"`) reads the same at runtime and walks past
// the pattern. So does an alias assigned from `policy` under another name. Both are
// recorded rather than chased -- a lexical rule cannot follow a value, and the thing
// that can is Task 6's consistency test.
//
// MODULES ONLY, in the idiom of this package's clock gate. A test that asserts
// `BRIEF_POLICY_V0.relatednessFloor` is not a second comparison site -- it is the
// assertion R36 MOVED onto the shipped default when it retired the cross-field
// rule, and `policy.test.ts` is where that belongs. What R49 guards against is a
// module deciding reason-hood twice; a test cannot.
//
// The stripper below is duplicated rather than shared, which is this repository's
// idiom for its gates and has a reason: one shared stripper is one mutation that
// disarms every gate at once.

const srcDir = fileURLToPath(new URL("./", import.meta.url));
const SOURCE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.(ts|mts|cts|tsx|js|mjs|cjs)$/;

/**
 * The two modules that may name a floor: the one that DECLARES the fields and the
 * one that COMPARES them. Pinned by a test below.
 */
const EXEMPT = new Set(["policy.ts", "relatedness.ts"]);

/** Both floors, as bare identifiers. */
const FLOOR = /\b(activeFloor|relatednessFloor)\b/g;

interface SourceFile {
  rel: string;
  text: string;
  isTest: boolean;
}

/** The text with its comments removed, line count and string contents preserved. */
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

/** Every floor this file names in its own code, in source order. */
export function floorMentions(text: string): string[] {
  return [...withoutComments(text).matchAll(FLOOR)].map((m) => m[1]!);
}

/** The offending lines of one file, or none if it may name a floor. */
export function floorOffences(file: SourceFile): string[] {
  if (file.isTest || EXEMPT.has(file.rel)) return [];
  const out: string[] = [];
  withoutComments(file.text)
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(new RegExp(FLOOR.source, "g"))) {
        out.push(`${i + 1}: ${m[1]!} -- ${line.trim()}`);
      }
    });
  return out;
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!SOURCE.test(entry.name)) continue;
    const abs = join(entry.parentPath, entry.name);
    let isFile: boolean;
    try {
      isFile = statSync(abs).isFile();
    } catch (cause) {
      throw new Error(`${relative(srcDir, abs)} cannot be stat'd, so this gate cannot scan it`, {
        cause,
      });
    }
    if (!isFile) continue;
    out.push({
      rel: relative(srcDir, abs),
      text: readFileSync(abs, "utf8"),
      isTest: TEST.test(entry.name),
    });
  }
  return out;
}

describe("a threshold floor", () => {
  it("is named in no module but the one that declares it and the one that compares it", () => {
    const offenders = sourceFiles().flatMap((f) => floorOffences(f).map((o) => `${f.rel}:${o}`));
    expect(
      offenders,
      "these decide reason-hood outside isReason, so the threshold can be lowered by " +
        "strength alone and no test would notice:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("is scanned in at least this package, so the gate cannot pass by scanning nothing", () => {
    const files = sourceFiles();
    expect(files.length, "no engine sources found; the gate is scanning nothing").toBeGreaterThan(5);
    expect(
      files.filter((f) => !f.isTest).length,
      "no MODULES among them, so the rule applies to nothing",
    ).toBeGreaterThan(3);
    for (const required of [...EXEMPT]) {
      expect(
        files.map((f) => f.rel),
        `${required} is not among the scanned files, so its exemption is unverifiable`,
      ).toContain(required);
    }
  });

  describe("the exemption", () => {
    it("names two files, so the allowance cannot widen quietly", () => {
      expect([...EXEMPT].sort()).toEqual(["policy.ts", "relatedness.ts"]);
    });

    it("is doing work: BOTH exempt modules name BOTH floors in their own code", () => {
      // The other half of the pair, and it is stronger than "names at least one".
      // `relatedness.ts` comparing only ONE floor is precisely R39's defect --
      // `isReason` was once `clearsRelatednessFloor` alone, and the conjunction is
      // the whole ruling -- so an exemption that stayed green while one comparison
      // vanished would be holding the door open for the bug it was cut for.
      for (const rel of [...EXEMPT]) {
        const file = sourceFiles().find((f) => f.rel === rel);
        expect(file, `${rel} is missing`).toBeDefined();
        const named = new Set(floorMentions(file!.text));
        expect(
          [...named].sort(),
          `${rel} no longer names both floors in its own code, so its exemption holds nothing open`,
        ).toEqual(["activeFloor", "relatednessFloor"]);
      }
    });
  });

  describe("the predicate, on files that do not exist", () => {
    const asModule = (text: string): SourceFile => ({
      rel: "no-such-module.ts",
      text,
      isTest: false,
    });
    const asTest = (text: string): SourceFile => ({
      rel: "no-such-module.test.ts",
      text,
      isTest: true,
    });

    it.each([
      ["a dotted read, which is what R49 names", "if (tag.strength >= policy.activeFloor) return true;"],
      ["the relatedness floor, dotted", "if (r >= policy.relatednessFloor) return true;"],
      ["a DESTRUCTURED binding, which a dotted rule misses", "const { activeFloor } = policy;"],
      ["a BRACKET read, which a dotted rule misses", 'const f = policy["activeFloor"];'],
      ["a renamed destructuring", "const { activeFloor: floor } = policy;"],
      ["a shorthand in an object literal", "return { activeFloor };"],
      ["a type position", "let f: BriefPolicy[\"activeFloor\"] = 0;"],
    ])("refuses %s", (_form, line) => {
      expect(floorOffences(asModule(line))).toHaveLength(1);
    });

    it("refuses BOTH floors on one line, not just the first", () => {
      const both = "if (s >= policy.activeFloor && r >= policy.relatednessFloor) return true;";
      expect(floorOffences(asModule(both))).toHaveLength(2);
    });

    it.each([
      ["a comment naming a floor", "// compared against policy.activeFloor by isReason"],
      ["a block comment naming one", "/* activeFloor and relatednessFloor both apply */"],
      ["a longer identifier that merely contains one", "const activeFloorCount = 1;"],
      ["a differently prefixed identifier", "const inactiveFloor = 1;"],
      ["the factor, which is NOT a floor", "const t = base * policy.activeTagFactor;"],
      ["a call to the predicate that replaces both reads", "if (isReason(tag, intent, policy)) k++;"],
    ])("allows %s", (_form, line) => {
      expect(floorOffences(asModule(line))).toEqual([]);
    });

    it("allows a floor in a TEST file, which cannot decide reason-hood", () => {
      expect(floorOffences(asTest("expect(BRIEF_POLICY_V0.activeFloor).toBe(0.25);"))).toEqual([]);
    });

    it("allows both floors inside each exempt module, and neither outside", () => {
      const line = "if (s >= policy.activeFloor) return r >= policy.relatednessFloor;";
      for (const rel of [...EXEMPT]) {
        expect(floorOffences({ rel, text: line, isTest: false })).toEqual([]);
      }
      expect(floorOffences({ rel: "threshold.ts", text: line, isTest: false })).toHaveLength(2);
    });

    it("names the floor it found, so the message says which read to replace", () => {
      expect(floorOffences(asModule("const f = policy.relatednessFloor;"))[0]).toContain(
        "relatednessFloor",
      );
    });
  });
});
