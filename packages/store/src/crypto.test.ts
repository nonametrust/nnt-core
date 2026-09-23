import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  keyRingFromEnv,
  newDataKey,
  open,
  payloadAad,
  periodKeyAad,
  permanentAad,
  seal,
  type PayloadBinding,
  type PermanentBinding,
  type Sealed,
  unwrapUnder,
  wrapUnder,
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

// The two instants differ, and by more than a rounding. An observation is
// ingested after it is observed, and on a fixture where the two were equal a
// function reading the wrong one would agree with itself and no test would
// see it. M1's acceptance test makes the same point about the two columns.
function binding(over: Partial<PayloadBinding> = {}): PayloadBinding {
  return {
    namespaceId: NS,
    idempotencyKey: "abc123",
    evidenceKind: "event",
    channel: "volume",
    kind: "payment",
    producer: "indexer",
    ingestedAt: new Date("2026-09-12T09:30:00.000Z"),
    datedAt: new Date("2026-09-12T09:00:00.000Z"),
    ...over,
  };
}

const RECORD = "33333333-3333-4333-8333-333333333333";
const OBSERVATION = "44444444-4444-4444-8444-444444444444";

// Promoted eight days after the observation it rescues: a permanent record is
// written when a trigger fires, not when the evidence arrived.
function record(over: Partial<PermanentBinding> = {}): PermanentBinding {
  return {
    recordId: RECORD,
    observationId: OBSERVATION,
    namespaceId: NS,
    originalDatedAt: new Date("2026-09-12T09:00:00.000Z"),
    promotedAt: new Date("2026-09-20T11:00:00.000Z"),
    ...over,
  };
}

describe("wrapping a key under a key", () => {
  // Lifted out of the ring so a month key can be wrapped under a namespace
  // key with the same layout the namespace key already uses under the master.
  // One layout, so `namespace_key_present`'s 29-byte header stays one number
  // rather than becoming two that must be kept equal by hand.
  const outer = randomBytes(32);
  const inner = randomBytes(32);

  it("round-trips a key under another key", () => {
    const wrapped = wrapUnder(outer, inner, "ns:2026-09-01");
    expect(wrapped.length).toBe(29 + 32);
    expect(unwrapUnder(outer, wrapped, "ns:2026-09-01").equals(inner)).toBe(true);
  });

  // The binding is the whole point. Without it, copying one period's wrapped
  // key into another period's row before the first is shredded leaves a live
  // copy that survives the shred -- and shredding is the only erasure this
  // design has, so a shred a row copy can evade is not one.
  it("refuses a wrapped key opened under a different binding, by class", () => {
    const wrapped = wrapUnder(outer, inner, "ns:2026-09-01");
    // CiphertextRejected and not CiphertextMalformed: the bytes are the right
    // shape and the right version, they simply do not authenticate. The two
    // classes say different things to an operator -- a corrupted row against
    // a key or a binding that does not belong to it.
    expect(() => unwrapUnder(outer, wrapped, "ns:2026-10-01")).toThrow(CiphertextRejected);
    expect(() => unwrapUnder(randomBytes(32), wrapped, "ns:2026-09-01")).toThrow(CiphertextRejected);
  });

  it("refuses a wrapped key shorter than its header, and an unknown version", () => {
    const wrapped = wrapUnder(outer, inner, "b");
    expect(() => unwrapUnder(outer, wrapped.subarray(0, 28), "b")).toThrow(CiphertextMalformed);
    const bumped = Buffer.from(wrapped);
    bumped.writeUInt8(99, 0);
    expect(() => unwrapUnder(outer, bumped, "b")).toThrow(CiphertextMalformed);
    expect(() => unwrapUnder(outer, bumped, "b")).toThrow(/version 99/);
  });

  // The ring's own wrap must be these functions and not a second copy of the
  // layout: a copy drifts, and the drift is silent until a key minted by one
  // cannot be opened by the other.
  it("is the same layout the ring wraps a namespace key with", () => {
    const ring = keyRingFromEnv({ NNT_MASTER_KEY: outer.toString("base64") } as NodeJS.ProcessEnv);
    const byRing = ring.wrap(inner, "namespace-id");
    expect(unwrapUnder(outer, byRing, "namespace-id").equals(inner)).toBe(true);
    const byHand = wrapUnder(outer, inner, "namespace-id");
    expect(ring.unwrap(byHand, "namespace-id").equals(inner)).toBe(true);
  });
});

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
      { producer: "tampered" },
      { ingestedAt: new Date("2026-09-12T10:30:00.000Z") },
      // A move across a month boundary is the one the period column is
      // derived from; a move of a single millisecond is the one a check
      // constraint on that column would not see.
      { ingestedAt: new Date("2026-10-12T09:30:00.000Z") },
      { ingestedAt: new Date("2026-09-12T09:30:00.001Z") },
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
  it("cannot be re-partitioned into a different tuple, at every adjacent pair of free parts", () => {
    expect(payloadAad(binding({ namespaceId: "ab", idempotencyKey: "c" }))
      .equals(payloadAad(binding({ namespaceId: "a", idempotencyKey: "bc" })))).toBe(false);
    expect(payloadAad(binding({ channel: "ab", kind: "c" }))
      .equals(payloadAad(binding({ channel: "a", kind: "bc" })))).toBe(false);
    expect(payloadAad(binding({ kind: "ab", producer: "c" }))
      .equals(payloadAad(binding({ kind: "a", producer: "bc" })))).toBe(false);
  });

  // The order of the parts is a rule, and nothing else here holds it: seal and
  // open render the same binding the same way, so any consistent order passes
  // a round trip. Swap two parts and only this test goes red.
  //
  // Last is a convention, not a necessity: with a fixed part count and a
  // separator no part may contain, an empty part is unambiguous anywhere.
  // This pin is what holds the order; nothing deeper does.
  it("renders the eight parts in one fixed order, the two instants last", () => {
    expect(payloadAad(binding()).toString("utf8").split("\u0000")).toEqual([
      NS,
      "abc123",
      "event",
      "volume",
      "payment",
      "indexer",
      "2026-09-12T09:30:00.000Z",
      "2026-09-12T09:00:00.000Z",
    ]);
  });

  // The layout moved: the two columns the store derives and keeps beside the
  // payload, `producer` and `ingested_at`, were outside the envelope and are
  // now inside it. This is what that costs, spelled out rather than asserted
  // in a comment -- the six-part envelope is built here by hand, because the
  // function that used to build it is gone.
  //
  // It cost nothing today because nothing is deployed, and the migration
  // refuses to run over a non-empty observation table for exactly this
  // reason. Over stored rows it would be a re-encryption of every one.
  it("refuses a payload sealed under the six-part layout that preceded the columns beside it", () => {
    const dk = newDataKey();
    const b = binding();
    const sixPart = Buffer.from(
      [b.namespaceId, b.idempotencyKey, b.evidenceKind, b.channel, b.kind,
        b.datedAt!.toISOString()].join("\u0000"),
      "utf8",
    );
    const s = seal(dk, '{"a":1}', sixPart);
    expect(() => open(dk, s, payloadAad(b))).toThrow(CiphertextRejected);
    // And it is the layout that refuses it, not the key or the payload.
    expect(open(dk, s, sixPart)).toBe('{"a":1}');
  });

  // The re-partition property above holds only while no part can contain the
  // separator. The uuid, the hex digest, the evidence kind and the instant
  // cannot; channel and kind are free strings and can. Every part is checked,
  // because this function's signature is strings and it cannot see which.
  it("refuses a part that contains the separator, in every position", () => {
    for (const move of [
      { namespaceId: "a\u0000b" }, { idempotencyKey: "a\u0000b" }, { evidenceKind: "a\u0000b" },
      { channel: "a\u0000b" }, { kind: "a\u0000b" }, { producer: "a\u0000b" },
    ]) {
      expect(() => payloadAad(binding(move)), JSON.stringify(move)).toThrow(RangeError);
    }
  });

  // A lone surrogate is not a character: UTF-8 cannot encode one, so Node
  // encodes it as U+FFFD, and so does Postgres when it stores the column.
  // The payload keeps the original escape inside its JSON while the column
  // holds the replacement, both render to the SAME associated data, and the
  // payload opens -- with a `kind` that disagrees with its own column. That
  // falsifies the sentence the read path states outright, that a column which
  // disagrees with the payload does not open at all.
  //
  // Verified before it was fixed: Buffer.from("\uD800") and
  // Buffer.from("\uFFFD") are both ef bf bd, and the driver round-trips a
  // lone surrogate back as U+FFFD.
  //
  // The separator check is not enough, because the two strings differ without
  // either containing a NUL. What the parts must guarantee is that distinct
  // tuples render to distinct bytes, and only well-formed strings do.
  it("refuses a part that is not well-formed, because two of them can render the same bytes", () => {
    const lone = "a\uD800b";
    const replaced = "a\uFFFDb";
    expect(lone).not.toBe(replaced);
    expect(Buffer.from(lone, "utf8").equals(Buffer.from(replaced, "utf8"))).toBe(true);
    for (const move of [{ channel: lone }, { kind: lone }, { producer: lone }, { namespaceId: lone }]) {
      expect(() => payloadAad(binding(move)), JSON.stringify(move)).toThrow(RangeError);
    }
    expect(() => permanentAad(record({ recordId: lone }))).toThrow(RangeError);
    // The well-formed twin is still accepted: what is refused is the
    // ill-formed string, not the character it would have collapsed to.
    expect(() => payloadAad(binding({ kind: replaced }))).not.toThrow();
    // And a VALID surrogate pair is accepted, which is the other direction of
    // the same rule and the one a careless check gets wrong: an astral
    // character is stored as two surrogate code units, so a pattern without
    // the unicode flag sees them individually and refuses legitimate text.
    // Under `u` a valid pair is one non-surrogate code point and does not
    // match at all. Nothing caught this until the flag was mutated away.
    for (const good of ["a\u{1F600}b", "\u{1F600}", "ödeme-çğş", "日本語"]) {
      expect(() => payloadAad(binding({ kind: good })), good).not.toThrow();
      expect(payloadAad(binding({ kind: good })).toString("utf8").split("\u0000")[4]).toBe(good);
    }
  });

  // An Invalid Date reaches toISOString and throws the runtime's own
  // RangeError, which names no field. periodOf already refuses one by name;
  // this is the same instant arriving one function later.
  it("refuses an invalid instant by name, rather than by the runtime's own error", () => {
    expect(() => payloadAad(binding({ ingestedAt: new Date(Number.NaN) })))
      .toThrow(/ingestedAt/);
    expect(() => payloadAad(binding({ datedAt: new Date(Number.NaN) })))
      .toThrow(/datedAt/);
    expect(() => permanentAad(record({ promotedAt: new Date(Number.NaN) })))
      .toThrow(/promotedAt/);
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

describe("permanentAad", () => {
  // A permanent record is sealed under the SAME namespace data key as the
  // observation it rescues, so the two envelopes share a key and must not
  // share a domain. Without separation, a permanent record's ciphertext and
  // an observation's could be swapped for each other.
  it("cannot equal a payload envelope, whatever a caller passes", () => {
    // The adversarial case for the stated reason. The domain literal is first
    // "because no uuid can equal it" -- but this function does not check that
    // its namespace is a uuid, so a caller that passes the literal itself is
    // the case that reason does not cover.
    const impostor = payloadAad(binding({ namespaceId: "permanent" }));
    expect(impostor.equals(permanentAad(record()))).toBe(false);
    // What actually holds it: the two carry a different number of parts, and
    // no part may contain the separator, so one join has five separators and
    // the other seven. They cannot be equal for any inputs at all.
    expect(permanentAad(record()).toString("utf8").split("\u0000").length).toBe(6);
    expect(impostor.toString("utf8").split("\u0000").length).toBe(8);
  });

  it("renders the six parts in one fixed order, the domain literal first", () => {
    expect(permanentAad(record()).toString("utf8").split("\u0000")).toEqual([
      "permanent",
      RECORD,
      OBSERVATION,
      NS,
      "2026-09-12T09:00:00.000Z",
      "2026-09-20T11:00:00.000Z",
    ]);
  });

  // Every column the record keeps beside its payload is inside the envelope,
  // for the reason the payload's own binding gives: under the write access
  // that moves a row, a column can be rewritten while the payload still
  // opens. `original_dated_at` is the one the promotion trigger measures the
  // record against, and it is not nullable -- a state has no instant to
  // preserve and `promote` refuses one before it reaches here.
  it("refuses a permanent payload whose bound columns were rewritten, one at a time", () => {
    const dk = newDataKey();
    const s = seal(dk, '{"a":1}', permanentAad(record()));
    const moves: Partial<PermanentBinding>[] = [
      { recordId: OTHER_NS },
      { observationId: OTHER_NS },
      { namespaceId: OTHER_NS },
      { originalDatedAt: new Date("2026-09-12T09:00:00.001Z") },
      { promotedAt: new Date("2026-09-20T11:00:00.001Z") },
    ];
    for (const move of moves) {
      expect(() => open(dk, s, permanentAad(record(move))), JSON.stringify(move))
        .toThrow(CiphertextRejected);
    }
    expect(open(dk, s, permanentAad(record()))).toBe('{"a":1}');
  });

  // The three uuids cannot carry a separator and the two instants cannot
  // either, so this guards a caller this package has not met yet -- the same
  // reason the payload binding checks every part rather than the two it knows
  // to be free.
  it("refuses a part that contains the separator, in every position", () => {
    for (const move of [
      { recordId: "a\u0000b" }, { observationId: "a\u0000b" }, { namespaceId: "a\u0000b" },
    ]) {
      expect(() => permanentAad(record(move)), JSON.stringify(move)).toThrow(RangeError);
    }
  });
});

describe("periodKeyAad", () => {
  // The claim this function makes is that it inherits the envelope's refusals
  // rather than restating them -- and that claim was untested: hand-
  // concatenating the two parts passed every other test, because both callers
  // build the binding the same way and a consistent mistake round-trips.
  it("inherits the separator and well-formedness refusals from the join", () => {
    expect(() => periodKeyAad("a\u0000b", "2026-09-01")).toThrow(RangeError);
    expect(() => periodKeyAad(NS, "2026-09\u000001")).toThrow(RangeError);
    expect(() => periodKeyAad("a\uD800b", "2026-09-01")).toThrow(RangeError);
  });

  // Two distinct pairs cannot render the same binding, which is what stops a
  // wrapped month key being useful in another row.
  it("cannot be re-partitioned into a different pair", () => {
    expect(periodKeyAad("ab", "c")).not.toEqual(periodKeyAad("a", "bc"));
    expect(periodKeyAad(NS, "2026-09-01")).not.toEqual(periodKeyAad(NS, "2026-10-01"));
    expect(periodKeyAad(NS, "2026-09-01")).not.toEqual(periodKeyAad(OTHER_NS, "2026-09-01"));
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
