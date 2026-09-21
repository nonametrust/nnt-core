import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { fieldsOf } from "./interface-fields.js";

// What a tag refresh writes is declared twice: once in packages/tagging,
// whose arithmetic produces it, and once in packages/store, which writes it.
// The same reason as the baseline gate beside this one -- tagging may not
// import store, and the shape is not the indexer's contract, so it does not
// belong in schema -- and the same consequence if they drift.
//
// The consequence is worse here than for a baseline. The store writes these
// four values as handed and recomputes none of them, because it deliberately
// holds no half-life. A field the arithmetic starts returning and the store
// does not know about is therefore not written at all, and the tag keeps the
// old value with nothing raising anything: the refresh appears to succeed and
// the row is half-updated. That is the failure this gate exists to prevent,
// and it is silent in production and green in both packages' own suites.
const root = fileURLToPath(new URL("../", import.meta.url));
const DECLARATIONS = {
  tagging: "packages/tagging/src/tag.ts",
  store: "packages/store/src/repositories/tag.ts",
} as const;

function declared(which: keyof typeof DECLARATIONS): string[] {
  return fieldsOf(
    readFileSync(join(root, DECLARATIONS[which]), "utf8"),
    "TagRefresh",
    DECLARATIONS[which],
  );
}

describe("the tag refresh shape", () => {
  // A comparison of two empty lists is green for free. The gate vouches for
  // nothing until it has found the fields the decision is known to carry.
  it("is found in both packages with the four fields in each, so the gate cannot pass by comparing nothing", () => {
    for (const which of ["tagging", "store"] as const) {
      const fields = declared(which);
      expect(fields, `${DECLARATIONS[which]} declares no fields`).not.toEqual([]);
      for (const f of [
        "g0: number",
        "taggedAt: Date",
        "refreshCount: number",
        'saturationState: "open" | "saturated"',
      ]) {
        expect(fields, `${DECLARATIONS[which]} lacks ${f}`).toContain(f);
      }
    }
  });

  it("agrees field for field between packages/tagging and packages/store", () => {
    expect(declared("tagging")).toEqual(declared("store"));
  });

  // The extractor is shared with the baseline gate, so its self-checks live
  // beside it there. What is checked here is that it is reading THIS name:
  // pointed at an interface the file does not declare it must fail loudly
  // rather than return nothing and compare two empty lists.
  it("reads the named interface and refuses a name the source does not declare", () => {
    const source = readFileSync(join(root, DECLARATIONS.store), "utf8");
    expect(() => fieldsOf(source, "NoSuchShape", "store")).toThrow(/no .*NoSuchShape/);
    expect(fieldsOf(source, "TagRefresh", "store")).toContain("g0: number");
    // OpenTag lives in the same file and is a different shape; reading the
    // wrong one would compare the wrong thing quietly.
    expect(fieldsOf(source, "TagRefresh", "store")).not.toEqual(
      fieldsOf(source, "OpenTag", "store"),
    );
  });
});
