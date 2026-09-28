import { describe, it, expect } from "vitest";
import {
  ADMITTED_PATHS,
  assertAuditBody,
  auditBodyPaths,
  type BriefAuditBody,
} from "./audit-body.js";

// R25 and R48: the audit body is a CLOSED type and the runtime check is a
// whitelist that WALKS it.
//
// WHY NOT A BLACKLIST. Measured during review: `AuditChain.append` accepted
// `{ payload, source, evidence: { ref } }`, so a check for keys named `payload` or
// `source` passes `evidence.ref` straight through. The chain outlives both the
// month key and the namespace key, so a body naming a source would defeat erasure
// through the audit table -- the one table erasure cannot reach.
//
// WHY NOT A REGEX OVER THE RENDERED JSON. A string VALUE containing `":` fools
// one, and there is a row below that carries exactly such a value and must pass.

const REASON = {
  tagId: "e3a1c6de-0000-4000-8000-000000000001",
  observationId: "e3a1c6de-0000-4000-8000-000000000002",
  relatednessCase: "same_channel" as const,
  source: "SOURCE_PRESENT" as const,
  datedAt: "2026-09-12T00:00:00.000Z",
  strength: 0.4165,
  relatedness: 0.75,
};

const BODY: BriefAuditBody = {
  briefId: "e3a1c6de-0000-4000-8000-000000000003",
  triggerId: "e3a1c6de-0000-4000-8000-000000000004",
  at: "2026-09-21T00:00:00.000Z",
  namespaceId: "e3a1c6de-0000-4000-8000-000000000005",
  observationId: "e3a1c6de-0000-4000-8000-000000000006",
  amount: 500,
  unit: "USDC",
  riskTier: "high",
  grade: "hold",
  threshold: { base: 600, applied: 384 },
  reasons: [REASON],
};

/** The body with one key added at one path, typed around the closed interface. */
const plus = (patch: Record<string, unknown>): BriefAuditBody =>
  ({ ...BODY, ...patch }) as unknown as BriefAuditBody;

describe("the audit body", () => {
  it("admits the shipped shape", () => {
    expect(() => assertAuditBody(BODY)).not.toThrow();
  });

  it("admits a brief with no candidate trigger, which is a null id and not a missing key", () => {
    // R18 and R29's one branch: a categorical intent and a cold continuous intent
    // both grade and record no trigger. The key stays, so the body's shape does not
    // depend on the outcome -- a body that sometimes lacks a key is a body whose
    // whitelist cannot be compared against its paths.
    expect(() => assertAuditBody({ ...BODY, triggerId: null })).not.toThrow();
  });

  it("admits a reason whose source would not open", () => {
    expect(() =>
      assertAuditBody({
        ...BODY,
        reasons: [{ ...REASON, source: "SOURCE_UNREADABLE", datedAt: null }],
      }),
    ).not.toThrow();
  });

  it("admits no reasons at all, which is the only zero-reason hold R39 leaves", () => {
    expect(() => assertAuditBody({ ...BODY, reasons: [] })).not.toThrow();
  });

  describe("refuses a key the whitelist does not name", () => {
    it("at the top level, named `payload`", () => {
      expect(() => assertAuditBody(plus({ payload: "sealed" }))).toThrow(
        /auditBody\.payload is not admitted/,
      );
    });

    it("at the top level, named `source`", () => {
      expect(() => assertAuditBody(plus({ source: "wire" }))).toThrow(
        /auditBody\.source is not admitted/,
      );
    });

    it("NESTED under a key of its own -- the measured blacklist bypass", () => {
      // `{ payload, source, evidence: { ref } }` is what `AuditChain.append` really
      // accepted. A key check at the top level passes `evidence.ref`.
      expect(() => assertAuditBody(plus({ evidence: { ref: "tx/deadbeef" } }))).toThrow(
        /auditBody\.evidence is not admitted/,
      );
    });

    it("nested INSIDE an admitted object", () => {
      expect(() =>
        assertAuditBody(plus({ threshold: { base: 600, applied: 384, ref: "tx/deadbeef" } })),
      ).toThrow(/auditBody\.threshold\.ref is not admitted/);
    });

    it("nested inside an admitted ARRAY element", () => {
      expect(() =>
        assertAuditBody(plus({ reasons: [{ ...REASON, ref: "tx/deadbeef" }] })),
      ).toThrow(/auditBody\.reasons\[\]\.ref is not admitted/);
    });

    it("admitted at ANOTHER path but not at this one", () => {
      // `unit` is admitted at the top level. Inside `threshold` it is not, and a
      // flat set of admitted key names would let it through -- which is the
      // difference between a whitelist of NAMES and a whitelist of PATHS.
      expect(() =>
        assertAuditBody(plus({ threshold: { base: 600, applied: 384, unit: "USDC" } })),
      ).toThrow(/auditBody\.threshold\.unit is not admitted/);
    });

    it("SPELLED like an admitted path, which is how a whitelist of joined strings is fooled", () => {
      // A review demonstrated this against the shipped walker: `.`, `[` and `]` are
      // legal in a JSON key, and a path is built by joining with them, so a single
      // top-level key named `threshold.base` rendered the admitted path
      // `threshold.base` and passed -- while the value checks read the REAL
      // `body.threshold.base` and never looked at the impostor. `JSON.stringify`
      // then carried the reference into what the chain hashes.
      //
      // Not reachable through `brief()`, whose body has literal keys. Reachable
      // through `assertAuditBody`, which is exported and which Task 8 will reuse for
      // its own kinds -- and the docstring claimed it refuses any key nobody
      // admitted.
      for (const key of ["threshold.base", "reasons[].tagId", "threshold.applied", "a]b"]) {
        expect(() => assertAuditBody(plus({ [key]: "tx/deadbeef" })), key).toThrow(
          /contains path punctuation/,
        );
      }
    });

    it("refuses the punctuation NESTED, not only at the top level", () => {
      expect(() =>
        assertAuditBody(plus({ threshold: { base: 600, applied: 384, "a.b": 1 } })),
      ).toThrow(/contains path punctuation/);
    });

    it("three levels down", () => {
      expect(() =>
        assertAuditBody(plus({ reasons: [{ ...REASON, origin: { evidence: { ref: "x" } } }] })),
      ).toThrow(/auditBody\.reasons\[\]\.origin is not admitted/);
    });
  });

  describe("refuses a value the admitted type does not allow", () => {
    it("a Date where an instant must already be a string", () => {
      // The chain renders the body; a `Date` would survive `JSON.stringify` as an
      // ISO string and read as admitted, so the refusal has to be here. Asserting
      // the VALUE and not the type is this branch's own lesson: a reading that
      // returned February for a March row passed `toBeInstanceOf(Date)`.
      expect(() => assertAuditBody(plus({ at: new Date("2026-09-21T00:00:00.000Z") }))).toThrow(
        /auditBody\.at must be an ISO instant string/,
      );
    });

    it("an instant SHAPED like one that no calendar has", () => {
      // The shape regex passes `2026-13-45T99:99:99.999Z`; `Date.parse` is what
      // refuses it, and dropping that call SURVIVED because no row planted one.
      for (const bad of ["2026-13-45T00:00:00.000Z", "2026-02-30T25:61:61.000Z"]) {
        expect(() => assertAuditBody(plus({ at: bad })), bad).toThrow(
          /auditBody\.at must be an ISO instant string/,
        );
      }
    });

    it("an instant that is a string but not an instant", () => {
      expect(() => assertAuditBody(plus({ at: "2026-09-21" }))).toThrow(
        /auditBody\.at must be an ISO instant string/,
      );
    });

    it("a non-finite number, by the field that carries it", () => {
      expect(() => assertAuditBody(plus({ amount: Number.NaN }))).toThrow(
        /auditBody\.amount must be a finite number/,
      );
      expect(() =>
        assertAuditBody(plus({ threshold: { base: 600, applied: Number.POSITIVE_INFINITY } })),
      ).toThrow(/auditBody\.threshold\.applied must be a finite number/);
    });

    it("a number where a code belongs", () => {
      expect(() => assertAuditBody(plus({ grade: 3 }))).toThrow(
        /auditBody\.grade must be one of clear, watch, hold/,
      );
    });

    it("a tier outside the vocabulary, because the value is hashed forever (R45)", () => {
      expect(() => assertAuditBody(plus({ riskTier: "mid" }))).toThrow(
        /auditBody\.riskTier must be one of low, medium, high/,
      );
    });

    it("a source code outside the two R47 names", () => {
      expect(() => assertAuditBody(plus({ reasons: [{ ...REASON, source: "SOURCE_MAYBE" }] }))).toThrow(
        /auditBody\.reasons\[\]\.source must be one of SOURCE_PRESENT, SOURCE_UNREADABLE/,
      );
    });

    it("a blank id, which is an id nothing can be traced by", () => {
      expect(() => assertAuditBody(plus({ briefId: "  " }))).toThrow(
        /auditBody\.briefId must not be blank/,
      );
    });

    it("an undefined where a key is required", () => {
      expect(() => assertAuditBody(plus({ unit: undefined }))).toThrow(
        /auditBody\.unit is missing/,
      );
    });

    it("a missing key entirely", () => {
      const { unit: _dropped, ...without } = BODY;
      expect(() => assertAuditBody(without as unknown as BriefAuditBody)).toThrow(
        /auditBody\.unit is missing/,
      );
    });
  });

  describe("is not fooled by what a regex over the rendered JSON would be", () => {
    it("admits a string VALUE that spells out a forbidden key", () => {
      // R48 says this in as many words: a string value containing `":` fools a
      // regex. The walker reads keys, so a unit nobody would trade in is still a
      // unit.
      const odd = '": "payload": "';
      expect(() => assertAuditBody({ ...BODY, unit: odd })).not.toThrow();
    });

    it("refuses a forbidden KEY even when its value is innocuous", () => {
      expect(() => assertAuditBody(plus({ payload: "" }))).toThrow(
        /auditBody\.payload is not admitted/,
      );
    });
  });

  describe("the whitelist itself", () => {
    it("is exactly the set of paths the shipped body produces, with no dead entry", () => {
      // A dead entry in a whitelist is a hole: it admits a path nothing produces,
      // which is a path a later body can start producing unnoticed. Compared both
      // ways round, so neither a missing nor an extra entry survives.
      expect([...auditBodyPaths(BODY)].sort()).toEqual([...ADMITTED_PATHS].sort());
    });

    it("names no key a payload or a source reference would travel under", () => {
      for (const forbidden of ["payload", "source_ref", "sourceRef", "ref", "evidence", "ciphertext"]) {
        expect([...ADMITTED_PATHS].some((p) => p.split(".").includes(forbidden)), forbidden).toBe(
          false,
        );
      }
    });

    it("admits the named numbers a grade cannot be recomputed without (R48)", () => {
      // R25 admits ids, codes, versions and instants, and a grade cannot be
      // explained by those alone. These six are the exception R48 rules, and the
      // list is asserted so narrowing it is a red test rather than a quiet loss of
      // auditability.
      for (const path of [
        "amount",
        "unit",
        "threshold.base",
        "threshold.applied",
        "reasons[].strength",
        "reasons[].relatedness",
      ]) {
        expect(ADMITTED_PATHS.has(path), path).toBe(true);
      }
    });

    it("does NOT admit a refresh count or a channel, which are the output's and not the body's", () => {
      // Both are on the brief the caller receives. Neither is an id, a code, a
      // version, an instant, or one of R48's six numbers, so neither belongs in a
      // row that outlives every key.
      for (const path of ["reasons[].refreshCount", "reasons[].channel", "reasons[].aspect"]) {
        expect(ADMITTED_PATHS.has(path), path).toBe(false);
      }
    });
  });

  describe("auditBodyPaths", () => {
    it("collapses an array index, so two reasons do not produce two paths", () => {
      const two = auditBodyPaths({ ...BODY, reasons: [REASON, { ...REASON, strength: 0.9 }] });
      expect([...two].sort()).toEqual([...auditBodyPaths(BODY)].sort());
    });

    it("walks into an object nested inside an array element", () => {
      const paths = auditBodyPaths(plus({ reasons: [{ ...REASON, origin: { evidence: 1 } }] }));
      expect([...paths]).toContain("reasons[].origin.evidence");
    });

    it("treats a null as a leaf rather than walking into it", () => {
      expect([...auditBodyPaths({ ...BODY, triggerId: null })]).toContain("triggerId");
    });
  });
});
