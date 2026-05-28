// Advanced stealth address functions
import type { StealthDerivation } from './stealth.js';
import { scalarMult, scalarMultBase, pointAdd } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Encrypt an amount using the shared secret.
 *
 * Uses XOR encryption with SHA256(sharedSecret || "amount") as the key.
 * This provides confidential amounts in stealth transactions.
 *
 * @param amount - The amount to encrypt
 * @param sharedSecret - The 32-byte shared secret from ECDH
 * @returns 8-byte encrypted amount
 */
export function encryptAmount(amount: number, sharedSecret: Uint8Array): Uint8Array {
  // Create key material
  const keyInput = new Uint8Array(32 + 6);
  keyInput.set(sharedSecret, 0);
  keyInput.set(new TextEncoder().encode('amount'), 32);
  const key = sha256(keyInput);

  // Convert amount to 8-byte little-endian
  const amountBytes = new Uint8Array(8);
  const view = new DataView(amountBytes.buffer);
  view.setFloat64(0, amount, true); // little-endian

  // XOR encrypt
  const encrypted = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    encrypted[i] = amountBytes[i]! ^ key[i]!;
  }

  return encrypted;
}

/**
 * Decrypt an amount using the shared secret.
 *
 * @param encrypted - The 8-byte encrypted amount
 * @param sharedSecret - The 32-byte shared secret from ECDH
 * @returns The decrypted amount
 */
export function decryptAmount(encrypted: Uint8Array, sharedSecret: Uint8Array): number {
  // Create key material
  const keyInput = new Uint8Array(32 + 6);
  keyInput.set(sharedSecret, 0);
  keyInput.set(new TextEncoder().encode('amount'), 32);
  const key = sha256(keyInput);

  // XOR decrypt
  const decrypted = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    decrypted[i] = encrypted[i]! ^ key[i]!;
  }

  // Convert from little-endian to number
  const view = new DataView(decrypted.buffer);
  return view.getFloat64(0, true); // little-endian
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