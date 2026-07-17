import { describe, it, expect, afterEach } from 'vitest';
import { collectRelay, resolveRelays, splitRelayList } from '../src/utils/relay.js';

const ORIGINAL_ENV = process.env.SHADE_RELAYERS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SHADE_RELAYERS;
  else process.env.SHADE_RELAYERS = ORIGINAL_ENV;
});

describe('splitRelayList / collectRelay', () => {
  it('splits on commas, trims, drops empties', () => {
    expect(splitRelayList('http://a.test, http://b.test ,,')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('accumulates repeated --relay flags, each possibly comma-joined', () => {
    // commander calls the accumulator once per flag occurrence.
    const first = collectRelay('http://a.test,http://b.test', undefined);
    const second = collectRelay('http://c.test', first);
    expect(second).toEqual(['http://a.test', 'http://b.test', 'http://c.test']);
  });
});

describe('resolveRelays precedence', () => {
  it('returns undefined when neither flag nor env is set', () => {
    delete process.env.SHADE_RELAYERS;
    expect(resolveRelays(undefined)).toBeUndefined();
    expect(resolveRelays([])).toBeUndefined();
  });

  it('uses the flag list when present', () => {
    delete process.env.SHADE_RELAYERS;
    expect(resolveRelays(['http://a.test'])).toEqual(['http://a.test']);
    // A raw string (programmatic caller) is comma-split too.
    expect(resolveRelays('http://a.test,http://b.test')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('falls back to comma-separated SHADE_RELAYERS', () => {
    process.env.SHADE_RELAYERS = 'http://a.test, http://b.test';
    expect(resolveRelays(undefined)).toEqual(['http://a.test', 'http://b.test']);
  });

  it('the flag beats the env var', () => {
    process.env.SHADE_RELAYERS = 'http://env.test';
    expect(resolveRelays(['http://flag.test'])).toEqual(['http://flag.test']);
  });

  it('an all-whitespace env resolves to undefined, not an empty pool', () => {
    process.env.SHADE_RELAYERS = ' , ';
    expect(resolveRelays(undefined)).toBeUndefined();
  });
});
