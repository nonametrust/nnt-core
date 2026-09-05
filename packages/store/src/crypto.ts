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
// under a row it was not sealed for. Four of the six parts cannot carry a
// NUL by construction, a uuid, a hex digest, one of two fixed words and an
// ISO instant; channel and kind are free strings and can, and the refusal
// is what makes the property hold for them, and for a caller this package
// has not met yet.
//
// The byte layout of the associated data is frozen once a payload is stored.
// Changing it makes every existing ciphertext fail to open. It was changed
// once, before anything was deployed, to take in the columns beside the
// payload; that cost nothing then and would be a re-encryption of every row
// now.
const SEPARATOR = "\u0000";

// The rendering of a row that carries no instant. A state has none, and the
// column is null for it. The empty part is chosen because no instant renders
// to it, and the fixed part count keeps an empty part distinct from a missing
// one: the instant is the last part, so a separator with nothing after it is
// a null and nothing else.
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
 * signature we hold. The other four are the same threat carried one step
 * further. Under that model the append-only trigger is already assumed
 * bypassed, since a swap needs an UPDATE too, and so a derived column can be
 * moved while the payload still opens: the promotion trigger measures a
 * record against the dated column, not against the evidence, and a moved
 * column would put the row's instant into a permanent record with nothing
 * in the store able to tell. Bound here, a rewritten column fails to open,
 * which is the refusal a moved row already gets.
 *
 * `datedAt` is the Date the column holds, on both sides: the writer passes
 * the Date it is about to store and the reader passes the Date it read back,
 * and both render it the one way `toISOString` does. The wire string is not
 * used, because the schema admits more than one spelling of an instant and
 * the column keeps only what a Date keeps.
 */
export interface PayloadBinding {
  namespaceId: string;
  idempotencyKey: string;
  evidenceKind: string;
  channel: string;
  kind: string;
  datedAt: Date | null;
}

export function payloadAad(b: PayloadBinding): Buffer {
  const parts = [
    b.namespaceId,
    b.idempotencyKey,
    b.evidenceKind,
    b.channel,
    b.kind,
    b.datedAt === null ? UNDATED : b.datedAt.toISOString(),
  ];
  for (const part of parts) {
    if (part.includes(SEPARATOR)) {
      throw new RangeError("associated data field contains NUL, the part separator");
    }
  }
  return Buffer.from(parts.join(SEPARATOR), "utf8");
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
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, master, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(namespaceId, "utf8"));
      const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return Buffer.concat([Buffer.from([WRAP_VERSION]), nonce, cipher.getAuthTag(), body]);
    },
    unwrap(wrapped: Buffer, namespaceId: string): Buffer {
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
      const decipher = createDecipheriv(ALGORITHM, master, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(namespaceId, "utf8"));
      decipher.setAuthTag(tag);
      return authenticate(decipher, body, "wrapped key");
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
