import { describe, it, expect } from "vitest";
import { randomIdSource } from "./ids.js";

// `ids.ts` is the one module `clock-gate.test.ts` exempts, and until this file
// existed the only thing holding that exemption open was a LEXICAL test: does
// the module still NAME a source of nondeterminism. That question is not the
// one that matters, and it has now been answered wrongly three times.
//
// The history, because it is the argument for this file. The exemption test
// first passed for an `ids.ts` whose `randomUUID()` had been replaced by the
// constant `"fixed"`, because the `import { randomUUID }` line still named it.
// The fix blanked import lines; a MULTI-LINE import then kept it alive the same
// way. The fix blanked import statements; review then walked two more spellings
// past it -- `const { randomUUID } = await import("node:crypto")`, which is not
// an import statement, and a bare `void randomUUID;`, which no blanker can
// reach. Each fix was narrower than the hole.
//
// So the property is tested BEHAVIOURALLY here, and the lexical test stays what
// it says it is: a lint that catches the careless spelling early and in one
// place. A source that returns a constant fails these assertions whatever its
// imports look like, and no spelling walks past a call.
describe("randomIdSource", () => {
  it("mints a different id every time, which a constant cannot do", () => {
    // The assertion every lexical version of this rule missed. Sixty-four
    // draws rather than two, because a source that alternated between two
    // values would pass a single inequality.
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) seen.add(randomIdSource.next());
    expect(seen.size).toBe(64);
  });

  it("mints a v4 UUID, which is what the store's own keys are", () => {
    // `trigger_event` and `audit_entry` are keyed on uuids the store mints the
    // same way. A source handing back something else would be caught by a
    // column type at the far end of Task 8 rather than here.
    const id = randomIdSource.next();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is a seam a test can replace without touching this module", () => {
    // R1's whole point: the core takes its ids as arguments, so a deterministic
    // run supplies its own source and never stubs `node:crypto`. Held here so
    // the shape is pinned before Tasks 5 and 8 depend on it.
    let n = 0;
    const counting = { next: (): string => `id-${(n += 1)}` };
    expect([counting.next(), counting.next()]).toEqual(["id-1", "id-2"]);
    // And the production source satisfies the same type.
    const asSeam: { next: () => string } = randomIdSource;
    expect(typeof asSeam.next()).toBe("string");
  });
});
