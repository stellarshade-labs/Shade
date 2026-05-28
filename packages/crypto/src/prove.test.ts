import { describe, it, expect } from 'vitest';
import { proveOwnership, verifyOwnership } from './prove.js';
import { randomBytes } from '@noble/hashes/utils';
import { generateMetaAddress } from './keys.js';
import { deriveStealthAddress } from './stealth.js';
import { recoverStealthPrivateKey } from './recover.js';
import { scalarMultBase } from './ed25519.js';

describe('Ownership Proof', () => {
  it('should create and verify valid ownership proof', () => {
    const bobKeys = generateMetaAddress();
    const { ephemeralPubKey, stealthPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      ephemeralPubKey
    );

    // Verify key correspondence first
    const recoveredPub = scalarMultBase(stealthPrivKey);
    expect(Buffer.from(recoveredPub).toString('hex')).toBe(Buffer.from(stealthPubKey).toString('hex'));

    const challenge = new TextEncoder().encode('withdrawal_request_123456');
    const signature = proveOwnership(stealthPrivKey, challenge);

    // Verify against the stealth public key (raw scalar * G)
    const isValid = verifyOwnership(stealthPubKey, challenge, signature);
    expect(isValid).toBe(true);
    expect(signature).toHaveLength(64);
  });

  it('should fail verification with wrong public key', () => {
    const bobKeys = generateMetaAddress();
    const { ephemeralPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      ephemeralPubKey
    );

    const challenge = new TextEncoder().encode('withdrawal_request_123456');
    const signature = proveOwnership(stealthPrivKey, challenge);

    // Wrong public key
    const otherKeys = generateMetaAddress();
    const isValid = verifyOwnership(otherKeys.metaAddress.spendPubKey, challenge, signature);
    expect(isValid).toBe(false);
  });

  it('should fail verification with wrong challenge', () => {
    const bobKeys = generateMetaAddress();
    const { ephemeralPubKey, stealthPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      ephemeralPubKey
    );

    const challenge1 = new TextEncoder().encode('withdrawal_request_123456');
    const challenge2 = new TextEncoder().encode('withdrawal_request_789012');

    const signature = proveOwnership(stealthPrivKey, challenge1);
    const isValid = verifyOwnership(stealthPubKey, challenge2, signature);
    expect(isValid).toBe(false);
  });

  it('should fail verification with invalid signature', () => {
    const bobKeys = generateMetaAddress();
    const { stealthPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const challenge = new TextEncoder().encode('withdrawal_request_123456');
    const invalidSignature = randomBytes(64);

    const isValid = verifyOwnership(stealthPubKey, challenge, invalidSignature);
    expect(isValid).toBe(false);
  });

  it('should handle different challenge types', () => {
    const bobKeys = generateMetaAddress();
    const { ephemeralPubKey, stealthPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      ephemeralPubKey
    );

    const challenges = [
      new TextEncoder().encode('simple_text'),
      new Uint8Array([1, 2, 3, 4, 5]),
      randomBytes(32),
      new TextEncoder().encode(JSON.stringify({ action: 'withdraw', amount: 100 })),
    ];

    for (const challenge of challenges) {
      const signature = proveOwnership(stealthPrivKey, challenge);
      const isValid = verifyOwnership(stealthPubKey, challenge, signature);
      expect(isValid).toBe(true);
    }
  });

  it('should throw on invalid input lengths', () => {
    const validKey = new Uint8Array(32);
    const validChallenge = new Uint8Array([1, 2, 3]);
    const validSignature = new Uint8Array(64);

    expect(() => proveOwnership(new Uint8Array(31), validChallenge)).toThrow();
    expect(() => proveOwnership(validKey, new Uint8Array(0))).toThrow();
    expect(() => verifyOwnership(new Uint8Array(31), validChallenge, validSignature)).toThrow();
    expect(() => verifyOwnership(validKey, new Uint8Array(0), validSignature)).toThrow();
    expect(() => verifyOwnership(validKey, validChallenge, new Uint8Array(63))).toThrow();
  });

  it('should handle malformed signatures gracefully', () => {
    const bobKeys = generateMetaAddress();
    const { stealthPubKey } = deriveStealthAddress(bobKeys.metaAddress);
    const challenge = new TextEncoder().encode('test');

    // All zeros signature
    const zeroSig = new Uint8Array(64);
    expect(verifyOwnership(stealthPubKey, challenge, zeroSig)).toBe(false);

    // All ones signature
    const onesSig = new Uint8Array(64).fill(0xff);
    expect(verifyOwnership(stealthPubKey, challenge, onesSig)).toBe(false);

    // Signature with invalid scalar part (S > L)
    const invalidScalarSig = new Uint8Array(64);
    invalidScalarSig.set(randomBytes(32), 0); // Valid R
    invalidScalarSig.fill(0xff, 32); // Invalid S (all 0xff is > L)
    expect(verifyOwnership(stealthPubKey, challenge, invalidScalarSig)).toBe(false);
  });

  it('should handle boundary message lengths', () => {
    const bobKeys = generateMetaAddress();
    const { ephemeralPubKey, stealthPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      ephemeralPubKey
    );

    // Single byte message
    const singleByte = new Uint8Array([0x42]);
    const sig1 = proveOwnership(stealthPrivKey, singleByte);
    expect(verifyOwnership(stealthPubKey, singleByte, sig1)).toBe(true);

    // Large message (1MB)
    const largeMessage = new Uint8Array(1024 * 1024).fill(0xaa);
    const sig2 = proveOwnership(stealthPrivKey, largeMessage);
    expect(verifyOwnership(stealthPubKey, largeMessage, sig2)).toBe(true);

    // Message with all zeros
    const zeroMessage = new Uint8Array(100);
    const sig3 = proveOwnership(stealthPrivKey, zeroMessage);
    expect(verifyOwnership(stealthPubKey, zeroMessage, sig3)).toBe(true);

    // Message with all ones
    const onesMessage = new Uint8Array(100).fill(0xff);
    const sig4 = proveOwnership(stealthPrivKey, onesMessage);
    expect(verifyOwnership(stealthPubKey, onesMessage, sig4)).toBe(true);
  });

  it('should produce deterministic signatures', () => {
    const bobKeys = generateMetaAddress();
    const { ephemeralPubKey } = deriveStealthAddress(bobKeys.metaAddress);

    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      ephemeralPubKey
    );

    const challenge = new TextEncoder().encode('deterministic_test');

    // Same key and challenge should produce the same signature
    const sig1 = proveOwnership(stealthPrivKey, challenge);
    const sig2 = proveOwnership(stealthPrivKey, challenge);

    expect(sig1).toEqual(sig2);
  });
});
