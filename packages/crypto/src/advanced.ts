import { deriveStealthAddress as deriveStealthAddressBasic } from './stealth.js';
import type { StealthMetaAddress, Announcement } from './types.js';
import type { StealthDerivation } from './stealth.js';
import { scalarMult, scalarMultBase, pointAdd } from './ed25519.js';
import { hashToScalar, viewTag } from './hash.js';
import { encodePublicKey } from './stellar-keys.js';
import { sha256 } from '@noble/hashes/sha256';

export function generateKeys() {
  const { generateMetaAddress } = require('./keys.js');
  const keys = generateMetaAddress();
  return {
    spendPublicKey: keys.spendPubKey,
    spendPrivateKey: keys.spendPrivKey,
    viewPublicKey: keys.viewPubKey,
    viewPrivateKey: keys.viewPrivKey
  };
}

export function encryptAmount(amount: number, sharedSecret: Uint8Array): Uint8Array {
  const key = sha256(Buffer.concat([sharedSecret, Buffer.from('amount')]));
  const amountBytes = Buffer.allocUnsafe(8);
  amountBytes.writeDoubleLE(amount, 0);

  const encrypted = Buffer.allocUnsafe(8);
  for (let i = 0; i < 8; i++) {
    encrypted[i] = amountBytes[i] ^ key[i];
  }

  return encrypted;
}

export function decryptAmount(encrypted: Uint8Array, sharedSecret: Uint8Array): number {
  const key = sha256(Buffer.concat([sharedSecret, Buffer.from('amount')]));
  const decrypted = Buffer.allocUnsafe(8);

  for (let i = 0; i < 8; i++) {
    decrypted[i] = encrypted[i] ^ key[i];
  }

  return decrypted.readDoubleLE(0);
}

export interface StealthDerivationWithSecret extends StealthDerivation {
  sharedSecret: Uint8Array;
}

export function deriveStealthAddress(
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