import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  keyRingFromEnv, newDataKey, seal, open, payloadAad, type PayloadBinding, type Sealed,
} from "./crypto.js";
import { CiphertextMalformed, CiphertextRejected, StoreError } from "./errors.js";

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

function binding(over: Partial<PayloadBinding> = {}): PayloadBinding {
  return {
    namespaceId: NS,
    idempotencyKey: "abc123",
    evidenceKind: "event",
    channel: "volume",
    kind: "payment",
    datedAt: new Date("2026-09-12T09:00:00.000Z"),
    ...over,
  };
}

describe("keyRingFromEnv", () => {
  it("refuses to start without a master key, with no default and no fallback", () => {
    expect(() => keyRingFromEnv({} as NodeJS.ProcessEnv)).toThrow(RangeError);
  });

  it("refuses a master key that is not thirty-two bytes", () => {
    expect(() =>
      keyRingFromEnv({ NNT_MASTER_KEY: randomBytes(16).toString("base64") } as NodeJS.ProcessEnv),
    ).toThrow(RangeError);
  });

  // The decoder drops a character it does not recognise, so this key still
  // decodes to thirty-two bytes. It is a different key from the one that was
  // meant, and the only place that can be noticed is here.
  it("refuses a master key that is not canonical base64, even when it decodes to thirty-two bytes", () => {
    const typo = MASTER.slice(0, 10) + "*" + MASTER.slice(10);
    expect(Buffer.from(typo, "base64").length).toBe(32);
    expect(() => keyRingFromEnv({ NNT_MASTER_KEY: typo } as NodeJS.ProcessEnv)).toThrow(RangeError);
  });

  it("round-trips a data key", () => {
    const dk = newDataKey();
    expect(ring.unwrap(ring.wrap(dk, NS), NS).equals(dk)).toBe(true);
  });

  it("versions the wrapped key, so rotation is a decode branch and not a migration", () => {
    expect(ring.wrap(newDataKey(), NS)[0]).toBe(1);
  });

  // A version this code cannot read is a layout it does not know, not a
  // refusal by the cipher: the class says which, so that a rotation that
  // wrote version 2 is told apart from a tamper.
  it("refuses a wrapped key with an unknown version byte, as malformed", () => {
    const w = ring.wrap(newDataKey(), NS);
    w[0] = 9;
    expect(() => ring.unwrap(w, NS)).toThrow(CiphertextMalformed);
  });

  it("refuses a wrapped key that was tampered with, by class", () => {
    const w = ring.wrap(newDataKey(), NS);
    flipByte(w, w.length - 1);
    expect(() => ring.unwrap(w, NS)).toThrow(CiphertextRejected);
    expect(() => ring.unwrap(w, NS)).toThrow(StoreError);
  });

  // This is what stops a shred from being evaded. Copy namespace A's wrapped
  // key into B's row before A is shredded and, without this binding, a live
  // copy of A's data key survives the shred while A's payload rows stay in
  // place by design.
  it("refuses a key wrapped for one namespace when unwrapped under another", () => {
    const w = ring.wrap(newDataKey(), NS);
    expect(() => ring.unwrap(w, OTHER_NS)).toThrow(CiphertextRejected);
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
    expect(() => ring.unwrap(rebuilt, NS)).toThrow(CiphertextRejected);
  });

  // `unwrap` has a header length guard and its comment says the tag covers
  // the rest. This pins that at every truncation point, and pins which class
  // says so: a cut inside the header is malformed and refused before any
  // cipher is built, a cut inside the body changes what the tag covers and
  // is refused by the cipher.
  it("refuses a wrapped key truncated at any length, and names the header cuts as malformed", () => {
    const w = ring.wrap(newDataKey(), NS);
    for (let len = 0; len < w.length; len++) {
      const expected = len < WRAP_BODY_START ? CiphertextMalformed : CiphertextRejected;
      expect(() => ring.unwrap(w.subarray(0, len), NS), `truncated to ${len} bytes`).toThrow(expected);
    }
  });

  it("names an empty wrapped key as malformed, not as an undefined version", () => {
    expect(() => ring.unwrap(Buffer.alloc(0), NS)).toThrow(CiphertextMalformed);
  });
});

describe("seal and open", () => {
  const dk = newDataKey();
  const aad = payloadAad(binding());

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
  it("refuses a ciphertext moved to another row, by class", () => {
    const s = seal(dk, '{"a":1}', aad);
    const other = payloadAad(binding({ namespaceId: OTHER_NS }));
    expect(() => open(dk, s, other)).toThrow(CiphertextRejected);
    expect(() => open(dk, s, other)).toThrow(StoreError);
  });

  it("refuses a ciphertext moved to another idempotency key", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(() => open(dk, s, payloadAad(binding({ idempotencyKey: "different" })))).toThrow(CiphertextRejected);
  });

  // The columns the store keeps beside the payload are inside the envelope
  // too. Under the same write access that moves a row, any one of them can
  // be rewritten while the payload still opens; bound here, the rewritten
  // column is the refusal. The dated column is the one the promotion
  // trigger measures a permanent record against.
  it("refuses a ciphertext whose bound columns were rewritten, one column at a time", () => {
    const s = seal(dk, '{"a":1}', aad);
    const moves: Partial<PayloadBinding>[] = [
      { evidenceKind: "state", datedAt: null },
      { channel: "latency" },
      { kind: "tampered" },
      { datedAt: new Date("2026-09-13T09:00:00.000Z") },
      { datedAt: new Date("2026-09-12T09:00:00.001Z") },
      { datedAt: null },
    ];
    for (const move of moves) {
      expect(() => open(dk, s, payloadAad(binding(move))), JSON.stringify(move)).toThrow(CiphertextRejected);
    }
    expect(open(dk, s, payloadAad(binding()))).toBe('{"a":1}');
  });

  it("refuses a ciphertext under the wrong data key, which is what shredding leaves behind", () => {
    const s = seal(dk, '{"a":1}', aad);
    expect(() => open(newDataKey(), s, aad)).toThrow(CiphertextRejected);
  });

  it("refuses a flipped bit in the ciphertext", () => {
    const s = seal(dk, '{"a":1}', aad);
    flipByte(s.ciphertext, 0);
    expect(() => open(dk, s, aad)).toThrow(CiphertextRejected);
  });

  it("refuses a flipped bit in the tag", () => {
    const s = seal(dk, '{"a":1}', aad);
    flipByte(s.tag, 0);
    expect(() => open(dk, s, aad)).toThrow(CiphertextRejected);
  });

  it("refuses a flipped bit in the nonce", () => {
    const s = seal(dk, '{"a":1}', aad);
    flipByte(s.nonce, 0);
    expect(() => open(dk, s, aad)).toThrow(CiphertextRejected);
  });

  // A GCM tag truncated to twelve bytes is the valid twelve-byte tag for the
  // same message, and a decipher with no pinned tag length accepts it. The
  // same holds down to four bytes, where forgery costs one in four billion.
  // The stored tag is the attacker's to shorten, so the length is pinned on
  // our side, and a short tag is refused as a malformed column before any
  // cipher is built. Asserting the class is what found that the cipher's
  // own refusal of a short tag was a TypeError this package did not own.
  it("refuses a tag cut to twelve bytes, which is otherwise a valid shorter tag, as malformed", () => {
    const s = seal(dk, '{"a":1}', aad);
    for (const len of [12, 4]) {
      const cut: Sealed = { ...s, tag: s.tag.subarray(0, len) };
      expect(() => open(dk, cut, aad), `tag cut to ${len} bytes`).toThrow(CiphertextMalformed);
    }
  });

  it("refuses a nonce of the wrong length as malformed, before any cipher is built", () => {
    const s = seal(dk, '{"a":1}', aad);
    const cut: Sealed = { ...s, nonce: s.nonce.subarray(0, 8) };
    expect(() => open(dk, cut, aad)).toThrow(CiphertextMalformed);
  });
});

describe("payloadAad", () => {
  it("cannot be re-partitioned into a different tuple, at either adjacent pair of free parts", () => {
    expect(payloadAad(binding({ namespaceId: "ab", idempotencyKey: "c" }))
      .equals(payloadAad(binding({ namespaceId: "a", idempotencyKey: "bc" })))).toBe(false);
    expect(payloadAad(binding({ channel: "ab", kind: "c" }))
      .equals(payloadAad(binding({ channel: "a", kind: "bc" })))).toBe(false);
  });

  // The re-partition property above holds only while no part can contain the
  // separator. The uuid, the hex digest, the evidence kind and the instant
  // cannot; channel and kind are free strings and can. Every part is checked,
  // because this function's signature is strings and it cannot see which.
  it("refuses a part that contains the separator, in every position", () => {
    for (const move of [
      { namespaceId: "a\u0000b" }, { idempotencyKey: "a\u0000b" }, { evidenceKind: "a\u0000b" },
      { channel: "a\u0000b" }, { kind: "a\u0000b" },
    ]) {
      expect(() => payloadAad(binding(move)), JSON.stringify(move)).toThrow(RangeError);
    }
  });

  // A state has no instant and its column is null. The rendering is fixed,
  // so a state sealed today opens in a year, and it is distinct from every
  // instant, so an undated row cannot be given a date after the fact.
  it("renders a null instant one fixed way, distinct from every instant", () => {
    const undated = payloadAad(binding({ evidenceKind: "state", datedAt: null }));
    expect(undated.equals(payloadAad(binding({ evidenceKind: "state", datedAt: null })))).toBe(true);
    expect(undated.equals(payloadAad(binding({ evidenceKind: "state", datedAt: new Date(0) })))).toBe(false);
    expect(undated.subarray(-1)[0]).toBe(0);
  });

  it("renders the instant as the Date the column holds, so both sides agree whatever the wire spelling", () => {
    const a = payloadAad(binding({ datedAt: new Date("2026-09-12T09:00:00Z") }));
    const b = payloadAad(binding({ datedAt: new Date("2026-09-12T09:00:00.000Z") }));
    expect(a.equals(b)).toBe(true);
  });
});

describe("deriveKey", () => {
  const LABEL = "nnt/test-purpose/v1";

  it("derives the same thirty-two bytes for the same label on every call, so a seal made today checks in a year", () => {
    const a = ring.deriveKey(LABEL);
    expect(a.length).toBe(32);
    expect(ring.deriveKey(LABEL).equals(a)).toBe(true);
    expect(keyRingFromEnv({ NNT_MASTER_KEY: MASTER } as NodeJS.ProcessEnv).deriveKey(LABEL).equals(a)).toBe(true);
  });

  it("derives a different key under a different label, and neither is the master", () => {
    const a = ring.deriveKey(LABEL);
    const b = ring.deriveKey("nnt/other-purpose/v1");
    expect(a.equals(b)).toBe(false);
    expect(a.equals(Buffer.from(MASTER, "base64"))).toBe(false);
    expect(b.equals(Buffer.from(MASTER, "base64"))).toBe(false);
  });

  it("derives a different key under a different master", () => {
    const other = keyRingFromEnv({ NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv);
    expect(other.deriveKey(LABEL).equals(ring.deriveKey(LABEL))).toBe(false);
  });

  it("refuses the empty label", () => {
    expect(() => ring.deriveKey("")).toThrow(RangeError);
  });
});
