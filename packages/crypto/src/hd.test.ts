import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic, mnemonicToStealthKeys } from './hd.js';
import { deriveStealthAddress } from './stealth.js';
import { recoverStealthPrivateKey } from './recover.js';
import { scalarMultBase } from './ed25519.js';

describe('generateMnemonic', () => {
  it('should produce 12 words', () => {
    const mnemonic = generateMnemonic();
    const words = mnemonic.split(' ');
    expect(words.length).toBe(12);
  });
});

describe('validateMnemonic', () => {
  it('should accept a valid mnemonic', () => {
    const mnemonic = generateMnemonic();
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('should reject an invalid mnemonic', () => {
    expect(validateMnemonic('not a valid mnemonic phrase at all')).toBe(false);
    expect(validateMnemonic('')).toBe(false);
    expect(validateMnemonic('abandon abandon abandon')).toBe(false);
  });
});

describe('mnemonicToStealthKeys', () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('should produce valid 32-byte public keys', () => {
    const keys = mnemonicToStealthKeys(testMnemonic);
    expect(keys.metaAddress.spendPubKey).toBeInstanceOf(Uint8Array);
    expect(keys.metaAddress.spendPubKey.length).toBe(32);
    expect(keys.metaAddress.viewPubKey).toBeInstanceOf(Uint8Array);
    expect(keys.metaAddress.viewPubKey.length).toBe(32);
  });

  it('should produce valid 32-byte private keys', () => {
    const keys = mnemonicToStealthKeys(testMnemonic);
    expect(keys.spendPrivKey).toBeInstanceOf(Uint8Array);
    expect(keys.spendPrivKey.length).toBe(32);
    expect(keys.viewPrivKey).toBeInstanceOf(Uint8Array);
    expect(keys.viewPrivKey.length).toBe(32);
  });

  it('should be deterministic: same mnemonic always produces same keys', () => {
    const keys1 = mnemonicToStealthKeys(testMnemonic);
    const keys2 = mnemonicToStealthKeys(testMnemonic);

    expect(keys1.spendPrivKey).toEqual(keys2.spendPrivKey);
    expect(keys1.viewPrivKey).toEqual(keys2.viewPrivKey);
    expect(keys1.metaAddress.spendPubKey).toEqual(keys2.metaAddress.spendPubKey);
    expect(keys1.metaAddress.viewPubKey).toEqual(keys2.metaAddress.viewPubKey);
  });

  it('should produce different keys for different mnemonics', () => {
    const mnemonic2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    const keys1 = mnemonicToStealthKeys(testMnemonic);
    const keys2 = mnemonicToStealthKeys(mnemonic2);

    expect(keys1.spendPrivKey).not.toEqual(keys2.spendPrivKey);
    expect(keys1.viewPrivKey).not.toEqual(keys2.viewPrivKey);
  });

  it('should produce different keys with a passphrase', () => {
    const keysNoPass = mnemonicToStealthKeys(testMnemonic);
    const keysWithPass = mnemonicToStealthKeys(testMnemonic, 'my-secret');

    expect(keysNoPass.spendPrivKey).not.toEqual(keysWithPass.spendPrivKey);
    expect(keysNoPass.viewPrivKey).not.toEqual(keysWithPass.viewPrivKey);
  });

  it('should produce public keys consistent with private keys', () => {
    const keys = mnemonicToStealthKeys(testMnemonic);
    expect(scalarMultBase(keys.spendPrivKey)).toEqual(keys.metaAddress.spendPubKey);
    expect(scalarMultBase(keys.viewPrivKey)).toEqual(keys.metaAddress.viewPubKey);
  });

  it('should produce keys usable for DKSAP round-trip', () => {
    const keys = mnemonicToStealthKeys(testMnemonic);

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
});
