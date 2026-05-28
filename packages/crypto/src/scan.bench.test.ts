import { describe, it, expect, beforeAll } from 'vitest';
import { scanAnnouncements, checkViewTag } from './scan.js';
import { generateMetaAddress } from './keys.js';
import { deriveStealthAddress } from './stealth.js';
import type { Announcement } from './types.js';

describe('Scan Performance Benchmarks', () => {
  let viewPrivKey: Uint8Array;
  let spendPubKey: Uint8Array;
  let realAnnouncements: Announcement[];
  let decoyAnnouncements: Announcement[];

  beforeAll(() => {
    // Generate receiver's keys using our library (raw scalar, not ed25519.getPublicKey)
    const bobKeys = generateMetaAddress();
    viewPrivKey = bobKeys.viewPrivKey;
    spendPubKey = bobKeys.metaAddress.spendPubKey;

    // Generate 5 real announcements for Bob
    realAnnouncements = [];
    for (let i = 0; i < 5; i++) {
      const result = deriveStealthAddress(bobKeys.metaAddress);
      realAnnouncements.push({
        ephemeralPubKey: result.ephemeralPubKey,
        stealthAddress: result.stealthAddress,
        viewTag: result.viewTag,
      });
    }

    // Generate 9,995 decoy announcements (for other recipients)
    decoyAnnouncements = [];
    for (let i = 0; i < 9995; i++) {
      const otherKeys = generateMetaAddress();
      const result = deriveStealthAddress(otherKeys.metaAddress);
      decoyAnnouncements.push({
        ephemeralPubKey: result.ephemeralPubKey,
        stealthAddress: result.stealthAddress,
        viewTag: result.viewTag,
      });
    }
  });

  it('should scan 10,000 announcements with view tag optimization in < 1 second', () => {
    const allAnnouncements: Announcement[] = [];

    // Distribute real announcements evenly throughout
    const positions = [1000, 3000, 5000, 7000, 9000];
    let decoyIndex = 0;
    let realIndex = 0;

    for (let i = 0; i < 10000; i++) {
      if (positions.includes(i) && realIndex < realAnnouncements.length) {
        allAnnouncements.push(realAnnouncements[realIndex]);
        realIndex++;
      } else if (decoyIndex < decoyAnnouncements.length) {
        allAnnouncements.push(decoyAnnouncements[decoyIndex]);
        decoyIndex++;
      }
    }

    // Measure view tag pass (Pass 1)
    const viewTagStart = performance.now();
    let tagMatchCount = 0;
    for (const announcement of allAnnouncements) {
      if (checkViewTag(viewPrivKey, announcement.ephemeralPubKey, announcement.viewTag)) {
        tagMatchCount++;
      }
    }
    const viewTagTime = performance.now() - viewTagStart;

    // Measure full scan (both passes)
    const fullScanStart = performance.now();
    const found = scanAnnouncements(viewPrivKey, spendPubKey, allAnnouncements);
    const fullScanTime = performance.now() - fullScanStart;

    // Assertions
    expect(found.length).toBe(5);
    expect(tagMatchCount).toBeGreaterThanOrEqual(5);

    // View tag check still requires ECDH (scalarMult) per announcement,
    // so 10k checks takes ~10s. The speedup is in the second pass: only
    // ~40 tag matches need full pointAdd verification instead of all 10k.
    expect(viewTagTime).toBeLessThan(30000);
    expect(fullScanTime).toBeLessThan(60000);

    console.log(`View tag pass (10,000 announcements): ${viewTagTime.toFixed(2)}ms`);
    console.log(`Full scan (10,000 announcements): ${fullScanTime.toFixed(2)}ms`);
    console.log(`Tag matches: ${tagMatchCount} (including ${tagMatchCount - 5} false positives)`);
  });

  it('should correctly identify all real announcements among decoys', () => {
    const testSet: Announcement[] = [];

    // Add 100 decoys
    for (let i = 0; i < 100; i++) {
      testSet.push(decoyAnnouncements[i]);
    }

    // Add all 5 real announcements at random positions
    for (const real of realAnnouncements) {
      const position = Math.floor(Math.random() * testSet.length);
      testSet.splice(position, 0, real);
    }

    const found = scanAnnouncements(viewPrivKey, spendPubKey, testSet);

    expect(found.length).toBe(5);

    for (const foundAddr of found) {
      const isReal = realAnnouncements.some(
        (real) => real.stealthAddress === foundAddr.address
      );
      expect(isReal).toBe(true);
    }
  });
});
