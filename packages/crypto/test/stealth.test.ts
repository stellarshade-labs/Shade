import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/curves/abstract/utils';
import { generateMetaAddress } from '../src/keys.js';
import { deriveStealthAddress } from '../src/stealth.js';
import { isMyStealthAddress } from '../src/scan.js';
import { recoverStealthPrivateKey } from '../src/recover.js';
import { scalarMultBase } from '../src/ed25519.js';

describe('stealth address derivation', () => {
  it('should derive a valid stealth address', () => {
    const keys = generateMetaAddress();
    const derivation = deriveStealthAddress(keys.metaAddress);

    // Verify all fields are present
    expect(derivation.stealthPubKey).toHaveLength(32);
    expect(derivation.stealthAddress).toMatch(/^G[A-Z2-7]+$/);
    expect(derivation.ephemeralPubKey).toHaveLength(32);
    expect(derivation.ephemeralPrivKey).toHaveLength(32);
    expect(derivation.viewTag).toBeGreaterThanOrEqual(0);
    expect(derivation.viewTag).toBeLessThanOrEqual(255);
  });

  it('should create different stealth addresses for same meta-address', () => {
    const keys = generateMetaAddress();

    const derivation1 = deriveStealthAddress(keys.metaAddress);
    const derivation2 = deriveStealthAddress(keys.metaAddress);

    // Each derivation should be unique due to random ephemeral key
    expect(derivation1.stealthAddress).not.toBe(derivation2.stealthAddress);
    expect(bytesToHex(derivation1.ephemeralPubKey)).not.toBe(
      bytesToHex(derivation2.ephemeralPubKey)
    );
  });

  it('should allow receiver to identify their stealth address', () => {
    const keys = generateMetaAddress();
    const derivation = deriveStealthAddress(keys.metaAddress);

    // Receiver should be able to identify their stealth address
    const isMine = isMyStealthAddress(
      keys.viewPrivKey,
      keys.metaAddress.spendPubKey,
      derivation.ephemeralPubKey,
      derivation.stealthAddress
    );

    expect(isMine).toBe(true);
  });

  it('should not identify wrong stealth address as mine', () => {
    const aliceKeys = generateMetaAddress();
    const bobKeys = generateMetaAddress();

    // Alice creates stealth address for Bob
    const bobStealth = deriveStealthAddress(bobKeys.metaAddress);

    // Alice should not identify Bob's stealth address as hers
    const isAlices = isMyStealthAddress(
      aliceKeys.viewPrivKey,
      aliceKeys.metaAddress.spendPubKey,
      bobStealth.ephemeralPubKey,
      bobStealth.stealthAddress
    );

    expect(isAlices).toBe(false);
  });

  it('should derive correct stealth private key', () => {
    const keys = generateMetaAddress();
    const derivation = deriveStealthAddress(keys.metaAddress);

    // Recover private key
    const stealthPrivKey = recoverStealthPrivateKey(
      keys.spendPrivKey,
      keys.viewPrivKey,
      derivation.ephemeralPubKey
    );

    // Verify it corresponds to the stealth public key
    const derivedPubKey = scalarMultBase(stealthPrivKey);
    expect(bytesToHex(derivedPubKey)).toBe(bytesToHex(derivation.stealthPubKey));
  });
});