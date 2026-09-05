import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

// The associated data joins its two parts the same way the idempotency key in
// @nonametrust/schema joins its parts, on a NUL, and refuses a NUL inside
// either part, for the reason the schema states: without a separator that
// cannot occur inside a field, two adjacent parts can be re-partitioned into a
// different pair with the same concatenation, and the ciphertext would open
// under a row it was not sealed for. Today's callers pass a uuid and a hex
// digest, neither of which can carry a NUL, but this function's signature is
// two strings and it cannot see that; the refusal is what makes the property
// hold for a caller this package has not met yet.
//
// The byte layout of the associated data is frozen once a payload is stored.
// Changing it makes every existing ciphertext fail to open.
const SEPARATOR = "\u0000";

export interface Sealed {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface KeyRing {
  wrap(dataKey: Buffer, namespaceId: string): Buffer;
  unwrap(wrapped: Buffer, namespaceId: string): Buffer;
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function payloadAad(namespaceId: string, idempotencyKey: string): Buffer {
  const parts = [namespaceId, idempotencyKey];
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
// fail with an error this store owns rather than a distant one.
export function open(dataKey: Buffer, sealed: Sealed, aad: Buffer): string {
  if (sealed.nonce.length !== NONCE_BYTES) {
    throw new Error(`sealed nonce must be ${NONCE_BYTES} bytes, got ${sealed.nonce.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, dataKey, sealed.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
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
    throw new Error("NNT_MASTER_KEY is not set; the store does not start without a master key");
  }
  const master = Buffer.from(raw, "base64");
  if (master.toString("base64") !== raw) {
    throw new Error("NNT_MASTER_KEY is not canonical base64; a character in it was not decoded");
  }
  if (master.length !== KEY_BYTES) {
    throw new Error(`NNT_MASTER_KEY must decode to 32 bytes, got ${master.length}`);
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
        throw new Error(
          `wrapped key is ${wrapped.length} bytes, shorter than its ${WRAP_HEADER_BYTES}-byte header`,
        );
      }
      const version = wrapped.readUInt8(0);
      if (version !== WRAP_VERSION) {
        throw new Error(`unknown wrapped-key version ${version}`);
      }
      const nonce = wrapped.subarray(1, 1 + NONCE_BYTES);
      const tag = wrapped.subarray(1 + NONCE_BYTES, WRAP_HEADER_BYTES);
      const body = wrapped.subarray(WRAP_HEADER_BYTES);
      const decipher = createDecipheriv(ALGORITHM, master, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(namespaceId, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    },
  };
}
