import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { keyRingFromEnv, newDataKey, seal, open, payloadAad, type Sealed } from "./crypto.js";

const MASTER = randomBytes(32).toString("base64");
const ring = keyRingFromEnv({ NNT_MASTER_KEY: MASTER } as NodeJS.ProcessEnv);

const NS = "11111111-1111-4111-8111-111111111111";
const OTHER_NS = "22222222-2222-4222-8222-222222222222";

// Layout of a version-1 wrapped key: version(1) | nonce(12) | tag(16) | body.
const WRAP_NONCE_START = 1;
const WRAP_TAG_START = WRAP_NONCE_START + 12;
const WRAP_BODY_START = WRAP_TAG_START + 16;

function flipByte(buf: Buffer, i: number): void {
  buf[i] = buf.readUInt8(i) ^ 0xff;
}

describe("keyRingFromEnv", () => {
  it("refuses to start without a master key, with no default and no fallback", () => {
    expect(() => keyRingFromEnv({} as NodeJS.ProcessEnv)).toThrow(/NNT_MASTER_KEY/);
  });

  it("refuses a master key that is not thirty-two bytes", () => {
    expect(() =>
      keyRingFromEnv({ NNT_MASTER_KEY: randomBytes(16).toString("base64") } as NodeJS.ProcessEnv),
    ).toThrow(/32/);
  });

  // The decoder drops a character it does not recognise, so this key still
  // decodes to thirty-two bytes. It is a different key from the one that was
  // meant, and the only place that can be noticed is here.
  it("refuses a master key that is not canonical base64, even when it decodes to thirty-two bytes", () => {
    const typo = MASTER.slice(0, 10) + "*" + MASTER.slice(10);
    expect(Buffer.from(typo, "base64").length).toBe(32);
    expect(() => keyRingFromEnv({ NNT_MASTER_KEY: typo } as NodeJS.ProcessEnv)).toThrow(/base64/);
  });

  it("round-trips a data key", () => {
    const dk = newDataKey();
    expect(ring.unwrap(ring.wrap(dk, NS), NS).equals(dk)).toBe(true);
  });

  it("versions the wrapped key, so rotation is a decode branch and not a migration", () => {
    expect(ring.wrap(newDataKey(), NS)[0]).toBe(1);
  });

  it("refuses a wrapped key with an unknown version byte", () => {
    const w = ring.wrap(newDataKey(), NS);
    w[0] = 9;
    expect(() => ring.unwrap(w, NS)).toThrow(/version/);
  });

  it("refuses a wrapped key that was tampered with", () => {
    const w = ring.wrap(newDataKey(), NS);
    flipByte(w, w.length - 1);
    expect(() => ring.unwrap(w, NS)).toThrow();
  });

  // This is what stops a shred from being evaded. Copy namespace A's wrapped
  // key into B's row before A is shredded and, without this binding, a live
  // copy of A's data key survives the shred while A's payload rows stay in
  // place by design.
  it("refuses a key wrapped for one namespace when unwrapped under another", () => {
    const w = ring.wrap(newDataKey(), NS);
    expect(() => ring.unwrap(w, OTHER_NS)).toThrow();
  });

  // The layout pins the tag at sixteen bytes structurally, so a shortened tag
  // shifts body bytes into the tag slot. This rebuilds a wrapped key with a
  // four-byte tag in the position a truncating attacker would write it.
  it("refuses a wrapped key whose tag was cut to four bytes", () => {
    const w = ring.wrap(newDataKey(), NS);
    const shortTag = w.subarray(WRAP_TAG_START, WRAP_TAG_START + 4);
    const rebuilt = Buffer.concat([
      w.subarray(0, WRAP_TAG_START),
      shortTag,
      w.subarray(WRAP_BODY_START),
    ]);
    expect(() => ring.unwrap(rebuilt, NS)).toThrow();
  });

  // `unwrap` has a header length guard and its comment says the tag covers
  // the rest. This pins that at every truncation point: a cut inside the body
  // changes what the tag covers, and a cut inside the header is refused
  // before any cipher is built.
  it("refuses a wrapped key truncated at any length", () => {
    const w = ring.wrap(newDataKey(), NS);
    for (let len = 0; len < w.length; len++) {
      expect(() => ring.unwrap(w.subarray(0, len), NS), `truncated to ${len} bytes`).toThrow();
    }
  });

  it("names an empty wrapped key as too short, not as an undefined version", () => {
    expect(() => ring.unwrap(Buffer.alloc(0), NS)).toThrow(/shorter than/);
  });
});

describe("seal and open", () => {
  const dk = newDataKey();
  const aad = payloadAad(NS, "abc123");

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
    const other = payloadAad(OTHER_NS, "abc123");
    expect(() => open(dk, s, other)).toThrow();
  });

  it("refuses a ciphertext moved to another idempotency key", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(() => open(dk, s, payloadAad(NS, "different"))).toThrow();
  });

  it("refuses a ciphertext under the wrong data key, which is what shredding leaves behind", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(() => open(newDataKey(), s, aad)).toThrow();
  });

  it("refuses a flipped bit in the ciphertext", () => {
    const s = seal(dk, '{"a":1}', aad);
    flipByte(s.ciphertext, 0);
    expect(() => open(dk, s, aad)).toThrow();
  });

  it("refuses a flipped bit in the tag", () => {
    const s = seal(dk, '{"a":1}', aad);
    flipByte(s.tag, 0);
    expect(() => open(dk, s, aad)).toThrow();
  });

  it("refuses a flipped bit in the nonce", () => {
    const s = seal(dk, '{"a":1}', aad);
    flipByte(s.nonce, 0);
    expect(() => open(dk, s, aad)).toThrow();
  });

  // A GCM tag truncated to twelve bytes is the valid twelve-byte tag for the
  // same message, and a decipher with no pinned tag length accepts it. The
  // same holds down to four bytes, where forgery costs one in four billion.
  // The stored tag is the attacker's to shorten, so the length is pinned on
  // our side.
  it("refuses a tag cut to twelve bytes, which is otherwise a valid shorter tag", () => {
    const s = seal(dk, '{"a":1}', aad);
    const cut: Sealed = { ...s, tag: s.tag.subarray(0, 12) };
    expect(() => open(dk, cut, aad)).toThrow();
  });

  it("refuses a nonce of the wrong length with an error this store owns", () => {
    const s = seal(dk, '{"a":1}', aad);
    const cut: Sealed = { ...s, nonce: s.nonce.subarray(0, 8) };
    expect(() => open(dk, cut, aad)).toThrow(/nonce/);
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
