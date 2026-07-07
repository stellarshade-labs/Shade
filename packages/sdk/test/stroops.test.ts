import { describe, it, expect } from 'vitest';
import { parseStroops, numberToStroops, formatStroops } from '../src/stroops.js';

describe('Fix #4: exact decimal <-> stroop conversion (no float drift)', () => {
  it('converts an amount above 2^53 stroops exactly (no drift)', () => {
    // 1,000,000,000 XLM = 1e16 stroops, well above Number.MAX_SAFE_INTEGER
    // (~9.007e15). A float round-trip would lose the low-order stroops.
    const amount = '1000000000.0000001';
    const stroops = parseStroops(amount);
    expect(stroops).toBe(10000000000000001n);
    expect(stroops > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // Round-trips back to the exact string.
    expect(formatStroops(stroops)).toBe('1000000000.0000001');
    // The lossy float path would collapse the trailing stroop; ours does not.
    expect(BigInt(Math.round(Number(amount) * 1e7))).not.toBe(stroops);
  });

  it('converts a full 7-decimal-place amount exactly', () => {
    expect(parseStroops('0.0000001')).toBe(1n);
    expect(parseStroops('1.2345678')).toBe(12345678n);
    expect(parseStroops('100')).toBe(1000000000n);
    expect(formatStroops(12345678n)).toBe('1.2345678');
    expect(formatStroops(1000000000n)).toBe('100.0000000');
  });

  it('rejects an amount with more than 7 fractional digits', () => {
    expect(() => parseStroops('1.00000001')).toThrow(/decimal places/);
    expect(() => numberToStroops(1.00000001)).toThrow(/decimal places/);
  });

  it('rejects non-numeric and negative input', () => {
    expect(() => parseStroops('abc')).toThrow();
    expect(() => parseStroops('-1')).toThrow();
    expect(() => parseStroops('1.2.3')).toThrow();
    expect(() => numberToStroops(-5)).toThrow();
    expect(() => numberToStroops(Number.NaN)).toThrow();
    expect(() => numberToStroops(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('numberToStroops matches parseStroops for representable numbers', () => {
    expect(numberToStroops(100)).toBe(parseStroops('100'));
    expect(numberToStroops(1.5001)).toBe(15001000n);
  });
});
