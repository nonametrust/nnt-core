import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { keyRingFromEnv, newDataKey, seal, open, payloadAad } from "./crypto.js";

const MASTER = randomBytes(32).toString("base64");
const ring = keyRingFromEnv({ NNT_MASTER_KEY: MASTER } as NodeJS.ProcessEnv);

describe("keyRingFromEnv", () => {
  it("refuses to start without a master key, with no default and no fallback", () => {
    expect(() => keyRingFromEnv({} as NodeJS.ProcessEnv)).toThrow(/NNT_MASTER_KEY/);
  });

  it("refuses a master key that is not thirty-two bytes", () => {
    expect(() =>
      keyRingFromEnv({ NNT_MASTER_KEY: randomBytes(16).toString("base64") } as NodeJS.ProcessEnv),
    ).toThrow(/32/);
  });

  it("round-trips a data key", () => {
    const dk = newDataKey();
    expect(ring.unwrap(ring.wrap(dk)).equals(dk)).toBe(true);
  });

  it("versions the wrapped key, so rotation is a decode branch and not a migration", () => {
    expect(ring.wrap(newDataKey())[0]).toBe(1);
  });

  it("refuses a wrapped key with an unknown version byte", () => {
    const w = ring.wrap(newDataKey());
    w[0] = 9;
    expect(() => ring.unwrap(w)).toThrow(/version/);
  });

  it("refuses a wrapped key that was tampered with", () => {
    const w = ring.wrap(newDataKey());
    w[w.length - 1] = w.readUInt8(w.length - 1) ^ 0xff;
    expect(() => ring.unwrap(w)).toThrow();
  });

  // `unwrap` carries no length check and its comment says the tag makes one
  // unnecessary. This pins that claim at every truncation point: a cut inside
  // the body changes what the tag covers, a cut inside the tag or nonce changes
  // what is checked against, and a cut before them leaves no version byte.
  it("refuses a wrapped key truncated at any length", () => {
    const w = ring.wrap(newDataKey());
    for (let len = 0; len < w.length; len++) {
      expect(() => ring.unwrap(w.subarray(0, len)), `truncated to ${len} bytes`).toThrow();
    }
  });
});

describe("seal and open", () => {
  const dk = newDataKey();
  const aad = payloadAad("11111111-1111-4111-8111-111111111111", "abc123");

  it("round-trips a payload", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(open(dk, s, aad)).toBe('{"a":1}');
  });

  it("produces a different nonce every time, so two identical payloads differ on disk", () => {
    const a = seal(dk, "same", aad);
    const b = seal(dk, "same", aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  // This is the property the associated data exists for. Without it, an
  // attacker with write access could swap two counterparties' evidence
  // without breaking anything we hold.
  it("refuses a ciphertext moved to another row", () => {
    const s = seal(dk, '{"a":1}', aad);
    const other = payloadAad("22222222-2222-4222-8222-222222222222", "abc123");
    expect(() => open(dk, s, other)).toThrow();
  });

  it("refuses a ciphertext moved to another idempotency key", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(() =>
      open(dk, s, payloadAad("11111111-1111-4111-8111-111111111111", "different")),
    ).toThrow();
  });

  it("refuses a ciphertext under the wrong data key, which is what shredding leaves behind", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(() => open(newDataKey(), s, aad)).toThrow();
  });

  it("refuses a flipped bit in the ciphertext", () => {
    const s = seal(dk, '{"a":1}', aad);
    s.ciphertext[0] = s.ciphertext.readUInt8(0) ^ 0xff;
    expect(() => open(dk, s, aad)).toThrow();
  });
});

describe("payloadAad", () => {
  it("cannot be re-partitioned into a different pair", () => {
    expect(payloadAad("ab", "c").equals(payloadAad("a", "bc"))).toBe(false);
  });

  // The re-partition property above holds only while no part can contain the
  // separator. Today's callers pass a uuid and a hex digest, which cannot, but
  // this function's signature is two strings and it cannot see that. The
  // schema's idempotency key refuses the same byte for the same reason.
  it("refuses a part that contains the separator, in either position", () => {
    expect(() => payloadAad("a\u0000b", "c")).toThrow(/separator/);
    expect(() => payloadAad("a", "b\u0000c")).toThrow(/separator/);
  });
});
