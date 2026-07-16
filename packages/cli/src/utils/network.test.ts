import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertNetwork } from './network.js';

describe('assertNetwork (reject mainnet/unknown networks)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the supported networks unchanged', () => {
    expect(assertNetwork('local')).toBe('local');
    expect(assertNetwork('testnet')).toBe('testnet');
  });

  it("rejects 'mainnet' with an actionable error instead of silently using testnet", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    expect(() => assertNetwork('mainnet')).toThrow(/exit:1/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const out = errorSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(/unsupported network 'mainnet'/);
    expect(out).toMatch(/Supported: local, testnet/);
    expect(out).toMatch(/mainnet is not yet supported/);
    expect(out).toMatch(/unaudited/);
  });

  it('rejects arbitrary unknown values (no silent testnet fallback)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    expect(() => assertNetwork('futurenet')).toThrow(/exit:1/);
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/unsupported network 'futurenet'/);
  });
});
