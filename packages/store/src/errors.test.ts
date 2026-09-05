import { describe, it, expect } from "vitest";
import {
  AppendOnlyViolation,
  ChainBroken,
  StoreError,
  TimestampAltered,
  mapPgError,
} from "./errors.js";

// The shape pg gives a server error: a code, a message, and the fields a
// trigger's RAISE fills that a caller needs when debugging.
function pgError(code: string): Error & { code: string; detail: string; hint: string } {
  return Object.assign(new Error(`message for ${code}`), {
    code,
    detail: `detail for ${code}`,
    hint: `hint for ${code}`,
  });
}

describe("mapPgError", () => {
  it.each([
    ["NNT01", AppendOnlyViolation],
    ["NNT02", ChainBroken],
    ["NNT03", ChainBroken],
    ["NNT04", TimestampAltered],
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

  it("returns null for a SQLSTATE this package did not design", () => {
    expect(mapPgError(pgError("23505"))).toBeNull();
    expect(mapPgError(pgError("42P01"))).toBeNull();
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
