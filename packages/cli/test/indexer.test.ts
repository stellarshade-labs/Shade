import { describe, it, expect, afterEach } from 'vitest';
import { resolveIndexer } from '../src/utils/indexer.js';

const ORIGINAL_ENV = process.env.SHADE_INDEXER;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SHADE_INDEXER;
  else process.env.SHADE_INDEXER = ORIGINAL_ENV;
});

describe('resolveIndexer precedence', () => {
  it('returns undefined when neither flag nor env is set', () => {
    delete process.env.SHADE_INDEXER;
    expect(resolveIndexer(undefined)).toBeUndefined();
    expect(resolveIndexer('')).toBeUndefined();
  });

  it('uses the flag when present, trimmed', () => {
    delete process.env.SHADE_INDEXER;
    expect(resolveIndexer(' http://indexer.test ')).toBe('http://indexer.test');
  });

  it('falls back to SHADE_INDEXER, trimmed', () => {
    process.env.SHADE_INDEXER = ' http://env.test ';
    expect(resolveIndexer(undefined)).toBe('http://env.test');
  });

  it('the flag beats the env var', () => {
    process.env.SHADE_INDEXER = 'http://env.test';
    expect(resolveIndexer('http://flag.test')).toBe('http://flag.test');
  });

  it('a whitespace flag falls through to the env var', () => {
    process.env.SHADE_INDEXER = 'http://env.test';
    expect(resolveIndexer('   ')).toBe('http://env.test');
  });

  it('an all-whitespace env resolves to undefined, not an empty URL', () => {
    process.env.SHADE_INDEXER = '   ';
    expect(resolveIndexer(undefined)).toBeUndefined();
  });
});
