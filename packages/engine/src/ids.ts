import { randomUUID } from "node:crypto";

/**
 * The engine's identifier seam, and the ONE module in this package allowed to
 * mint one. `clock-gate.test.ts` exempts this file by name and refuses
 * `randomUUID`, `Math.random` and every random-bytes spelling everywhere else.
 *
 * WHY A SEAM AND NOT A CALL. The brief is a pure function of its inputs: it
 * takes its instant, its ids and its policies as arguments and returns a value
 * plus a list of effects, so that the same inputs replay to the same output.
 * That is what design §9's determinism claim rests on, and a single
 * `randomUUID()` reached for inside the core breaks it in the worst available
 * way -- the output stays well-formed, passes every assertion about its shape,
 * and differs between two runs. So ids enter from the edge, and the edge is
 * here.
 *
 * WHY THE ENGINE HAS NO CLOCK MODULE BESIDE THIS ONE. The instant comes from
 * the store's own injected `Clock`, the same object the store holds -- `open`
 * and `refresh` refuse a `taggedAt` after `clock.now()`, and the store's
 * constructor refuses a clock that is not its namespace repository's. Two
 * clock objects in one composition is a class of bug the store already
 * refuses, so the engine passes the one it is given down rather than making a
 * second.
 */
export interface IdSource {
  /** A fresh identifier. Called by a wrapper, never by the core. */
  next(): string;
}

/**
 * The production source. A v4 UUID from `node:crypto`, which is what the
 * store's own `trigger_event` and `audit_entry` rows are keyed on.
 *
 * A test that needs to know the ids in advance does not stub this: it passes
 * the ids the core takes as arguments. That is the whole point of the seam,
 * and it is why this module has no test double in it.
 */
export const randomIdSource: IdSource = {
  next: (): string => randomUUID(),
};
