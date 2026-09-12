import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// A baseline's state is declared twice: once in packages/tagging, whose
// arithmetic produces it, and once in packages/store, which stores it.
// tagging may not import store, because that dependency would put a
// database under every tagging test, and the shape does not belong in
// schema, which is the indexer's contract. Two declarations drift, and
// nothing would notice on the day they did: a field added to the store's
// row and not to the arithmetic would be written as its column default on
// every upsert, with no error anywhere. This gate reads both declarations
// as text and holds them equal field for field, name and written type.
//
// Lexical, like the two gates beside it. Importing the store module here
// would bring its driver into the gate's program and make the gate depend
// on a build; and a type-level assignability check passes for two
// declarations that spell one field differently, which is exactly a drift.
//
// What lexical cannot see, said plainly: two fields written in the same
// words that mean different things, `madEst: Estimate` on both sides with
// `Estimate` declared differently in each package. Every field today is
// written as a primitive or a primitive union, and a named type on either
// side would be the moment to reconsider this gate, not to trust it.
//
// And the one form of a second declaration this gate does see: TypeScript
// merges two `interface BaselineState` blocks in one file into one type, so
// a field added in a second block would be real and invisible to a reader
// of the first. A file with more than one block is refused outright rather
// than compared, whatever the blocks say. The typecheck refuses that edit
// too, in both packages; the gate does not lean on it.
const root = fileURLToPath(new URL("../", import.meta.url));
const DECLARATIONS = {
  tagging: "packages/tagging/src/baseline.ts",
  store: "packages/store/src/repositories/baseline.ts",
} as const;

/**
 * The fields of the one `export interface BaselineState { … }` block in a
 * source, each as `name: type`, sorted. Comments inside the block are
 * dropped, block comments before the text is split into lines so that a
 * field commented out across several lines is not counted as declared; a
 * field is what remains of a line once its trailing semicolon is gone.
 * The store's `StoredBaseline extends BaselineState {` is not matched,
 * because the pattern wants `interface BaselineState {` and nothing between.
 * Exactly one block: none is a source the gate cannot read, and two would
 * merge into one type of which the first block is only part.
 */
function fieldsOf(source: string, where: string): string[] {
  const blocks = [...source.matchAll(/export interface BaselineState \{([\s\S]*?)\n\}/g)];
  if (blocks.length === 0) throw new Error(`${where}: no \`export interface BaselineState {\` block found`);
  if (blocks.length > 1) {
    throw new Error(
      `${where}: ${blocks.length} \`export interface BaselineState {\` blocks found; TypeScript merges them and this gate compares one`,
    );
  }
  return blocks[0]![1]!
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/;$/, ""))
    .sort();
}

function declared(which: keyof typeof DECLARATIONS): string[] {
  return fieldsOf(readFileSync(join(root, DECLARATIONS[which]), "utf8"), DECLARATIONS[which]);
}

describe("the baseline shape", () => {
  // A comparison of two empty lists is green for free. The gate vouches for
  // nothing until it has found the fields the arithmetic is known to carry.
  it("is found in both packages with the Welford fields in each, so the gate cannot pass by comparing nothing", () => {
    for (const which of ["tagging", "store"] as const) {
      const fields = declared(which);
      expect(fields, `${DECLARATIONS[which]} declares no fields`).not.toEqual([]);
      for (const f of ["count: number", "mean: number", "m2: number"]) {
        expect(fields, `${DECLARATIONS[which]} lacks ${f}`).toContain(f);
      }
    }
  });

  it("agrees field for field between packages/tagging and packages/store", () => {
    expect(declared("tagging")).toEqual(declared("store"));
  });

  // The extractor is what the gate rests on, so it is checked against the
  // drifts it must see: one field more on one side, one field hidden in a
  // comment, a source with no such interface at all, and one with two.
  it("is compared by an extractor that tells two shapes apart", () => {
    const a = "export interface BaselineState {\n  count: number;\n  mean: number;\n}\n";
    const b = "export interface BaselineState {\n  count: number;\n  // a comment\n  mean: number;\n  extra: number | null;\n}\n";
    expect(fieldsOf(a, "a")).toEqual(["count: number", "mean: number"]);
    expect(fieldsOf(b, "b")).toEqual(["count: number", "extra: number | null", "mean: number"]);
    expect(fieldsOf(a, "a")).not.toEqual(fieldsOf(b, "b"));

    // A field commented out is not declared, whichever comment form hides
    // it, and a line comment after a live field does not change the field.
    const hidden =
      "export interface BaselineState {\n  count: number; // live\n  /*\n  planted: number;\n  */\n  /* also: number; */ mean: number;\n}\n";
    expect(fieldsOf(hidden, "hidden")).toEqual(["count: number", "mean: number"]);

    // The extends-block is not the block: only the declaration proper counts.
    const extended =
      "export interface StoredBaseline extends BaselineState {\n  updatedAt: Date;\n}\nexport interface BaselineState {\n  count: number;\n}\n";
    expect(fieldsOf(extended, "extended")).toEqual(["count: number"]);

    expect(() => fieldsOf("export interface Other {}", "c")).toThrow(
      "c: no `export interface BaselineState {` block found",
    );

    // A second block merges into the first under declaration merging, so a
    // source with two is refused rather than read as its first block.
    const merged = a + "export interface BaselineState {\n  planted: number;\n}\n";
    expect(() => fieldsOf(merged, "d")).toThrow(
      "d: 2 `export interface BaselineState {` blocks found; TypeScript merges them and this gate compares one",
    );
  });
});
