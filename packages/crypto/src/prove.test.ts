import { describe, it, expect } from 'vitest';
import { proveOwnership, verifyOwnership } from './prove.js';
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { recoverStealthPrivateKey } from './recover.js';
import { computeStealthAddress } from './stealth.js';

describe('Ownership Proof', () => {
  it('should create and verify valid ownership proof', () => {
    // Generate stealth keys
    const viewPrivKey = randomBytes(32);
    const spendPrivKey = randomBytes(32);
    const viewPubKey = ed25519.getPublicKey(viewPrivKey);
    const spendPubKey = ed25519.getPublicKey(spendPrivKey);

    // Compute stealth address
    const { ephemeralPubKey, stealthPubKey } = computeStealthAddress(
      spendPubKey,
      viewPubKey
    );

    // Derive stealth private key
    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      ephemeralPubKey
    );

    // Create a challenge
    const challenge = new TextEncoder().encode('withdrawal_request_123456');

    // Prove ownership
    const signature = proveOwnership(stealthPrivKey, challenge);

    // Verify ownership
    const isValid = verifyOwnership(stealthPubKey, challenge, signature);

    expect(isValid).toBe(true);
    expect(signature).toHaveLength(64);
  });

  it('should fail verification with wrong public key', () => {
    // Generate stealth keys
    const viewPrivKey = randomBytes(32);
    const spendPrivKey = randomBytes(32);
    const viewPubKey = ed25519.getPublicKey(viewPrivKey);
    const spendPubKey = ed25519.getPublicKey(spendPrivKey);

    // Compute stealth address
    const { ephemeralPubKey } = computeStealthAddress(
      spendPubKey,
      viewPubKey
    );

    // Derive stealth private key
    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      ephemeralPubKey
    );

    // Create a challenge
    const challenge = new TextEncoder().encode('withdrawal_request_123456');

    // Prove ownership
    const signature = proveOwnership(stealthPrivKey, challenge);

    // Try to verify with wrong public key
    const wrongPubKey = ed25519.getPublicKey(randomBytes(32));
    const isValid = verifyOwnership(wrongPubKey, challenge, signature);

    expect(isValid).toBe(false);
  });

  it('should fail verification with wrong challenge', () => {
    // Generate stealth keys
    const viewPrivKey = randomBytes(32);
    const spendPrivKey = randomBytes(32);
    const viewPubKey = ed25519.getPublicKey(viewPrivKey);
    const spendPubKey = ed25519.getPublicKey(spendPrivKey);

    // Compute stealth address
    const { ephemeralPubKey, stealthPubKey } = computeStealthAddress(
      spendPubKey,
      viewPubKey
    );

    // Derive stealth private key
    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      ephemeralPubKey
    );

    // Create challenges
    const challenge1 = new TextEncoder().encode('withdrawal_request_123456');
    const challenge2 = new TextEncoder().encode('withdrawal_request_789012');

    // Prove ownership with first challenge
    const signature = proveOwnership(stealthPrivKey, challenge1);

    // Try to verify with different challenge
    const isValid = verifyOwnership(stealthPubKey, challenge2, signature);

    expect(isValid).toBe(false);
  });

  it('should fail verification with invalid signature', () => {
    // Generate stealth keys
    const viewPrivKey = randomBytes(32);
    const spendPrivKey = randomBytes(32);
    const viewPubKey = ed25519.getPublicKey(viewPrivKey);
    const spendPubKey = ed25519.getPublicKey(spendPrivKey);

    // Compute stealth address
    const { stealthPubKey } = computeStealthAddress(
      spendPubKey,
      viewPubKey
    );

    // Create a challenge
    const challenge = new TextEncoder().encode('withdrawal_request_123456');

    // Create invalid signature (random bytes)
    const invalidSignature = new Uint8Array(64);
    crypto.getRandomValues(invalidSignature);

    // Try to verify with invalid signature
    const isValid = verifyOwnership(stealthPubKey, challenge, invalidSignature);

    expect(isValid).toBe(false);
  });

  it('should handle different challenge types', () => {
    // Generate stealth keys
    const viewPrivKey = randomBytes(32);
    const spendPrivKey = randomBytes(32);
    const viewPubKey = ed25519.getPublicKey(viewPrivKey);
    const spendPubKey = ed25519.getPublicKey(spendPrivKey);

    // Compute stealth address
    const { ephemeralPubKey, stealthPubKey } = computeStealthAddress(
      spendPubKey,
      viewPubKey
    );

    // Derive stealth private key
    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      ephemeralPubKey
    );

    // Test with different challenge types
    const challenges = [
      new TextEncoder().encode('simple_text'),
      new Uint8Array([1, 2, 3, 4, 5]),
      crypto.getRandomValues(new Uint8Array(32)), // Random 32-byte nonce
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

    // Invalid private key length
    expect(() => proveOwnership(new Uint8Array(31), validChallenge)).toThrow(
      'Invalid stealth private key length'
    );

    // Empty challenge
    expect(() => proveOwnership(validKey, new Uint8Array(0))).toThrow(
      'Challenge cannot be empty'
    );

    // Invalid public key length
    expect(() => verifyOwnership(new Uint8Array(31), validChallenge, validSignature)).toThrow(
      'Invalid stealth public key length'
    );

    // Empty challenge for verify
    expect(() => verifyOwnership(validKey, new Uint8Array(0), validSignature)).toThrow(
      'Challenge cannot be empty'
    );

    // Invalid signature length
    expect(() => verifyOwnership(validKey, validChallenge, new Uint8Array(63))).toThrow(
      'Invalid signature length'
    );
  });
});