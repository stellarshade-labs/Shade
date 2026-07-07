// Advanced stealth address functions
import type { StealthDerivation } from './stealth.js';
import { scalarMult, scalarMultBase, pointAdd } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';

/** Number of bytes used to serialize a stroop amount (fits any i64/u64 value). */
const AMOUNT_BYTES = 8;
/** Length of the appended authentication tag. */
const TAG_BYTES = 32;
/** Total ciphertext length: encrypted amount || HMAC tag. */
const CIPHERTEXT_BYTES = AMOUNT_BYTES + TAG_BYTES;
/** Maximum representable amount: Stellar stroop amounts are i64 (max 2^63 - 1). */
const MAX_AMOUNT = (1n << 63n) - 1n;

const encKeyLabel = new TextEncoder().encode('amount');
const macKeyLabel = new TextEncoder().encode('amount-mac');

/**
 * Derive a domain-separated 32-byte subkey from the shared secret.
 */
function deriveSubkey(sharedSecret: Uint8Array, label: Uint8Array): Uint8Array {
  const input = new Uint8Array(sharedSecret.length + label.length);
  input.set(sharedSecret, 0);
  input.set(label, sharedSecret.length);
  return sha256(input);
}

/**
 * Serialize a non-negative integer stroop amount to fixed-width big-endian bytes.
 * @throws {Error} If the amount is non-finite, negative, non-integer, or too large.
 */
function serializeAmount(amount: bigint | number): Uint8Array {
  let value: bigint;
  if (typeof amount === 'bigint') {
    value = amount;
  } else {
    if (!Number.isFinite(amount)) {
      throw new Error('Invalid amount: must be a finite integer');
    }
    if (!Number.isInteger(amount)) {
      throw new Error('Invalid amount: must be an integer number of stroops');
    }
    value = BigInt(amount);
  }

  if (value < 0n) {
    throw new Error('Invalid amount: must be non-negative');
  }
  if (value > MAX_AMOUNT) {
    throw new Error('Invalid amount: exceeds maximum stroop value');
  }

  const bytes = new Uint8Array(AMOUNT_BYTES);
  for (let i = AMOUNT_BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Encrypt a stroop amount using the shared secret (encrypt-then-MAC).
 *
 * The amount is serialized as a fixed-width 8-byte big-endian integer (stroops),
 * XORed with a keystream derived from the shared secret, then authenticated with
 * an HMAC-SHA256 tag. Tampering with the ciphertext is detected on decrypt.
 *
 * @param amount - The amount in stroops (non-negative integer, `bigint` or `number`)
 * @param sharedSecret - The 32-byte shared secret from ECDH
 * @returns 40-byte authenticated ciphertext (8-byte encrypted amount || 32-byte tag)
 * @throws {Error} If the shared secret length is wrong or the amount is invalid
 */
export function encryptAmount(amount: bigint | number, sharedSecret: Uint8Array): Uint8Array {
  if (sharedSecret.length !== 32) {
    throw new Error(`Invalid shared secret: expected 32 bytes, got ${sharedSecret.length}`);
  }

  const amountBytes = serializeAmount(amount);

  // Keystream: SHA256(sharedSecret || "amount"); XOR-encrypt the amount bytes.
  const keystream = deriveSubkey(sharedSecret, encKeyLabel);
  const ciphertext = new Uint8Array(CIPHERTEXT_BYTES);
  for (let i = 0; i < AMOUNT_BYTES; i++) {
    ciphertext[i] = amountBytes[i]! ^ keystream[i]!;
  }

  // Encrypt-then-MAC: authenticate the encrypted amount with HMAC-SHA256.
  const macKey = deriveSubkey(sharedSecret, macKeyLabel);
  const tag = hmac(sha256, macKey, ciphertext.subarray(0, AMOUNT_BYTES));
  ciphertext.set(tag, AMOUNT_BYTES);

  return ciphertext;
}

/**
 * Decrypt and authenticate a stroop amount using the shared secret.
 *
 * Verifies the HMAC-SHA256 tag in constant time before decrypting. Any
 * modification to the ciphertext (or a wrong shared secret) causes a throw
 * rather than returning a malleable, silently-wrong value.
 *
 * @param encrypted - The 40-byte authenticated ciphertext from {@link encryptAmount}
 * @param sharedSecret - The 32-byte shared secret from ECDH
 * @returns The decrypted amount in stroops as a `bigint`
 * @throws {Error} If the ciphertext length is wrong, the shared secret length is
 *   wrong, or the authentication tag does not verify
 */
export function decryptAmount(encrypted: Uint8Array, sharedSecret: Uint8Array): bigint {
  if (encrypted.length !== CIPHERTEXT_BYTES) {
    throw new Error(
      `Invalid encrypted amount: expected ${CIPHERTEXT_BYTES} bytes, got ${encrypted.length}`
    );
  }
  if (sharedSecret.length !== 32) {
    throw new Error(`Invalid shared secret: expected 32 bytes, got ${sharedSecret.length}`);
  }

  const body = encrypted.subarray(0, AMOUNT_BYTES);
  const tag = encrypted.subarray(AMOUNT_BYTES);

  // Verify the authentication tag in constant time (encrypt-then-MAC).
  const macKey = deriveSubkey(sharedSecret, macKeyLabel);
  const expectedTag = hmac(sha256, macKey, body);
  let diff = 0;
  for (let i = 0; i < TAG_BYTES; i++) {
    diff |= tag[i]! ^ expectedTag[i]!;
  }
  if (diff !== 0) {
    throw new Error('Invalid encrypted amount: authentication failed');
  }

  // XOR-decrypt and deserialize the big-endian stroop integer.
  const keystream = deriveSubkey(sharedSecret, encKeyLabel);
  let value = 0n;
  for (let i = 0; i < AMOUNT_BYTES; i++) {
    const plain = body[i]! ^ keystream[i]!;
    value = (value << 8n) | BigInt(plain);
  }
  return value;
}

export interface StealthDerivationWithSecret extends StealthDerivation {
  sharedSecret: Uint8Array;
}

/**
 * Derive a stealth address with the shared secret exposed.
 *
 * Similar to deriveStealthAddress but also returns the shared secret,
 * useful for applications that need amount encryption or other
 * shared secret-based features.
 *
 * @param spendPubKey - Receiver's 32-byte spend public key
 * @param viewPubKey - Receiver's 32-byte view public key
 * @param ephemeralPrivKey - Sender's 32-byte ephemeral private key
 * @returns Stealth derivation including the shared secret
 */
export function deriveStealthAddressWithSecret(
  spendPubKey: Uint8Array,
  viewPubKey: Uint8Array,
  ephemeralPrivKey: Uint8Array
): StealthDerivationWithSecret {
  // Compute ephemeral public key R = r*G
  const R = scalarMultBase(ephemeralPrivKey);

  // Compute shared secret S = r*K_view
  const S = scalarMult(ephemeralPrivKey, viewPubKey);

  // Hash shared secret to scalar s = SHA256(S) mod L
  const s = hashToScalar(S);

  // Compute stealth public key P = K_spend + s*G
  const sG = scalarMultBase(s);
  const P = pointAdd(spendPubKey, sG);

  // Get view tag
  const tag = viewTag(S);

  return {
    stealthPubKey: P,
    stealthAddress: encodePublicKey(P),
    ephemeralPubKey: R,
    viewTag: tag,
    ephemeralPrivKey: ephemeralPrivKey,
    sharedSecret: S
  };
}