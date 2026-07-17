import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertNetwork, SUPPORTED_NETWORKS } from './network.js';

describe('assertNetwork (testnet-only; reject local/mainnet/unknown)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the supported network unchanged', () => {
    expect(assertNetwork('testnet')).toBe('testnet');
    expect(SUPPORTED_NETWORKS).toEqual(['testnet']);
  });

  it("rejects the removed 'local' network with the removal message", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    expect(() => assertNetwork('local')).toThrow(/exit:1/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const out = errorSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(/unsupported network 'local'/);
    expect(out).toMatch(/Supported: testnet/);
    expect(out).toMatch(/'local' has been removed/);
    expect(out).toMatch(/dev\/test runs on testnet/);
    expect(out).toMatch(/mainnet arrives after the external audit/);
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
    expect(out).toMatch(/Supported: testnet/);
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
