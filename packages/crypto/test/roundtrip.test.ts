import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/curves/abstract/utils';
import { generateMetaAddress } from '../src/keys.js';
import { deriveStealthAddress } from '../src/stealth.js';
import { scanAnnouncements } from '../src/scan.js';
import { recoverStealthPrivateKey } from '../src/recover.js';
import { scalarMultBase } from '../src/ed25519.js';
import { signWithStealthKey } from '../src/prove.js';
import type { Announcement } from '../src/types.js';

describe('complete roundtrip', () => {
  it('should complete full stealth address flow', () => {
    // Step 1: Bob generates meta-address
    const bobKeys = generateMetaAddress();

    // Step 2: Alice derives stealth address for Bob
    const derivation = deriveStealthAddress(bobKeys.metaAddress);

    // Step 3: Alice creates announcement
    const announcement: Announcement = {
      ephemeralPubKey: derivation.ephemeralPubKey,
      viewTag: derivation.viewTag,
      stealthAddress: derivation.stealthAddress,
    };

    // Step 4: Bob scans and finds his stealth address
    const found = scanAnnouncements(
      bobKeys.viewPrivKey,
      bobKeys.metaAddress.spendPubKey,
      [announcement]
    );

    expect(found).toHaveLength(1);
    expect(found[0].address).toBe(derivation.stealthAddress);

    // Step 5: Bob recovers private key
    const stealthPrivKey = recoverStealthPrivateKey(
      bobKeys.spendPrivKey,
      bobKeys.viewPrivKey,
      derivation.ephemeralPubKey
    );

    // Step 6: Verify private key corresponds to public key
    const recoveredPubKey = scalarMultBase(stealthPrivKey);
    expect(bytesToHex(recoveredPubKey)).toBe(bytesToHex(derivation.stealthPubKey));
    expect(bytesToHex(recoveredPubKey)).toBe(bytesToHex(found[0].publicKey));

    // Step 7: Verify signature capability using raw-scalar signing
    // Standard ed25519.sign() hashes the seed, but stealth keys are raw scalars.
    // signWithStealthKey() signs directly with the raw scalar.
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const signature = signWithStealthKey(message, stealthPrivKey);

    // Verify against the stealth public key (raw scalar * G)
    const isValid = ed25519.verify(signature, message, recoveredPubKey);
    expect(isValid).toBe(true);
  });

  it('should handle multiple senders to same receiver', () => {
    const bobKeys = generateMetaAddress();
    const announcements: Announcement[] = [];

    // Multiple senders (Alice, Charlie, Dave) send to Bob
    const senderCount = 3;
    const expectedAddresses = new Set<string>();

    for (let i = 0; i < senderCount; i++) {
      const derivation = deriveStealthAddress(bobKeys.metaAddress);
      announcements.push({
        ephemeralPubKey: derivation.ephemeralPubKey,
        viewTag: derivation.viewTag,
        stealthAddress: derivation.stealthAddress,
      });
      expectedAddresses.add(derivation.stealthAddress);
    }

    // Bob scans and finds all his addresses
    const found = scanAnnouncements(
      bobKeys.viewPrivKey,
      bobKeys.metaAddress.spendPubKey,
      announcements
    );

    expect(found).toHaveLength(senderCount);

    // Verify all addresses were found
    for (const stealthAddr of found) {
      expect(expectedAddresses.has(stealthAddr.address)).toBe(true);

      // Find corresponding announcement
      const announcement = announcements.find(
        (a) => a.stealthAddress === stealthAddr.address
      );
      expect(announcement).toBeDefined();

      // Recover and verify private key
      const stealthPrivKey = recoverStealthPrivateKey(
        bobKeys.spendPrivKey,
        bobKeys.viewPrivKey,
        announcement!.ephemeralPubKey
      );

      const recoveredPubKey = scalarMultBase(stealthPrivKey);
      expect(bytesToHex(recoveredPubKey)).toBe(bytesToHex(stealthAddr.publicKey));
    }
  });

  it('should maintain privacy between different receivers', () => {
    const aliceKeys = generateMetaAddress();
    const bobKeys = generateMetaAddress();
    const charlieKeys = generateMetaAddress();

    const announcements: Announcement[] = [];

    // Create stealth addresses for each receiver
    const aliceStealth = deriveStealthAddress(aliceKeys.metaAddress);
    announcements.push({
      ephemeralPubKey: aliceStealth.ephemeralPubKey,
      viewTag: aliceStealth.viewTag,
      stealthAddress: aliceStealth.stealthAddress,
    });

    const bobStealth = deriveStealthAddress(bobKeys.metaAddress);
    announcements.push({
      ephemeralPubKey: bobStealth.ephemeralPubKey,
      viewTag: bobStealth.viewTag,
      stealthAddress: bobStealth.stealthAddress,
    });

    const charlieStealth = deriveStealthAddress(charlieKeys.metaAddress);
    announcements.push({
      ephemeralPubKey: charlieStealth.ephemeralPubKey,
      viewTag: charlieStealth.viewTag,
      stealthAddress: charlieStealth.stealthAddress,
    });

    // Each receiver scans and finds only their own address
    const aliceFound = scanAnnouncements(
      aliceKeys.viewPrivKey,
      aliceKeys.metaAddress.spendPubKey,
      announcements
    );
    expect(aliceFound).toHaveLength(1);
    expect(aliceFound[0].address).toBe(aliceStealth.stealthAddress);

    const bobFound = scanAnnouncements(
      bobKeys.viewPrivKey,
      bobKeys.metaAddress.spendPubKey,
      announcements
    );
    expect(bobFound).toHaveLength(1);
    expect(bobFound[0].address).toBe(bobStealth.stealthAddress);

    const charlieFound = scanAnnouncements(
      charlieKeys.viewPrivKey,
      charlieKeys.metaAddress.spendPubKey,
      announcements
    );
    expect(charlieFound).toHaveLength(1);
    expect(charlieFound[0].address).toBe(charlieStealth.stealthAddress);
  });
});