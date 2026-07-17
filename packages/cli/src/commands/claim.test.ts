import { describe, it, expect } from 'vitest';
import { numberToStroops } from '@shade/sdk';
import { parseClaimAmount } from './claim.js';

describe('claim --amount parsing (exact stroops, like send/withdraw)', () => {
  it('round-trips fractional amounts exactly through the stroops path', () => {
    // Each parsed number must re-derive the identical stroop count the SDK
    // computes internally (numberToStroops) — no float drift on the way in.
    for (const [input, stroops] of [
      ['0.1', 1000000n],
      ['1.2345678', 12345678n],
      ['0.000001', 10n], // one microlumen: smallest fixed-notation magnitude
      ['100', 1000000000n],
      ['2.5', 25000000n],
    ] as const) {
      const parsed = parseClaimAmount(input);
      expect(numberToStroops(parsed)).toBe(stroops);
    }
  });

  it('rejects amounts that cannot survive the SDK numeric round-trip', () => {
    // 1 stroop = 1e-7 whole units: Number#toString goes exponential below
    // 1e-6, which the SDK's numberToStroops refuses — reject it up front with
    // an actionable message instead of failing deep inside the claim.
    expect(() => parseClaimAmount('0.0000001')).toThrow(/cannot be represented exactly/);
  });

  it('rejects amounts with more than 7 decimal places (like send)', () => {
    expect(() => parseClaimAmount('0.12345678')).toThrow(/more than 7 decimal places/);
    expect(() => parseClaimAmount('1.00000001')).toThrow(/more than 7 decimal places/);
  });

  it('rejects non-numeric and negative input instead of parseFloat-ing it', () => {
    // parseFloat('1.5abc') would silently yield 1.5; parseStroops refuses.
    expect(() => parseClaimAmount('1.5abc')).toThrow(/Invalid amount/);
    expect(() => parseClaimAmount('abc')).toThrow(/Invalid amount/);
    expect(() => parseClaimAmount('-1')).toThrow(/Invalid amount/);
    expect(() => parseClaimAmount('1e3')).toThrow(/Invalid amount/);
  });
});
