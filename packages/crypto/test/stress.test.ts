import { describe, it, expect, beforeAll } from 'vitest';
import { generateMetaAddress, deriveStealthAddress, encodeMetaAddress, decodeMetaAddress } from '../src/index.js';
import { bytesToHex } from '@noble/curves/abstract/utils';

describe('stress tests', () => {
  describe('sequential operations', () => {
    it('should handle 50 sequential send+announce cycles', () => {
      // Generate receiver's meta-address
      const receiver = generateMetaAddress();
      const encodedMeta = encodeMetaAddress(receiver.metaAddress);

      // Store all derived stealth addresses
      const stealthAddresses: Array<{
        address: string;
        ephemeralPubKey: Uint8Array;
        viewTag: number;
        stealthPubKey: Uint8Array;
      }> = [];

      // Generate 50 stealth addresses
      for (let i = 0; i < 50; i++) {
        const derivation = deriveStealthAddress(receiver.metaAddress);

        // Each should be unique
        const isDuplicate = stealthAddresses.some(
          (prev) => prev.address === derivation.stealthAddress
        );
        expect(isDuplicate).toBe(false);

        stealthAddresses.push({
          address: derivation.stealthAddress,
          ephemeralPubKey: derivation.ephemeralPubKey,
          viewTag: derivation.viewTag,
          stealthPubKey: derivation.stealthPubKey,
        });
      }

      // Verify we have 50 unique addresses
      const uniqueAddresses = new Set(stealthAddresses.map((s) => s.address));
      expect(uniqueAddresses.size).toBe(50);

      // Verify all ephemeral keys are different
      const uniqueEphemeralKeys = new Set(
        stealthAddresses.map((s) => bytesToHex(s.ephemeralPubKey))
      );
      expect(uniqueEphemeralKeys.size).toBe(50);

      // View tags should have reasonable distribution (not all the same)
      const uniqueViewTags = new Set(stealthAddresses.map((s) => s.viewTag));
      expect(uniqueViewTags.size).toBeGreaterThan(1);
    });

    it('should handle concurrent meta-address generation', () => {
      const metaAddresses = [];
      const encodedAddresses = [];

      // Generate 100 meta-addresses
      for (let i = 0; i < 100; i++) {
        const keys = generateMetaAddress();
        metaAddresses.push(keys);

        const encoded = encodeMetaAddress(keys.metaAddress);
        encodedAddresses.push(encoded);
      }

      // All should be unique
      const uniqueEncoded = new Set(encodedAddresses);
      expect(uniqueEncoded.size).toBe(100);

      // All should decode correctly
      for (let i = 0; i < 100; i++) {
        const decoded = decodeMetaAddress(encodedAddresses[i]);
        expect(bytesToHex(decoded.spendPubKey)).toBe(
          bytesToHex(metaAddresses[i].metaAddress.spendPubKey)
        );
        expect(bytesToHex(decoded.viewPubKey)).toBe(
          bytesToHex(metaAddresses[i].metaAddress.viewPubKey)
        );
      }
    });

    it('should handle rapid encode/decode cycles', () => {
      const keys = generateMetaAddress();

      // Perform 1000 encode/decode cycles
      for (let i = 0; i < 1000; i++) {
        const encoded = encodeMetaAddress(keys.metaAddress);
        const decoded = decodeMetaAddress(encoded);

        expect(bytesToHex(decoded.spendPubKey)).toBe(
          bytesToHex(keys.metaAddress.spendPubKey)
        );
        expect(bytesToHex(decoded.viewPubKey)).toBe(
          bytesToHex(keys.metaAddress.viewPubKey)
        );
      }
    });

    it('should handle mixed operations under load', () => {
      const receivers: Array<ReturnType<typeof generateMetaAddress>> = [];
      const derivations: Array<ReturnType<typeof deriveStealthAddress>> = [];

      // Generate 10 receivers
      for (let i = 0; i < 10; i++) {
        receivers.push(generateMetaAddress());
      }

      // Each receiver gets 10 stealth addresses
      for (const receiver of receivers) {
        for (let j = 0; j < 10; j++) {
          const derivation = deriveStealthAddress(receiver.metaAddress);
          derivations.push(derivation);
        }
      }

      // Total of 100 derivations
      expect(derivations.length).toBe(100);

      // All stealth addresses should be unique
      const uniqueStealthAddresses = new Set(
        derivations.map((d) => d.stealthAddress)
      );
      expect(uniqueStealthAddresses.size).toBe(100);

      // All ephemeral keys should be unique
      const uniqueEphemeralKeys = new Set(
        derivations.map((d) => bytesToHex(d.ephemeralPubKey))
      );
      expect(uniqueEphemeralKeys.size).toBe(100);
    });
  });

  describe('performance benchmarks', () => {
    it('should complete 50 derivations within reasonable time', () => {
      const receiver = generateMetaAddress();
      const start = Date.now();

      for (let i = 0; i < 50; i++) {
        deriveStealthAddress(receiver.metaAddress);
      }

      const elapsed = Date.now() - start;
      // Should complete within 500ms (10ms per derivation average)
      expect(elapsed).toBeLessThan(500);
    });

    it('should complete 100 meta-address generations within reasonable time', () => {
      const start = Date.now();

      for (let i = 0; i < 100; i++) {
        generateMetaAddress();
      }

      const elapsed = Date.now() - start;
      // Should complete within 1000ms (10ms per generation average)
      expect(elapsed).toBeLessThan(1000);
    });

    it('should handle edge case scalar values in derivations', () => {
      const receiver = generateMetaAddress();

      // Run multiple derivations to increase chance of edge cases
      const derivations = [];
      for (let i = 0; i < 100; i++) {
        const derivation = deriveStealthAddress(receiver.metaAddress);
        derivations.push(derivation);

        // Verify all fields are present and valid
        expect(derivation.stealthPubKey).toHaveLength(32);
        expect(derivation.ephemeralPubKey).toHaveLength(32);
        expect(derivation.stealthAddress).toMatch(/^G[A-Z0-9]+$/);
        expect(derivation.viewTag).toBeGreaterThanOrEqual(0);
        expect(derivation.viewTag).toBeLessThanOrEqual(255);
      }

      // All should be unique
      const uniqueAddresses = new Set(derivations.map((d) => d.stealthAddress));
      expect(uniqueAddresses.size).toBe(100);
    });
  });
});