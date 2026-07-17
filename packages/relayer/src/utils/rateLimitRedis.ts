import type { Redis } from 'ioredis';
import type { RateLimitStore, RateLimitDecision } from './rateLimit.js';

/**
 * Tunables for {@link RedisRateLimitStore}. Defaults match the in-process
 * {@link MemoryRateLimitStore}: a bucket of `capacity` tokens that refills
 * `refillTokens` tokens every `refillIntervalMs`.
 */
export interface RedisRateLimitOptions {
  /** Maximum tokens a bucket can hold. Default 10. */
  capacity?: number;
  /** Tokens added per refill interval. Default 10. */
  refillTokens?: number;
  /** Length of a refill interval in milliseconds. Default 60000. */
  refillIntervalMs?: number;
}

const DEFAULT_CAPACITY = 10;
const DEFAULT_REFILL_TOKENS = 10;
const DEFAULT_REFILL_INTERVAL_MS = 60000;

/** Key prefix for per-client token buckets. */
const KEY_PREFIX = 'shade:rl:';

/**
 * Idle bucket keys expire after this many ms of inactivity, replacing the
 * in-process {@link MemoryRateLimitStore} `cleanup()` sweep. Refreshed on every
 * `take()` so an active client's bucket never expires under it.
 */
const BUCKET_TTL_MS = 600000;

/**
 * Atomic read-refill-take, faithful to {@link MemoryRateLimitStore.take}. One
 * Lua script per request so refill + decrement happen under Redis's single-
 * threaded execution — correct across many relayer instances sharing one Redis.
 *
 * KEYS[1] = bucket key (`shade:rl:<clientId>`), a hash `{ t: tokens, r: lastRefillMs }`.
 * ARGV = [capacity, refillTokens, refillIntervalMs, ttlMs].
 *
 * `redis.call('TIME')` is the single clock source (Redis server time), so a
 * client-passed timestamp is never trusted. Returns `{ allowed(0|1), retryAfterSec }`.
 */
const TAKE_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillTokens = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Redis server time: { unix_seconds, microseconds } -> integer milliseconds.
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', key, 't', 'r')
local tokens
local last
if data[1] == false or data[1] == nil then
  tokens = capacity
  last = now
else
  tokens = tonumber(data[1])
  last = tonumber(data[2])
  local refills = math.floor((now - last) / interval)
  if refills > 0 then
    tokens = math.min(capacity, tokens + refills * refillTokens)
    last = now
  end
end

local allowed
local retryAfterSec = 0
if tokens <= 0 then
  -- Empty bucket: deny WITHOUT decrementing (matches MemoryRateLimitStore).
  -- Retry-After is the REAL remaining wait, not the full interval: the bucket
  -- refills at last + interval (the refill branch above did not fire, so that
  -- instant is in the future). Never below one second.
  allowed = 0
  retryAfterSec = math.max(1, math.ceil((last + interval - now) / 1000))
else
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 't', tokens, 'r', last)
redis.call('PEXPIRE', key, ttl)

return { allowed, retryAfterSec }
`;

/** Name under which the Lua script is registered on the ioredis client. */
const COMMAND_NAME = 'shadeRlTake';

/**
 * ioredis with our custom command attached. `defineCommand` mutates the client
 * at runtime; this type surfaces the added method for the call site.
 */
type RedisWithTake = Redis & {
  [COMMAND_NAME]: (
    key: string,
    capacity: number,
    refillTokens: number,
    refillIntervalMs: number,
    ttlMs: number,
  ) => Promise<[number, number]>;
};

/**
 * Redis-backed token-bucket {@link RateLimitStore}. Bucket state lives in Redis
 * (hash per client), so every relayer instance sharing one Redis enforces one
 * combined limit per client. Each {@link take} is a single atomic Lua round-trip.
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: RedisWithTake;
  private readonly capacity: number;
  private readonly refillTokens: number;
  private readonly refillIntervalMs: number;

  constructor(redis: Redis, opts: RedisRateLimitOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.refillTokens = opts.refillTokens ?? DEFAULT_REFILL_TOKENS;
    this.refillIntervalMs = opts.refillIntervalMs ?? DEFAULT_REFILL_INTERVAL_MS;

    // Register the script once per client (idempotent for our command name).
    const existing = (redis as unknown as Record<string, unknown>)[COMMAND_NAME];
    if (typeof existing !== 'function') {
      redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: TAKE_LUA });
    }
    this.redis = redis as RedisWithTake;
  }

  async take(clientId: string): Promise<RateLimitDecision> {
    const [allowed, retryAfterSec] = await this.redis[COMMAND_NAME](
      KEY_PREFIX + clientId,
      this.capacity,
      this.refillTokens,
      this.refillIntervalMs,
      BUCKET_TTL_MS,
    );
    return { allowed: allowed === 1, retryAfterSec };
  }
}
