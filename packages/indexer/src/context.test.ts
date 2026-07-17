import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { assertSupportedNetwork, horizonUrlFor } from './context.js';
import { logger } from './utils/logger.js';

describe('boot hardening', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const savedHorizonUrl = process.env.HORIZON_URL;

  beforeEach(() => {
    // process.exit never returns; throw instead so the test can observe it
    // without killing the vitest worker.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.HORIZON_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHorizonUrl === undefined) delete process.env.HORIZON_URL;
    else process.env.HORIZON_URL = savedHorizonUrl;
  });

  describe('assertSupportedNetwork', () => {
    it("exits(1) on the removed 'local' network", () => {
      expect(() => assertSupportedNetwork('local')).toThrow('process.exit(1)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Unsupported NETWORK',
        expect.objectContaining({ network: 'local' }),
      );
    });

    it('exits(1) on any unknown network label', () => {
      expect(() => assertSupportedNetwork('standalone')).toThrow(
        'process.exit(1)',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("passes 'testnet' through unchanged", () => {
      expect(assertSupportedNetwork('testnet')).toBe('testnet');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('horizonUrlFor', () => {
    it('returns the table URL for testnet', () => {
      expect(horizonUrlFor('testnet')).toBe(
        'https://horizon-testnet.stellar.org',
      );
    });

    it('honors the HORIZON_URL env override first', () => {
      process.env.HORIZON_URL = 'http://localhost:8000';
      expect(horizonUrlFor('testnet')).toBe('http://localhost:8000');
    });

    it('throws on an unknown network when no override is set', () => {
      expect(() => horizonUrlFor('public')).toThrow('Unsupported network');
    });
  });
});
