import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { deriveKeysFromSignature } from '../src/derive-signature.js';
import { deriveStealthAddress } from '../src/stealth.js';
import { recoverStealthPrivateKey } from '../src/recover.js';
import { scalarMultBase } from '../src/ed25519.js';
import type { StealthKeys } from '../src/types.js';

/**
 * Deterministic 64-byte "signature" generator so the property sweep is
 * reproducible across runs. Not cryptographic randomness — just a stable stream
 * of distinct byte vectors seeded by an index.
 */
function pseudoSignature(index: number): Uint8Array {
  const seed = new Uint8Array(4);
  seed[0] = index & 0xff;
  seed[1] = (index >> 8) & 0xff;
  seed[2] = (index >> 16) & 0xff;
  seed[3] = (index >> 24) & 0xff;
  const first = sha256(seed);
  const second = sha256(first);
  const sig = new Uint8Array(64);
  sig.set(first, 0);
  sig.set(second, 32);
  return sig;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const SWEEP_COUNT = 100;

describe('deriveKeysFromSignature hardening sweep', () => {
  const signatures = Array.from({ length: SWEEP_COUNT }, (_, i) => pseudoSignature(i));

  it(`derives valid keypairs for all ${SWEEP_COUNT} signatures`, () => {
    for (const sig of signatures) {
      const keys = deriveKeysFromSignature(sig);

      expect(keys.spendPrivKey.length).toBe(32);
      expect(keys.viewPrivKey.length).toBe(32);
      expect(keys.metaAddress.spendPubKey.length).toBe(32);
      expect(keys.metaAddress.viewPubKey.length).toBe(32);

      // Public keys must be the base-point multiples of the private keys.
      expect(scalarMultBase(keys.spendPrivKey)).toEqual(keys.metaAddress.spendPubKey);
      expect(scalarMultBase(keys.viewPrivKey)).toEqual(keys.metaAddress.viewPubKey);

      // Spend and view scalars must be independent.
      expect(keys.spendPrivKey).not.toEqual(keys.viewPrivKey);
    }
  });

  it('is deterministic: deriving twice yields identical keys', () => {
    for (const sig of signatures) {
      const a = deriveKeysFromSignature(sig);
      const b = deriveKeysFromSignature(sig);

      expect(a.spendPrivKey).toEqual(b.spendPrivKey);
      expect(a.viewPrivKey).toEqual(b.viewPrivKey);
      expect(a.metaAddress.spendPubKey).toEqual(b.metaAddress.spendPubKey);
      expect(a.metaAddress.viewPubKey).toEqual(b.metaAddress.viewPubKey);
    }
  });

  it('produces mutually distinct keypairs across all signatures', () => {
    const spendPubs = new Set<string>();
    const viewPubs = new Set<string>();
    const spendPrivs = new Set<string>();
    const viewPrivs = new Set<string>();

    for (const sig of signatures) {
      const keys: StealthKeys = deriveKeysFromSignature(sig);
      spendPubs.add(bytesToHex(keys.metaAddress.spendPubKey));
      viewPubs.add(bytesToHex(keys.metaAddress.viewPubKey));
      spendPrivs.add(bytesToHex(keys.spendPrivKey));
      viewPrivs.add(bytesToHex(keys.viewPrivKey));
    }

    expect(spendPubs.size).toBe(SWEEP_COUNT);
    expect(viewPubs.size).toBe(SWEEP_COUNT);
    expect(spendPrivs.size).toBe(SWEEP_COUNT);
    expect(viewPrivs.size).toBe(SWEEP_COUNT);
  });

  it('derives keys usable for a full DKSAP round-trip', () => {
    for (const sig of signatures) {
      const keys = deriveKeysFromSignature(sig);

      const derivation = deriveStealthAddress(keys.metaAddress);
      const recovered = recoverStealthPrivateKey(
        keys.spendPrivKey,
        keys.viewPrivKey,
        derivation.ephemeralPubKey,
      );

      expect(scalarMultBase(recovered)).toEqual(derivation.stealthPubKey);
    }
  });

  describe('negative cases', () => {
    it('throws on a 63-byte signature', () => {
      expect(() => deriveKeysFromSignature(new Uint8Array(63).fill(3))).toThrow();
    });

    it('throws on a 65-byte signature', () => {
      expect(() => deriveKeysFromSignature(new Uint8Array(65).fill(3))).toThrow();
    });

    it('throws on an all-zero 64-byte signature', () => {
      expect(() => deriveKeysFromSignature(new Uint8Array(64))).toThrow();
    });
  });
});
