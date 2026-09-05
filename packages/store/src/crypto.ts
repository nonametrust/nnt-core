import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAP_VERSION = 1;

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
  wrap(dataKey: Buffer): Buffer;
  unwrap(wrapped: Buffer): Buffer;
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
  const cipher = createCipheriv(ALGORITHM, dataKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

// `final()` is where GCM verifies the tag, so nothing `update()` produced is
// returned before that check has passed; a tampered or misplaced ciphertext
// throws rather than yielding a partial plaintext.
export function open(dataKey: Buffer, sealed: Sealed, aad: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, dataKey, sealed.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}

/**
 * There is no default master key and no development fallback. A fallback key
 * is a key that reaches production.
 *
 * The wrapped form carries a version byte so that key rotation is a decode
 * branch rather than a migration over every stored row. Its layout under
 * version 1 is: version, nonce, tag, encrypted data key. A truncated or
 * altered wrapped key fails the tag check; no separate length check is needed
 * because GCM authenticates the body's length along with its bytes.
 */
export function keyRingFromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const raw = env.NNT_MASTER_KEY;
  if (!raw) {
    throw new Error("NNT_MASTER_KEY is not set; the store does not start without a master key");
  }
  const master = Buffer.from(raw, "base64");
  if (master.length !== KEY_BYTES) {
    throw new Error(`NNT_MASTER_KEY must decode to 32 bytes, got ${master.length}`);
  }
  return {
    wrap(dataKey: Buffer): Buffer {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, master, nonce);
      const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return Buffer.concat([Buffer.from([WRAP_VERSION]), nonce, cipher.getAuthTag(), body]);
    },
    unwrap(wrapped: Buffer): Buffer {
      if (wrapped[0] !== WRAP_VERSION) {
        throw new Error(`unknown wrapped-key version ${wrapped[0]}`);
      }
      const nonce = wrapped.subarray(1, 1 + NONCE_BYTES);
      const tag = wrapped.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
      const body = wrapped.subarray(1 + NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, master, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    },
  };
}
