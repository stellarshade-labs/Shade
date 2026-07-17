import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import RateLimiter from './rateLimit.js';

/** A minimal Express request double (direct connection unless overridden). */
function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    ip: '127.0.0.1',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

// Snapshot the proxy-trust env once so every test starts from (and afterEach
// restores) the runner's real environment.
const SAVED_ENV: ReadonlyArray<readonly [string, string | undefined]> = [
  ['TRUST_PROXY_HOPS', process.env.TRUST_PROXY_HOPS],
  ['TRUST_PROXY', process.env.TRUST_PROXY],
];

describe('RateLimiter (indexer)', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of SAVED_ENV) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('allows `capacity` requests then denies with 429 + Retry-After', () => {
    const limiter = new RateLimiter(3, 3, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      middleware(makeReq(), res, next);
      expect(res.status).not.toHaveBeenCalled();
    }
    expect(next).toHaveBeenCalledTimes(3);

    const denied = makeRes();
    middleware(makeReq(), denied, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(denied.status).toHaveBeenCalledWith(429);
    expect(denied.set).toHaveBeenCalledWith('Retry-After', '60');
    expect(denied.json).toHaveBeenCalledWith({
      error: 'Rate limit exceeded',
      retryAfter: 60,
    });
  });

  it('refills after the interval and restores service', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const limiter = new RateLimiter(2, 2, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    middleware(makeReq(), makeRes(), next);
    middleware(makeReq(), makeRes(), next);
    const denied = makeRes();
    middleware(makeReq(), denied, next);
    expect(denied.status).toHaveBeenCalledWith(429);
    expect(next).toHaveBeenCalledTimes(2);

    // One full refill interval later the bucket is topped back up.
    vi.setSystemTime(new Date('2026-07-17T00:01:00.000Z'));
    const allowed = makeRes();
    middleware(makeReq(), allowed, next);
    expect(allowed.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('ignores X-Forwarded-For when no proxy hops are trusted (one bucket)', () => {
    delete process.env.TRUST_PROXY_HOPS;
    delete process.env.TRUST_PROXY;
    const limiter = new RateLimiter(2, 2, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    // Varying the (forgeable) header must NOT mint fresh buckets: all three
    // requests come from the same direct IP and share one bucket.
    for (let i = 0; i < 2; i++) {
      middleware(
        makeReq({ headers: { 'x-forwarded-for': `10.0.0.${i}` } }),
        makeRes(),
        next,
      );
    }
    const denied = makeRes();
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '10.0.0.99' } }),
      denied,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
    expect(denied.status).toHaveBeenCalledWith(429);
  });

  it('uses the rightmost XFF entry with TRUST_PROXY_HOPS=1 (distinct buckets)', () => {
    process.env.TRUST_PROXY_HOPS = '1';
    delete process.env.TRUST_PROXY;
    const limiter = new RateLimiter(1, 1, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    // Same direct connection; different rightmost (proxy-appended) entries →
    // separate buckets, so both pass despite capacity 1.
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.1' } }),
      makeRes(),
      next,
    );
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.2' } }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);

    // The same rightmost entry shares its bucket no matter what the client
    // forges on the left.
    const denied = makeRes();
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.1' } }),
      denied,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
    expect(denied.status).toHaveBeenCalledWith(429);
  });

  it('reset() clears buckets and restores service', () => {
    const limiter = new RateLimiter(1, 1, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    middleware(makeReq(), makeRes(), next);
    const denied = makeRes();
    middleware(makeReq(), denied, next);
    expect(denied.status).toHaveBeenCalledWith(429);

    limiter.reset();

    const allowed = makeRes();
    middleware(makeReq(), allowed, next);
    expect(allowed.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('Retry-After reports the REMAINING wait, not the full interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    const limiter = new RateLimiter(1, 1, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    middleware(makeReq(), makeRes(), next);

    // 45s into the interval the bucket refills in 15s — the header must say
    // 15, not 60 (compliant clients would otherwise back off ~4x too long).
    vi.setSystemTime(new Date('2026-07-17T00:00:45.000Z'));
    const denied = makeRes();
    middleware(makeReq(), denied, next);
    expect(denied.status).toHaveBeenCalledWith(429);
    expect(denied.set).toHaveBeenCalledWith('Retry-After', '15');
    expect(denied.json).toHaveBeenCalledWith({
      error: 'Rate limit exceeded',
      retryAfter: 15,
    });
  });

  it('a non-IP XFF entry with trusted hops falls back to the socket address (no attacker-chosen bucket keys)', () => {
    process.env.TRUST_PROXY_HOPS = '1';
    delete process.env.TRUST_PROXY;
    const limiter = new RateLimiter(2, 2, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    // Junk entries (each would be a distinct, unbounded-size key if honored)
    // must all collapse into the direct-connection bucket.
    middleware(
      makeReq({ headers: { 'x-forwarded-for': 'not-an-ip-'.repeat(50) } }),
      makeRes(),
      next,
    );
    middleware(
      makeReq({ headers: { 'x-forwarded-for': 'different junk' } }),
      makeRes(),
      next,
    );
    const denied = makeRes();
    middleware(
      makeReq({ headers: { 'x-forwarded-for': 'third junk value' } }),
      denied,
      next,
    );
    expect(next).toHaveBeenCalledTimes(2);
    expect(denied.status).toHaveBeenCalledWith(429);
  });

  it('beyond the bucket cap, unseen clients share one overflow bucket; seen clients keep their own', () => {
    process.env.TRUST_PROXY_HOPS = '1';
    delete process.env.TRUST_PROXY;
    const limiter = new RateLimiter(2, 2, 60_000);
    const middleware = limiter.middleware();
    const next: NextFunction = vi.fn();

    // Fill the map to MAX_TRACKED_BUCKETS with distinct (valid-IP) clients.
    for (let i = 0; i < 10_000; i++) {
      const ip = `10.${(i >> 8) & 255}.${i & 255}.${100 + (i >> 16)}`;
      middleware(makeReq({ headers: { 'x-forwarded-for': ip } }), makeRes(), next);
    }

    // Two UNSEEN clients now share the single overflow bucket…
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '172.16.0.1' } }),
      makeRes(),
      next,
    );
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '172.16.0.2' } }),
      makeRes(),
      next,
    );
    const denied = makeRes();
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '172.16.0.3' } }),
      denied,
      next,
    );
    expect(denied.status).toHaveBeenCalledWith(429);

    // …while an already-tracked client still draws from its own bucket.
    const seen = makeRes();
    middleware(
      makeReq({ headers: { 'x-forwarded-for': '10.0.0.100' } }),
      seen,
      next,
    );
    expect(seen.status).not.toHaveBeenCalled();
  });
});
