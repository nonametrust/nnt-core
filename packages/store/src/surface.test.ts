import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as surface from "./index.js";
import { BaselineRepository } from "./repositories/baseline.js";
import { TagRepository } from "./repositories/tag.js";
import { TriggerEventRepository } from "./repositories/trigger-event.js";
import { VolatilityRepository } from "./repositories/volatility.js";
import { AuditChain } from "./audit/chain.js";
import { fixedClock } from "./clock.js";
import { openDb } from "./db.js";
import { randomBytes } from "node:crypto";
import { keyRingFromEnv } from "./crypto.js";

// What this package's PUBLIC SURFACE promises, held as a test rather than as a
// sentence at the top of `index.ts`.
//
// WHY IT EXISTS NOW. F7 of M3's survey measured that the surface as declared
// CANNOT construct a repository: every repository constructor takes a `Db`, and
// `index.ts` exported no way to make one. The built `dist/index.d.ts` contained
// none of `openDb`, `Db`, `Schema` or `withIsoDates`. So a consumer had two
// options, both bad -- reach past the surface into `dist/db.js`, which resolves
// because `package.json` has no `exports` field, or give up. R20 closes it by
// exporting the CONNECTION, and this file holds both halves of that ruling: what
// is now exported, and what is still not.
//
// The boundary remains a CONVENTION and not a mechanism, and saying so is part
// of the ruling: with no `exports` field a deep import still resolves, so what
// stops one is the engine's own boundary gate refusing it on the consumer's
// side. Recorded rather than implied.
const indexSource = readFileSync(fileURLToPath(new URL("./index.js", import.meta.url).href.replace(/\.js$/, ".ts")), "utf8");

describe("the store's public surface", () => {
  it("can construct a repository, which R20 exists to make true", () => {
    // The whole of F7 in one assertion: a consumer holding only the public
    // surface can open a connection and build a repository with it.
    expect(typeof surface.openDb).toBe("function");
    const db = surface.openDb("postgres://nnt@127.0.0.1:1/never-connected");
    // Constructing does not connect, so this needs no database.
    const repo = new surface.BaselineRepository(db, surface.fixedClock(new Date("2026-09-21")));
    expect(repo).toBeInstanceOf(surface.BaselineRepository);
    void db.destroy();
  });

  it("exports the connection and the type, and not the SQL", () => {
    // R20's sentence, held name by name. `Schema` and `withIsoDates` stay
    // unexported: a consumer needing a query this package does not offer gets a
    // repository method, not a query builder and not a column list.
    for (const name of ["openDb", "fixedClock", "systemClock", "migrate"]) {
      expect(Object.keys(surface), `${name} must be exported`).toContain(name);
    }
    for (const name of ["withIsoDates", "refuseWriteInsideTransaction"]) {
      expect(Object.keys(surface), `${name} must NOT be exported`).not.toContain(name);
    }
    // `Db` and `Schema` are types and leave no runtime key, so they are held
    // lexically against `index.ts`: `Db` named, `Schema` not.
    expect(indexSource).toMatch(/export type \{[^}]*\bDb\b/);
    expect(indexSource).not.toMatch(/export type \{[^}]*\bSchema\b/);
    // And the header sentence changed with the ruling. The old one said the
    // connection is NOT exported, which stopped being true.
    // Matched on one line of the header, since the sentence wraps.
    expect(indexSource).toMatch(/errors and the$/m);
    expect(indexSource).toMatch(/^\/\/ connection are exported; the SQL is not\./m);
  });

  it("exposes each repository's clock, so a composition root can be checked", () => {
    // THE FIVE WORDS TASK 5 NEEDS. §3 requires the engine's instant to come from
    // the same `Clock` object the store holds, and review measured that 7 of 8
    // repository classes take an unchecked clock -- only `ObservationRepository`
    // compares, and only against its namespace repository. The fix was ruled
    // ENGINE-side: one composition root, and a test asserting every repository's
    // clock is `===` one object. That test cannot exist while the field is
    // private, so it is `readonly` and public here.
    //
    // Not a behaviour change and not a check: a reader of one repository still
    // cannot tell whether its clock is anyone else's. That comparison is the
    // engine's to make, which is the point of the ruling.
    const db = openDb("postgres://nnt@127.0.0.1:1/never-connected");
    const clock = fixedClock(new Date("2026-09-21T00:00:00Z"));
    const ring = keyRingFromEnv({ NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv);
    // `HotWindowRepository` is not here and that is not an omission: it takes no
    // clock, because a window's instants are its trigger's. The set below is
    // every class that DOES take one, which is what a composition root has to
    // check.
    const built = [
      new BaselineRepository(db, clock),
      new TagRepository(db, clock),
      new TriggerEventRepository(db, clock),
      new VolatilityRepository(db, clock),
      new AuditChain(db, clock, ring),
    ];
    // `NamespaceRepository` is not built here only because it also needs a
    // KeyRing; its clock was already public before this change, on exactly the
    // argument R20's ruling makes -- `observation.ts` refuses a clock that is not
    // this one "rather than trusting a convention". That precedent is why
    // exposing the others is not a new idea.
    for (const repo of built) {
      expect(repo.clock, `${repo.constructor.name} must expose the clock it was given`).toBe(clock);
    }
    void db.destroy();
  });
});
