import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/curves/abstract/utils';
import {
  validatePoint,
  scalarMult,
  scalarMultBase,
  pointAdd,
  scalarAdd,
  L,
} from '../src/ed25519.js';
import {
  generateMetaAddress,
  encodeMetaAddress,
  decodeMetaAddress,
} from '../src/keys.js';
import { scanAnnouncements } from '../src/scan.js';
import { InvalidPublicKey, InvalidScalar, InvalidMetaAddress } from '../src/errors.js';
import { numberToBytesLE } from '@noble/curves/abstract/utils';

/**
 * The 8 small-order (torsion) points of ed25519. The first is the identity
 * (point at infinity); the remaining 7 are the non-identity small-order points.
 * All are on-curve but NOT in the prime-order subgroup.
 */
const SMALL_ORDER_POINTS_HEX = [
  '0100000000000000000000000000000000000000000000000000000000000000', // identity
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
];

describe('validatePoint — small-order (torsion) rejection', () => {
  it('rejects all 8 small-order points including the identity', () => {
    for (const hex of SMALL_ORDER_POINTS_HEX) {
      const point = hexToBytes(hex);
      expect(() => validatePoint(point)).toThrow(InvalidPublicKey);
    }
  });

  it('accepts valid prime-order public keys', () => {
    for (let i = 0; i < 5; i++) {
      const keys = generateMetaAddress();
      expect(validatePoint(keys.metaAddress.spendPubKey)).toBe(true);
      expect(validatePoint(keys.metaAddress.viewPubKey)).toBe(true);
    }
  });

  it('rejects small-order points through scalarMult', () => {
    const scalar = generateMetaAddress().spendPrivKey;
    for (const hex of SMALL_ORDER_POINTS_HEX) {
      const point = hexToBytes(hex);
      expect(() => scalarMult(scalar, point)).toThrow(InvalidPublicKey);
    }
  });

  it('rejects small-order points through pointAdd', () => {
    const valid = generateMetaAddress().metaAddress.spendPubKey;
    for (const hex of SMALL_ORDER_POINTS_HEX) {
      const point = hexToBytes(hex);
      expect(() => pointAdd(valid, point)).toThrow(InvalidPublicKey);
    }
  });
});

describe('scanAnnouncements — small-order R is skipped, not thrown', () => {
  it('skips an announcement carrying a small-order ephemeral key without throwing', () => {
    const bob = generateMetaAddress();

    // Announcements with small-order R values (all 8, including identity).
    const announcements = SMALL_ORDER_POINTS_HEX.map((hex) => ({
      ephemeralPubKey: hexToBytes(hex),
      viewTag: 0,
      stealthAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5',
    }));

    let result: ReturnType<typeof scanAnnouncements> = [];
    expect(() => {
      result = scanAnnouncements(
        bob.viewPrivKey,
        bob.metaAddress.spendPubKey,
        announcements
      );
    }).not.toThrow();
    expect(result).toHaveLength(0);
  });
});

describe('scalarAdd — zero-result guard', () => {
  it('throws InvalidScalar when the sum reduces to zero (a + (L - a))', () => {
    // a = 5, b = L - 5, so (a + b) mod L === 0.
    const a = numberToBytesLE(5n, 32);
    const b = numberToBytesLE(L - 5n, 32);
    expect(() => scalarAdd(a, b)).toThrow(InvalidScalar);
  });

  it('throws when both inputs are zero', () => {
    const zero = new Uint8Array(32);
    expect(() => scalarAdd(zero, zero)).toThrow(InvalidScalar);
  });

  it('returns a valid non-zero result for ordinary inputs', () => {
    const a = numberToBytesLE(3n, 32);
    const b = numberToBytesLE(4n, 32);
    const sum = scalarAdd(a, b);
    expect(sum).toEqual(numberToBytesLE(7n, 32));
  });
});

describe('decodeMetaAddress — strict hex validation', () => {
  it('round-trips a valid encoded meta-address', () => {
    const keys = generateMetaAddress();
    const encoded = encodeMetaAddress(keys.metaAddress);
    const decoded = decodeMetaAddress(encoded);
    expect(decoded.spendPubKey).toEqual(keys.metaAddress.spendPubKey);
    expect(decoded.viewPubKey).toEqual(keys.metaAddress.viewPubKey);
  });

  it('rejects a malformed hex nibble instead of partial-parsing it', () => {
    const keys = generateMetaAddress();
    const encoded = encodeMetaAddress(keys.metaAddress);
    // Corrupt one hex character with a non-hex symbol, preserving length.
    const corrupted = encoded.slice(0, -1) + 'g';
    expect(() => decodeMetaAddress(corrupted)).toThrow(InvalidMetaAddress);
  });

  it('rejects whitespace inside the hex payload', () => {
    const keys = generateMetaAddress();
    const encoded = encodeMetaAddress(keys.metaAddress);
    const corrupted = encoded.slice(0, 20) + ' ' + encoded.slice(21);
    expect(() => decodeMetaAddress(corrupted)).toThrow(InvalidMetaAddress);
  });
});
