import { describe, it, expect } from "vitest";
import {
  AppendOnlyViolation,
  ChainBroken,
  ConstraintViolation,
  NamespaceAltered,
  StoreError,
  TagAltered,
  TimestampAltered,
  mapPgError,
} from "./errors.js";

// The shape pg gives a server error: a code, a message, and the fields a
// trigger's RAISE fills that a caller needs when debugging. A constraint
// violation carries the constraint's name beside them.
function pgError(code: string, constraint?: string): Error & { code: string; detail: string; hint: string } {
  return Object.assign(new Error(`message for ${code}`), {
    code,
    detail: `detail for ${code}`,
    hint: `hint for ${code}`,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

describe("mapPgError", () => {
  it.each([
    ["NNT01", AppendOnlyViolation],
    ["NNT02", ChainBroken],
    ["NNT03", ChainBroken],
    ["NNT04", TimestampAltered],
    ["NNT05", NamespaceAltered],
    ["NNT07", TagAltered],
  ])("maps %s to the named class", (code, Ctor) => {
    const mapped = mapPgError(pgError(code));
    expect(mapped).toBeInstanceOf(Ctor);
    expect(mapped).toBeInstanceOf(StoreError);
    expect(mapped?.message).toBe(`message for ${code}`);
  });

  it("keeps the original as cause, so detail, hint and the driver stack survive", () => {
    const original = pgError("NNT02");
    const mapped = mapPgError(original);
    expect(mapped?.cause).toBe(original);
    expect((mapped?.cause as { detail?: string }).detail).toBe("detail for NNT02");
  });

  // The constraints Postgres names for itself. One class for the three
  // codes, because what tells them apart is the constraint's name, and that
  // is a field, so a caller asserts on the class and reads the name rather
  // than comparing the code.
  it.each(["23503", "23505", "23514"])(
    "maps %s to ConstraintViolation, carrying the SQLSTATE and the constraint's name",
    (code) => {
      const original = pgError(code, "some_constraint");
      const mapped = mapPgError(original);
      expect(mapped).toBeInstanceOf(ConstraintViolation);
      expect(mapped).toBeInstanceOf(StoreError);
      expect(mapped).toMatchObject({ sqlstate: code, constraint: "some_constraint" });
      expect(mapped?.message).toBe(`message for ${code}`);
      expect(mapped?.cause).toBe(original);
    },
  );

  it("carries a null constraint name when the driver names none", () => {
    expect(mapPgError(pgError("23514"))).toMatchObject({ sqlstate: "23514", constraint: null });
  });

  it("returns null for a SQLSTATE this package did not design", () => {
    expect(mapPgError(pgError("42P01"))).toBeNull();
    expect(mapPgError(pgError("22012"))).toBeNull();
    expect(mapPgError(pgError("23502"))).toBeNull();
  });

  it("returns null for anything that is not an error with a string code", () => {
    expect(mapPgError(null)).toBeNull();
    expect(mapPgError(undefined)).toBeNull();
    expect(mapPgError("NNT01")).toBeNull();
    expect(mapPgError({ code: 1 })).toBeNull();
    expect(mapPgError(new Error("no code"))).toBeNull();
  });

  it("falls back to the code as message when the error carries none", () => {
    expect(mapPgError({ code: "NNT04" })?.message).toBe("NNT04");
  });
});
