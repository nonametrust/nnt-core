import {
  createCipheriv, createDecipheriv, hkdfSync, randomBytes, type DecipherGCM,
} from "node:crypto";
import { CiphertextMalformed, CiphertextRejected } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;

// The nonce is drawn at random for every call. Random 96-bit nonces bound how
// many times one key may be used: past roughly 2^32 invocations the chance of
// a repeat, which is fatal for GCM, stops being negligible. The data key is
// per namespace and the master key wraps once per namespace, so neither bound
// is near in M1, but rotation is what enforces the bound, and this constant is
// why rotation is a requirement rather than a nicety.
const NONCE_BYTES = 12;

// Pinned on every cipher and decipher through `authTagLength`. Left unpinned,
// a decipher accepts a tag shorter than the one that was produced, and checks
// it at the shorter length it claims. A stored tag cut to four bytes is then a
// forgery at one in four billion per attempt, and each success leaks the
// GHASH subkey, so the first forgery buys the rest.
const TAG_BYTES = 16;

const WRAP_VERSION = 1;
const WRAP_HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

// The associated data joins its parts the same way the idempotency key in
// @nonametrust/schema joins its parts, on a NUL, and refuses a NUL inside any
// part, for the reason the schema states: without a separator that cannot
// occur inside a field, two adjacent parts can be re-partitioned into a
// different tuple with the same concatenation, and the ciphertext would open
// under a row it was not sealed for. Five of the eight parts cannot carry a
// NUL by construction, a uuid, a hex digest, one of two fixed words and two
// ISO instants; channel, kind and producer are free strings and can, and the
// refusal is what makes the property hold for them, and for a caller this
// package has not met yet. The producer's own schema refuses far more than a
// NUL, but this function is handed a string and cannot see which schema it
// came from.
//
// The byte layout of the associated data is frozen once a payload is stored.
// Changing it makes every existing ciphertext fail to open. It has been
// changed twice, both times before anything was deployed: once to take in the
// columns the store derives beside the payload, and once more to take in the
// last two of them, `producer` and `ingested_at`. That cost nothing both
// times and would be a re-encryption of every row now, which is why the
// migration that adds those columns refuses to run over a non-empty table
// rather than leaving the cost to be discovered at the first read.
const SEPARATOR = "\u0000";

// The rendering of a row that carries no instant. A state has none, and the
// column is null for it. The empty part is chosen because no instant renders
// to it, so a null is distinct from every instant, and the part count is
// fixed, so an empty part is distinct from a missing one wherever it sits.
//
// Position does nothing here, and an earlier comment claimed it did: joining
// on a separator no part may contain makes "a", "" and "b" recoverable from
// their join in any order. Last is a convention, held by the order pin in
// the test and by nothing deeper -- which is worth saying plainly, because
// the same slogan-shaped reasoning was retired from permanentAad.
const UNDATED = "";

export interface Sealed {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface KeyRing {
  wrap(dataKey: Buffer, namespaceId: string): Buffer;
  unwrap(wrapped: Buffer, namespaceId: string): Buffer;
  /**
   * A 32-byte key derived from the master key under `label`, by HKDF-SHA256
   * with the label as its info. The master key itself never leaves the ring:
   * the audit day seal needs an HMAC key, and using the master directly would
   * make a seal and a wrapped data key two uses of one key, which is the
   * confusion a fixed, documented label per purpose exists to rule out. The
   * same label yields the same key on every call, so a seal made today can be
   * checked in a year.
   */
  deriveKey(label: string): Buffer;
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * What a payload is bound to: the row it belongs to, and the columns the
 * store derived from it and keeps beside it. The namespace and the key put
 * the ciphertext on one row; without them an attacker with write access to
 * the table could swap two counterparties' evidence without breaking any
 * signature we hold. The other six are the same threat carried one step
 * further. Under that model the append-only trigger is already assumed
 * bypassed, since a swap needs an UPDATE too, and so a derived column can be
 * moved while the payload still opens: the promotion trigger measures a
 * record against the dated column, not against the evidence, and a moved
 * column would put the row's instant into a permanent record with nothing
 * in the store able to tell. Bound here, a rewritten column fails to open,
 * which is the refusal a moved row already gets.
 *
 * `datedAt` and `ingestedAt` are the Dates the columns hold, on both sides:
 * the writer passes the Date it is about to store and the reader passes the
 * Date it read back, and both render it the one way `toISOString` does. The
 * wire string is not used, because the schema admits more than one spelling
 * of an instant and the column keeps only what a Date keeps.
 *
 * The two instants are not interchangeable and neither may be derived from
 * the other: `datedAt` is when the evidence happened and is null for a state,
 * `ingestedAt` is when this store wrote it and is never null. `ingestedAt` is
 * also what the retention period is computed from, so a rewrite of it would
 * move a row into another month's key without moving its ciphertext; bound
 * here, that rewrite is a refusal rather than a silent re-filing.
 */
export interface PayloadBinding {
  namespaceId: string;
  idempotencyKey: string;
  evidenceKind: string;
  channel: string;
  kind: string;
  producer: string;
  ingestedAt: Date;
  datedAt: Date | null;
}

/**
 * The order of the parts is fixed and is a rule in its own right. Nothing
 * else holds it: seal and open render the same binding the same way, so any
 * consistent order round-trips, and a swap would be invisible everywhere but
 * in the test that pins this list.
 *
 * `datedAt` is last by convention rather than by necessity. With a fixed part
 * count and a separator no part may contain, an empty part is unambiguous in
 * any position; the order is held by the pin in the test, which is the honest
 * statement of it.
 */
export function payloadAad(b: PayloadBinding): Buffer {
  return joinParts([
    b.namespaceId,
    b.idempotencyKey,
    b.evidenceKind,
    b.channel,
    b.kind,
    b.producer,
    instantPart("ingestedAt", b.ingestedAt),
    b.datedAt === null ? UNDATED : instantPart("datedAt", b.datedAt),
  ]);
}

/**
 * What a promoted copy of a payload is bound to. A permanent record is sealed
 * under the same namespace data key as the observation it rescues, so the two
 * envelopes share a key and must not share a domain: without separation a
 * record's ciphertext and an observation's could be exchanged for each other
 * under the write access this binding already assumes.
 *
 * The first part is the literal below. The reason usually given for it is
 * that no uuid can equal it, and that is true but not what carries the
 * property, since this package does not check that a namespace id is a uuid.
 * What carries it is the part count: a permanent envelope joins six parts and
 * a payload envelope eight, no part may contain the separator, so the two can
 * never be equal for any inputs at all.
 *
 * `originalDatedAt` is not nullable. A state has no instant to preserve and
 * `promote` refuses one before a record is ever sealed, which is also why the
 * column is `not null` in 0004.
 */
export interface PermanentBinding {
  recordId: string;
  observationId: string;
  namespaceId: string;
  originalDatedAt: Date;
  promotedAt: Date;
}

const PERMANENT_DOMAIN = "permanent";

export function permanentAad(b: PermanentBinding): Buffer {
  return joinParts([
    PERMANENT_DOMAIN,
    b.recordId,
    b.observationId,
    b.namespaceId,
    instantPart("originalDatedAt", b.originalDatedAt),
    instantPart("promotedAt", b.promotedAt),
  ]);
}

/**
 * A lone surrogate is not a character and UTF-8 cannot encode one, so
 * `Buffer.from` writes the replacement character instead -- and Postgres
 * stores the column the same way. Two distinct strings therefore render to
 * the same bytes: "a\uD800b" and "a\uFFFDb" are both `61 ef bf bd 62`.
 *
 * That breaks the property this whole function exists for. The separator
 * check makes distinct TUPLES render distinctly; this makes distinct PARTS
 * render distinctly, and without both, a payload can open under a row whose
 * column disagrees with it -- an observation whose `kind` column is the
 * replacement character while its sealed payload keeps the surrogate, with
 * the read path's own sentence ("a column that disagrees with it does not
 * open at all") false for that row.
 *
 * `\p{Surrogate}` under the `u` flag matches only LONE surrogates: a valid
 * pair is one non-surrogate code point to a unicode-aware regex. It agrees
 * with String.prototype.isWellFormed on every input, and is used instead
 * because that method is ES2024 and this package targets ES2023.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * What a month key is wrapped under: its own (namespace, period) pair.
 *
 * This is what stops a shred being evaded by a row copy. Move a live wrapped
 * month key into another namespace's row, or into another period's row of the
 * same namespace, and it no longer authenticates -- so a copy taken before
 * the shred is not a working key afterwards. Shredding is the only erasure
 * this ledger has, and a shred a row copy can evade is not one.
 *
 * Built through the same checked join as the envelopes rather than
 * concatenated by hand, so it inherits the separator and well-formedness
 * refusals instead of restating them.
 */
export function periodKeyAad(namespaceId: string, period: string): string {
  return joinParts([namespaceId, period]).toString("utf8");
}

function joinParts(parts: string[]): Buffer {
  for (const part of parts) {
    if (part.includes(SEPARATOR)) {
      throw new RangeError("associated data field contains NUL, the part separator");
    }
    if (LONE_SURROGATE.test(part)) {
      throw new RangeError(
        "associated data field contains a lone surrogate, which encodes to the " +
          "replacement character and would render the same bytes as another field",
      );
    }
  }
  return Buffer.from(parts.join(SEPARATOR), "utf8");
}

/**
 * An instant rendered for the envelope, refused by the name of the field it
 * came from. `toISOString` on an Invalid Date throws the runtime's own
 * RangeError, whose message names no field and no caller can act on;
 * `periodOf` already refuses one by name and this is the same instant
 * arriving one function later.
 */
function instantPart(name: string, value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date, got Invalid Date`);
  }
  return value.toISOString();
}

export function seal(dataKey: Buffer, plaintext: string, aad: Buffer): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

// `final()` is where GCM verifies the tag, so nothing `update()` produced is
// returned before that check has passed; a tampered or misplaced ciphertext
// throws rather than yielding a partial plaintext.
//
// The nonce length is checked here because the cipher would not: GCM accepts
// an IV of any length through a slower path, and a corrupted column should
// fail with an error this store owns rather than a distant one. The tag
// length is checked here for the opposite reason: the cipher does refuse a
// tag that is not the pinned length, but as a TypeError of its own, and a
// stored tag cut short is a malformed column, which this store names.
export function open(dataKey: Buffer, sealed: Sealed, aad: Buffer): string {
  if (sealed.nonce.length !== NONCE_BYTES) {
    throw new CiphertextMalformed(
      `sealed nonce must be ${NONCE_BYTES} bytes, got ${sealed.nonce.length}`,
    );
  }
  if (sealed.tag.length !== TAG_BYTES) {
    throw new CiphertextMalformed(`sealed tag must be ${TAG_BYTES} bytes, got ${sealed.tag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, dataKey, sealed.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return authenticate(decipher, sealed.ciphertext, "sealed payload").toString("utf8");
}

// GCM reports every refusal the same way, a wrong key, a moved ciphertext, a
// rewritten column in the associated data, a flipped bit, and the error it
// throws is a bare one. It is rethrown under a class this package owns, with
// the original as cause, so that a caller asserts on the class and a reader
// of the stack sees which bytes were being opened.
function authenticate(decipher: DecipherGCM, body: Buffer, what: string): Buffer {
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (e) {
    throw new CiphertextRejected(
      `${what} did not authenticate under this key and associated data`,
      { cause: e },
    );
  }
}

/**
 * Wrap one key under another, with the versioned layout the ring has always
 * used under the master: version byte, nonce, tag, encrypted key.
 *
 * Lifted out of the ring so that a month key can be wrapped under a
 * namespace key with the SAME layout rather than a second copy of it. A copy
 * drifts, and the drift is silent until a key minted by one cannot be opened
 * by the other; it also keeps `namespace_key_present`'s 29-byte header one
 * number instead of two that must be kept equal by hand.
 *
 * `binding` is the associated data, and it is what stops a wrapped key being
 * useful anywhere but where it was minted. Without it, copying one period's
 * wrapped key into another period's row before the first is shredded leaves a
 * live copy that survives the shred; shredding is the only erasure this
 * design has, and a shred a row copy can evade is not one.
 */
export function wrapUnder(key: Buffer, plaintextKey: Buffer, binding: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(binding, "utf8"));
  const body = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
  return Buffer.concat([Buffer.from([WRAP_VERSION]), nonce, cipher.getAuthTag(), body]);
}

/** The inverse of `wrapUnder`, refusing anything it did not produce. */
export function unwrapUnder(key: Buffer, wrapped: Buffer, binding: string): Buffer {
  if (wrapped.length < WRAP_HEADER_BYTES) {
    throw new CiphertextMalformed(
      `wrapped key is ${wrapped.length} bytes, shorter than its ${WRAP_HEADER_BYTES}-byte header`,
    );
  }
  const version = wrapped.readUInt8(0);
  if (version !== WRAP_VERSION) {
    throw new CiphertextMalformed(`unknown wrapped-key version ${version}`);
  }
  const nonce = wrapped.subarray(1, 1 + NONCE_BYTES);
  const tag = wrapped.subarray(1 + NONCE_BYTES, WRAP_HEADER_BYTES);
  const body = wrapped.subarray(WRAP_HEADER_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(binding, "utf8"));
  decipher.setAuthTag(tag);
  return authenticate(decipher, body, "wrapped key");
}

/**
 * There is no default master key and no development fallback. A fallback key
 * is a key that reaches production.
 *
 * The key is required to be canonical base64. The decoder drops characters it
 * does not recognise, so a key with a typo in it can still decode to thirty-two
 * bytes and fail later, at the first unwrap, instead of at startup where a
 * root-of-trust failure belongs.
 *
 * The wrapped form carries a version byte so that key rotation is a decode
 * branch rather than a migration over every stored row. Its layout under
 * version 1 is: version, nonce, tag, encrypted data key. A cut inside the
 * header fails the length guard; a cut inside the body changes what the tag
 * covers. The tag's own length is pinned by `authTagLength`, so a shorter tag
 * is refused outright rather than checked at the length it claims.
 *
 * A missing or malformed master key is a RangeError. The environment is this
 * function's argument, and a value not of the required shape is what a
 * RangeError names elsewhere in this package; it is not a store error,
 * because no stored state was examined.
 *
 * A wrapped key is bound to its namespace through the wrap's own associated
 * data. Without that, copying namespace A's wrapped key into namespace B's row
 * before A is shredded leaves a live copy of A's data key that survives the
 * shred, and A's payload rows, which stay in place by design, become readable
 * again to anyone who later holds the master key and the database. Shredding
 * is the only erasure this ledger has; a shred a row copy can evade is not one.
 */
export function keyRingFromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const raw = env.NNT_MASTER_KEY;
  if (!raw) {
    throw new RangeError("NNT_MASTER_KEY is not set; the store does not start without a master key");
  }
  const master = Buffer.from(raw, "base64");
  if (master.toString("base64") !== raw) {
    throw new RangeError("NNT_MASTER_KEY is not canonical base64; a character in it was not decoded");
  }
  if (master.length !== KEY_BYTES) {
    throw new RangeError(`NNT_MASTER_KEY must decode to 32 bytes, got ${master.length}`);
  }
  return {
    wrap(dataKey: Buffer, namespaceId: string): Buffer {
      return wrapUnder(master, dataKey, namespaceId);
    },
    unwrap(wrapped: Buffer, namespaceId: string): Buffer {
      return unwrapUnder(master, wrapped, namespaceId);
    },
    deriveKey(label: string): Buffer {
      if (label.length === 0) {
        throw new RangeError("a derived key needs a label; the empty label is the master key's own use");
      }
      // No salt: the master key is already uniform, and a salt that had to be
      // stored beside the seal would be one more thing a verifier must hold.
      return Buffer.from(
        hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(label, "utf8"), KEY_BYTES),
      );
    },
  };
}
