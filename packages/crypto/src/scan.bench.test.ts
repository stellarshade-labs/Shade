import { describe, it, expect, beforeAll } from 'vitest';
import { scanAnnouncements, checkViewTag } from './scan.js';
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { computeStealthAddress } from './stealth.js';
import type { Announcement } from './types.js';

describe('Scan Performance Benchmarks', () => {
  let viewPrivKey: Uint8Array;
  let spendPubKey: Uint8Array;
  let viewPubKey: Uint8Array;
  let realAnnouncements: Announcement[];
  let decoyAnnouncements: Announcement[];

  beforeAll(() => {
    // Generate receiver's keys
    const viewPrivKeyRaw = randomBytes(32);
    const spendPrivKeyRaw = randomBytes(32);
    viewPrivKey = viewPrivKeyRaw;
    viewPubKey = ed25519.getPublicKey(viewPrivKeyRaw);
    spendPubKey = ed25519.getPublicKey(spendPrivKeyRaw);

    // Generate 5 real announcements
    realAnnouncements = [];
    for (let i = 0; i < 5; i++) {
      const result = computeStealthAddress(spendPubKey, viewPubKey);
      realAnnouncements.push({
        ephemeralPubKey: result.ephemeralPubKey,
        stealthAddress: result.stealthAddress,
        viewTag: result.viewTag,
      });
    }

    // Generate 9,995 decoy announcements (non-matching)
    decoyAnnouncements = [];
    for (let i = 0; i < 9995; i++) {
      // Use random keys to ensure they won't match
      const randomViewPrivKey = randomBytes(32);
      const randomSpendPrivKey = randomBytes(32);
      const randomViewPubKey = ed25519.getPublicKey(randomViewPrivKey);
      const randomSpendPubKey = ed25519.getPublicKey(randomSpendPrivKey);
      const result = computeStealthAddress(randomSpendPubKey, randomViewPubKey);
      decoyAnnouncements.push({
        ephemeralPubKey: result.ephemeralPubKey,
        stealthAddress: result.stealthAddress,
        viewTag: result.viewTag,
      });
    }
  });

  it('should scan 10,000 announcements with view tag optimization in < 1 second', () => {
    // Mix real and decoy announcements
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
    expect(found.length).toBe(5); // Should find all 5 real announcements
    expect(tagMatchCount).toBeGreaterThanOrEqual(5); // At least 5 matches (might have false positives)

    // View tag pass should be under 1 second (typically much faster)
    expect(viewTagTime).toBeLessThan(1000);

    // Full scan should still be reasonably fast
    expect(fullScanTime).toBeLessThan(5000);

    // Log performance metrics
    console.log(`View tag pass (10,000 announcements): ${viewTagTime.toFixed(2)}ms`);
    console.log(`Full scan (10,000 announcements): ${fullScanTime.toFixed(2)}ms`);
    console.log(`Tag matches: ${tagMatchCount} (including ${tagMatchCount - 5} false positives)`);
    console.log(`Speedup factor: ${(fullScanTime / viewTagTime).toFixed(1)}x`);
  });

  it('should correctly identify all real announcements among decoys', () => {
    // Create a smaller test set for correctness verification
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

    // Scan and verify
    const found = scanAnnouncements(viewPrivKey, spendPubKey, testSet);

    // Should find exactly 5
    expect(found.length).toBe(5);

    // Verify all found addresses match real announcements
    for (const foundAddr of found) {
      const isReal = realAnnouncements.some(
        (real) => real.stealthAddress === foundAddr.address
      );
      expect(isReal).toBe(true);
    }
  });
});