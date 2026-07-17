import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { RedisRateLimitStore } from './rateLimitRedis.js';

/**
 * Live Redis integration for {@link RedisRateLimitStore}. Skips cleanly when
 * TEST_REDIS_URL is unset (the shared harness pattern — `npm test` stays green
 * without Docker). Each test uses a unique clientId so buckets never collide,
 * and the production key layout (`shade:rl:<clientId>`) is exercised verbatim.
 */
const REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)('RedisRateLimitStore (live)', () => {
  let redis: Redis;
  // Namespace this test run so leftover keys from a prior run cannot interfere.
  const run = `t${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let seq = 0;
  // clientIds minted per test, torn down in afterEach.
  const minted: string[] = [];

  /** A fresh clientId whose bucket key is unique to this test. */
  function newClient(): string {
    const id = `${run}-${seq++}`;
    minted.push(id);
    return id;
  }

  /** The Redis key the store uses for a given clientId (must match impl). */
  function keyFor(clientId: string): string {
    return `shade:rl:${clientId}`;
  }

  /** Redis server time in ms — the same clock the Lua script reads. */
  async function serverNowMs(): Promise<number> {
    const t = await redis.time();
    return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
  }

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    if (minted.length > 0) {
      await redis.del(...minted.map(keyFor));
      minted.length = 0;
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('allows a full burst up to capacity, then denies', async () => {
    const store = new RedisRateLimitStore(redis, {
      capacity: 5,
      refillTokens: 5,
      refillIntervalMs: 60000,
    });
    const client = newClient();

    for (let i = 0; i < 5; i++) {
      const decision = await store.take(client);
      expect(decision.allowed).toBe(true);
    }
    // The 6th request has no tokens left.
    const denied = await store.take(client);
    expect(denied.allowed).toBe(false);
  });

  it('deny does not decrement tokens below zero', async () => {
    const store = new RedisRateLimitStore(redis, {
      capacity: 3,
      refillTokens: 3,
      refillIntervalMs: 60000,
    });
    const client = newClient();

    // Exhaust the bucket.
    for (let i = 0; i < 3; i++) {
      expect((await store.take(client)).allowed).toBe(true);
    }
    // Hammer the empty bucket several times.
    for (let i = 0; i < 5; i++) {
      expect((await store.take(client)).allowed).toBe(false);
    }
    // Tokens must be exactly 0 (a decrement-on-deny would drive it negative).
    const tokens = await redis.hget(keyFor(client), 't');
    expect(tokens).toBe('0');
  });

  it('reports retryAfterSec 0 on allow, and the REMAINING wait (not the full interval) on deny', async () => {
    const store = new RedisRateLimitStore(redis, {
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 45000,
    });
    const client = newClient();

    const allowed = await store.take(client);
    expect(allowed.allowed).toBe(true);
    expect(allowed.retryAfterSec).toBe(0);

    // Denied immediately after the take: (almost) the full interval remains.
    const denied = await store.take(client);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(45);

    // Backdate the refill stamp 30s: only ~15s remain — a compliant client
    // must not be told to wait the full 45.
    const r = Number(await redis.hget(keyFor(client), 'r'));
    await redis.hset(keyFor(client), 'r', String(r - 30000));
    const later = await store.take(client);
    expect(later.allowed).toBe(false);
    expect(later.retryAfterSec).toBeGreaterThanOrEqual(14);
    expect(later.retryAfterSec).toBeLessThanOrEqual(15);
  });

  it('rounds the remaining wait up to whole seconds', async () => {
    const store = new RedisRateLimitStore(redis, {
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 1500,
    });
    const client = newClient();
    expect((await store.take(client)).retryAfterSec).toBe(0);
    // Immediately denied: ~1500ms remain, reported as ceil → 2s.
    const denied = await store.take(client);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(2);
  });

  it('refills tokens after one interval elapses (backdated lastRefill)', async () => {
    const intervalMs = 60000;
    const store = new RedisRateLimitStore(redis, {
      capacity: 4,
      refillTokens: 4,
      refillIntervalMs: intervalMs,
    });
    const client = newClient();

    // Drain the bucket.
    for (let i = 0; i < 4; i++) {
      expect((await store.take(client)).allowed).toBe(true);
    }
    expect((await store.take(client)).allowed).toBe(false);

    // Backdate the stored lastRefill so the next take sees >= one interval passed.
    // (Uses server TIME as the reference clock, matching the Lua script.)
    const nowMs = await serverNowMs();
    await redis.hset(keyFor(client), 'r', (nowMs - intervalMs - 1000).toString());

    // One full refill returns the bucket to capacity; take() then consumes one.
    const afterRefill = await store.take(client);
    expect(afterRefill.allowed).toBe(true);
    const tokens = await redis.hget(keyFor(client), 't');
    expect(tokens).toBe('3'); // capacity 4, minus the one just taken
  });

  it('refills only a partial amount and caps at capacity', async () => {
    const intervalMs = 60000;
    const store = new RedisRateLimitStore(redis, {
      capacity: 10,
      refillTokens: 3, // 3 tokens per interval
      refillIntervalMs: intervalMs,
    });
    const client = newClient();

    // Drain fully.
    for (let i = 0; i < 10; i++) {
      expect((await store.take(client)).allowed).toBe(true);
    }
    // Backdate by exactly two intervals -> 2 * 3 = 6 tokens refilled.
    const nowMs = await serverNowMs();
    await redis.hset(keyFor(client), 'r', (nowMs - 2 * intervalMs).toString());

    // Next take refills 6, then consumes 1 -> 5 remaining.
    expect((await store.take(client)).allowed).toBe(true);
    expect(await redis.hget(keyFor(client), 't')).toBe('5');
  });

  it('refills via a real elapsed short interval', async () => {
    const store = new RedisRateLimitStore(redis, {
      capacity: 2,
      refillTokens: 2,
      refillIntervalMs: 200,
    });
    const client = newClient();

    expect((await store.take(client)).allowed).toBe(true);
    expect((await store.take(client)).allowed).toBe(true);
    expect((await store.take(client)).allowed).toBe(false);

    // Wait for a real refill interval to elapse (server clock).
    await new Promise((r) => setTimeout(r, 350));

    expect((await store.take(client)).allowed).toBe(true);
  });

  it('sets a bucket TTL so idle keys expire', async () => {
    const store = new RedisRateLimitStore(redis, { capacity: 2 });
    const client = newClient();
    await store.take(client);
    const ttl = await redis.pttl(keyFor(client));
    // PTTL is positive (key has an expiry) and within the 600s window.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600000);
  });

  it('two instances on one client share and jointly exhaust the bucket', async () => {
    const opts = { capacity: 6, refillTokens: 6, refillIntervalMs: 60000 };
    const a = new RedisRateLimitStore(redis, opts);
    const b = new RedisRateLimitStore(redis, opts);
    const client = newClient();

    // Alternate A/B; the SIX allowed tokens are drawn from one shared bucket.
    const decisions = [
      await a.take(client),
      await b.take(client),
      await a.take(client),
      await b.take(client),
      await a.take(client),
      await b.take(client),
    ];
    expect(decisions.every((d) => d.allowed)).toBe(true);

    // Both instances now see the bucket as empty.
    expect((await a.take(client)).allowed).toBe(false);
    expect((await b.take(client)).allowed).toBe(false);

    // Exactly capacity tokens were granted across both instances.
    expect(await redis.hget(keyFor(client), 't')).toBe('0');
  });

  it('two instances racing concurrent requests grant at most capacity', async () => {
    const opts = { capacity: 8, refillTokens: 8, refillIntervalMs: 60000 };
    const a = new RedisRateLimitStore(redis, opts);
    const b = new RedisRateLimitStore(redis, opts);
    const client = newClient();

    // Fire 20 concurrent takes split across the two instances.
    const takes: Promise<{ allowed: boolean }>[] = [];
    for (let i = 0; i < 20; i++) {
      takes.push((i % 2 === 0 ? a : b).take(client));
    }
    const results = await Promise.all(takes);
    const allowedCount = results.filter((r) => r.allowed).length;

    // Redis serializes the Lua script, so never more than capacity are allowed.
    expect(allowedCount).toBe(8);
    expect(await redis.hget(keyFor(client), 't')).toBe('0');
  });

  it('a separate clientId keeps an independent bucket', async () => {
    const store = new RedisRateLimitStore(redis, {
      capacity: 2,
      refillTokens: 2,
      refillIntervalMs: 60000,
    });
    const c1 = newClient();
    const c2 = newClient();

    // Drain c1.
    expect((await store.take(c1)).allowed).toBe(true);
    expect((await store.take(c1)).allowed).toBe(true);
    expect((await store.take(c1)).allowed).toBe(false);

    // c2 is untouched.
    expect((await store.take(c2)).allowed).toBe(true);
    expect((await store.take(c2)).allowed).toBe(true);
  });
});
