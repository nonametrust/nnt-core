/**
 * The extractor two shape gates share, parameterised on the interface name.
 *
 * It was written for `BaselineState`, whose declaration lives once in
 * packages/tagging and once in packages/store because tagging may not import
 * store and the shape does not belong in schema. `TagRefresh` is the second
 * shape in that position, so the reading moved here rather than being copied:
 * a copy drifts, and a drifting extractor is a gate that stops seeing the
 * drift it exists to see.
 *
 * Lexical, like the gates that use it. Importing either module would bring
 * the store's driver into the gate's program and make the gate depend on a
 * build; and a type-level assignability check passes for two declarations
 * that spell one field differently, which is exactly a drift.
 *
 * What lexical cannot see, said plainly: two fields written in the same words
 * that mean different things, `madEst: Estimate` on both sides with
 * `Estimate` declared differently in each package. Every field on both shapes
 * today is a primitive, a primitive union or `Date`, and a named type on
 * either side would be the moment to reconsider these gates, not to trust
 * them.
 */
export function fieldsOf(source: string, name: string, where: string): string[] {
  // Comments are stripped before the search, not after. Stripped after, a
  // declaration wholly inside a block comment reads as live -- and a second,
  // real declaration below it in another form would never be compared. That
  // is the one failure a gate may not have: a silent pass.
  const live = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const pattern = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`, "g");
  const blocks = [...live.matchAll(pattern)];
  if (blocks.length === 0) {
    throw new Error(`${where}: no \`export interface ${name} {\` block found`);
  }
  // TypeScript merges two blocks of one name in one file into a single type,
  // so a field added in a second block would be real and invisible to a
  // reader of the first. Refused outright rather than compared.
  if (blocks.length > 1) {
    throw new Error(
      `${where}: ${blocks.length} \`export interface ${name} {\` blocks found; ` +
        `TypeScript merges them and this gate compares one`,
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
