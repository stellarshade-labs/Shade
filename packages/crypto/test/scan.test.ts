import { describe, it, expect } from 'vitest';
import type { Announcement } from '../src/types.js';
import { generateMetaAddress } from '../src/keys.js';
import { deriveStealthAddress } from '../src/stealth.js';
import { scanAnnouncements, checkViewTag } from '../src/scan.js';

describe('scanning announcements', () => {
  it('should scan and find matching stealth addresses', () => {
    const bobKeys = generateMetaAddress();
    const announcements: Announcement[] = [];

    // Create 100 random announcements, 3 for Bob
    const bobStealthAddresses = new Set<string>();

    for (let i = 0; i < 100; i++) {
      if (i === 10 || i === 50 || i === 80) {
        // Create announcement for Bob
        const derivation = deriveStealthAddress(bobKeys.metaAddress);
        announcements.push({
          ephemeralPubKey: derivation.ephemeralPubKey,
          viewTag: derivation.viewTag,
          stealthAddress: derivation.stealthAddress,
        });
        bobStealthAddresses.add(derivation.stealthAddress);
      } else {
        // Create announcement for random receiver
        const randomKeys = generateMetaAddress();
        const derivation = deriveStealthAddress(randomKeys.metaAddress);
        announcements.push({
          ephemeralPubKey: derivation.ephemeralPubKey,
          viewTag: derivation.viewTag,
          stealthAddress: derivation.stealthAddress,
        });
      }
    }

    // Bob scans announcements
    const found = scanAnnouncements(
      bobKeys.viewPrivKey,
      bobKeys.metaAddress.spendPubKey,
      announcements
    );

    // Should find exactly 3 addresses
    expect(found).toHaveLength(3);

    // All found addresses should be Bob's
    for (const stealthAddr of found) {
      expect(bobStealthAddresses.has(stealthAddr.address)).toBe(true);
    }
  });

  it('should use view tag for fast filtering', () => {
    const bobKeys = generateMetaAddress();
    const derivation = deriveStealthAddress(bobKeys.metaAddress);

    // Check correct view tag
    const correctTag = checkViewTag(
      bobKeys.viewPrivKey,
      derivation.ephemeralPubKey,
      derivation.viewTag
    );
    expect(correctTag).toBe(true);

    // Check wrong view tag
    const wrongTag = checkViewTag(
      bobKeys.viewPrivKey,
      derivation.ephemeralPubKey,
      (derivation.viewTag + 1) % 256
    );
    expect(wrongTag).toBe(false);
  });

  it('should handle empty announcement list', () => {
    const keys = generateMetaAddress();
    const found = scanAnnouncements(
      keys.viewPrivKey,
      keys.metaAddress.spendPubKey,
      []
    );
    expect(found).toHaveLength(0);
  });

  it('should not find addresses when scanning with wrong keys', () => {
    const aliceKeys = generateMetaAddress();
    const bobKeys = generateMetaAddress();

    // Create announcements for Alice
    const announcements: Announcement[] = [];
    for (let i = 0; i < 5; i++) {
      const derivation = deriveStealthAddress(aliceKeys.metaAddress);
      announcements.push({
        ephemeralPubKey: derivation.ephemeralPubKey,
        viewTag: derivation.viewTag,
        stealthAddress: derivation.stealthAddress,
      });
    }

    // Bob scans but should find nothing
    const found = scanAnnouncements(
      bobKeys.viewPrivKey,
      bobKeys.metaAddress.spendPubKey,
      announcements
    );

    expect(found).toHaveLength(0);
  });

  it('should reject invalid input lengths', () => {
    const keys = generateMetaAddress();
    const announcement: Announcement = {
      ephemeralPubKey: new Uint8Array(32),
      viewTag: 0,
      stealthAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };

    // Invalid view private key
    expect(() =>
      scanAnnouncements(new Uint8Array(31), keys.metaAddress.spendPubKey, [announcement])
    ).toThrow('Invalid view private key length');

    // Invalid spend public key
    expect(() =>
      scanAnnouncements(keys.viewPrivKey, new Uint8Array(31), [announcement])
    ).toThrow('Invalid spend public key length');
  });
});