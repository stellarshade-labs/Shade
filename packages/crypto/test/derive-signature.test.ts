import { describe, it, expect } from 'vitest';
import {
  KEY_DERIVATION_CONTEXT_V1,
  buildKeyDerivationMessage,
  deriveKeysFromSignature,
} from '../src/derive-signature.js';
import { deriveStealthAddress } from '../src/stealth.js';
import { recoverStealthPrivateKey } from '../src/recover.js';
import { scalarMultBase } from '../src/ed25519.js';

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('buildKeyDerivationMessage', () => {
  it('should default network and app when no options given', () => {
    const message = buildKeyDerivationMessage();
    expect(message).toBe(
      [
        'stellar-stealth-keys-v1',
        'network:any',
        'app:default',
        'WARNING: Signing this message derives your stealth keys. Only sign it in apps you trust.',
      ].join('\n'),
    );
  });

  it('should embed provided network and appId', () => {
    const message = buildKeyDerivationMessage({ network: 'testnet', appId: 'my-app' });
    expect(message).toBe(
      [
        'stellar-stealth-keys-v1',
        'network:testnet',
        'app:my-app',
        'WARNING: Signing this message derives your stealth keys. Only sign it in apps you trust.',
      ].join('\n'),
    );
  });

  it('should start with the v1 context constant', () => {
    expect(KEY_DERIVATION_CONTEXT_V1).toBe('stellar-stealth-keys-v1');
    expect(buildKeyDerivationMessage().startsWith(KEY_DERIVATION_CONTEXT_V1)).toBe(true);
  });
});

describe('deriveKeysFromSignature', () => {
  const validSig = new Uint8Array(64).fill(7);

  it('should reject a 63-byte signature', () => {
    expect(() => deriveKeysFromSignature(new Uint8Array(63).fill(1))).toThrow();
  });

  it('should reject a 65-byte signature', () => {
    expect(() => deriveKeysFromSignature(new Uint8Array(65).fill(1))).toThrow();
  });

  it('should reject an all-zero signature', () => {
    expect(() => deriveKeysFromSignature(new Uint8Array(64))).toThrow();
  });

  it('should produce valid 32-byte public keys', () => {
    const keys = deriveKeysFromSignature(validSig);
    expect(keys.metaAddress.spendPubKey).toBeInstanceOf(Uint8Array);
    expect(keys.metaAddress.spendPubKey.length).toBe(32);
    expect(keys.metaAddress.viewPubKey).toBeInstanceOf(Uint8Array);
    expect(keys.metaAddress.viewPubKey.length).toBe(32);
  });

  it('should produce valid 32-byte private keys', () => {
    const keys = deriveKeysFromSignature(validSig);
    expect(keys.spendPrivKey).toBeInstanceOf(Uint8Array);
    expect(keys.spendPrivKey.length).toBe(32);
    expect(keys.viewPrivKey).toBeInstanceOf(Uint8Array);
    expect(keys.viewPrivKey.length).toBe(32);
  });

  it('should be deterministic: same signature always produces same keys', () => {
    const keys1 = deriveKeysFromSignature(validSig);
    const keys2 = deriveKeysFromSignature(validSig);

    expect(keys1.spendPrivKey).toEqual(keys2.spendPrivKey);
    expect(keys1.viewPrivKey).toEqual(keys2.viewPrivKey);
    expect(keys1.metaAddress.spendPubKey).toEqual(keys2.metaAddress.spendPubKey);
    expect(keys1.metaAddress.viewPubKey).toEqual(keys2.metaAddress.viewPubKey);
  });

  it('should produce different keys for different signatures', () => {
    const keys1 = deriveKeysFromSignature(new Uint8Array(64).fill(7));
    const keys2 = deriveKeysFromSignature(new Uint8Array(64).fill(8));

    expect(keys1.spendPrivKey).not.toEqual(keys2.spendPrivKey);
    expect(keys1.viewPrivKey).not.toEqual(keys2.viewPrivKey);
  });

  it('should derive distinct spend and view scalars from one signature', () => {
    const keys = deriveKeysFromSignature(validSig);
    expect(keys.spendPrivKey).not.toEqual(keys.viewPrivKey);
  });

  it('should produce public keys consistent with private keys', () => {
    const keys = deriveKeysFromSignature(validSig);
    expect(scalarMultBase(keys.spendPrivKey)).toEqual(keys.metaAddress.spendPubKey);
    expect(scalarMultBase(keys.viewPrivKey)).toEqual(keys.metaAddress.viewPubKey);
  });

  it('should produce keys usable for DKSAP round-trip', () => {
    const keys = deriveKeysFromSignature(validSig);

    // Sender derives a stealth address from the meta-address
    const derivation = deriveStealthAddress(keys.metaAddress);

    // Receiver recovers the stealth private key
    const recoveredPrivKey = recoverStealthPrivateKey(
      keys.spendPrivKey,
      keys.viewPrivKey,
      derivation.ephemeralPubKey,
    );

    // The recovered private key should correspond to the stealth public key
    const recoveredPubKey = scalarMultBase(recoveredPrivKey);
    expect(recoveredPubKey).toEqual(derivation.stealthPubKey);
  });

  it('should match the pinned derivation vector (locks CLI/browser output forever)', () => {
    const signatureHex =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' +
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const keys = deriveKeysFromSignature(hexToBytes(signatureHex));

    expect(bytesToHex(keys.metaAddress.spendPubKey)).toBe(
      '3048c9a5cd80345a35e1a8fa05279d90ca355de5889b5c35163278a263a8330b',
    );
    expect(bytesToHex(keys.metaAddress.viewPubKey)).toBe(
      'ef3792561bf35026b50659e5aae53d9fe3786f2fae4f25bc1d02f5602c9ba2ed',
    );
  });
});
