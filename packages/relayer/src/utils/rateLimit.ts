import { Request, Response, NextFunction } from 'express';
import { isIP } from 'node:net';
import { logger } from './logger.js';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Hard cap on tracked in-memory buckets. Client ids are validated IPs, but an
 * attacker spoofing X-Forwarded-For (or rotating real addresses) can still
 * mint fresh ids per request; without a cap each one holds a Map entry until
 * the stale sweep — an OOM vector. Beyond the cap, UNSEEN clients share one
 * overflow bucket: flood traffic throttles collectively instead of growing
 * memory, at the price of fairness for new clients during an active flood.
 * (The Redis store bounds its keys with TTLs instead.)
 */
const MAX_TRACKED_BUCKETS = 10_000;
/** The shared bucket key used once MAX_TRACKED_BUCKETS is reached. */
const OVERFLOW_CLIENT_ID = ' overflow';

/** Outcome of attempting to take one token from a client's bucket. */
export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the client should wait before retrying (only meaningful when denied). */
  retryAfterSec: number;
}

/**
 * Token-bucket state behind the {@link RateLimiter} middleware. Async so a shared
 * backend (e.g. Redis) can implement the same contract across instances.
 * {@link MemoryRateLimitStore} is the default in-process implementation.
 */
export interface RateLimitStore {
  /**
   * Attempt to consume one token for `clientId`. Refills first, then either
   * denies WITHOUT decrementing (empty bucket) or takes one token.
   */
  take(clientId: string): Promise<RateLimitDecision>;
}

/**
 * In-memory token-bucket {@link RateLimitStore}. Each client gets a bucket of
 * `capacity` tokens that refills `refillRate` tokens every `refillInterval` ms.
 * Stale buckets (idle past a threshold) are periodically swept so the map cannot
 * grow without bound.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets: Map<string, TokenBucket> = new Map();
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;

  constructor(capacity = 10, refillRate = 10, refillInterval = 60000) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.refillInterval = refillInterval;

    setInterval(() => this.cleanup(), 300000);
  }

  private getBucket(clientId: string): TokenBucket {
    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(clientId, bucket);
      return bucket;
    }

    const timeSinceLastRefill = now - bucket.lastRefill;
    const refillsNeeded = Math.floor(timeSinceLastRefill / this.refillInterval);

    if (refillsNeeded > 0) {
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + refillsNeeded * this.refillRate
      );
      bucket.lastRefill = now;
    }

    return bucket;
  }

  async take(clientId: string): Promise<RateLimitDecision> {
    // Cardinality backstop: once the map is full, ids we have never seen
    // collapse into the shared overflow bucket instead of allocating.
    const key =
      this.buckets.has(clientId) || this.buckets.size < MAX_TRACKED_BUCKETS
        ? clientId
        : OVERFLOW_CLIENT_ID;
    const bucket = this.getBucket(key);
    if (bucket.tokens <= 0) {
      // The real remaining wait, not the full interval: the bucket refills at
      // lastRefill + refillInterval (getBucket just declined to refill, so
      // that instant is in the future). Never zero — a denied client always
      // waits at least a second.
      const waitMs = bucket.lastRefill + this.refillInterval - Date.now();
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    bucket.tokens--;
    return { allowed: true, retryAfterSec: 0 };
  }

  private cleanup() {
    const now = Date.now();
    const staleTime = 600000;

    for (const [clientId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > staleTime) {
        this.buckets.delete(clientId);
      }
    }
  }

  public reset(clientId?: string) {
    if (clientId) {
      this.buckets.delete(clientId);
    } else {
      this.buckets.clear();
    }
  }
}

class RateLimiter {
  private store: RateLimitStore;

  constructor(
    capacityOrStore: number | RateLimitStore = 10,
    refillRate = 10,
    refillInterval = 60000,
  ) {
    this.store =
      typeof capacityOrStore === 'number'
        ? new MemoryRateLimitStore(capacityOrStore, refillRate, refillInterval)
        : capacityOrStore;
  }

  /**
   * Swap the backing store after construction. The middleware is registered on
   * the Express app at module load (with the default in-memory store), but the
   * Redis-backed store can only be built once its connection is verified at
   * boot — so boot swaps it in before the server starts accepting requests.
   */
  public setStore(store: RateLimitStore): void {
    this.store = store;
  }

  private getClientId(req: Request): string {
    // Security: X-Forwarded-For is client-controllable. The LEFTMOST entries are
    // appended by the (untrusted) client and every untrusted hop, so trusting the
    // leftmost value lets an attacker mint a unique bucket per request by varying
    // the header — trivially bypassing the rate limiter.
    //
    // Only trust XFF when explicitly behind a proxy, and even then count trusted
    // hops from the RIGHT (the entries our own infra appended). TRUST_PROXY_HOPS
    // is the number of trusted reverse-proxies in front of us; we skip that many
    // trailing entries and take the next one — the rightmost value the client
    // could not forge. Legacy TRUST_PROXY=true keeps a single trusted hop.
    const hops = this.trustedProxyHops();
    if (hops > 0) {
      const forwarded = req.headers['x-forwarded-for'];
      const chain = Array.isArray(forwarded)
        ? forwarded.join(',')
        : (forwarded as string | undefined);
      if (chain) {
        const parts = chain
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        if (parts.length > 0) {
          // Count trusted hops from the RIGHT. Each trusted reverse-proxy appends
          // the IP of the host that connected to it, so the entry our own edge
          // proxy appended is the rightmost one — a value the client cannot forge.
          // With `hops` trusted proxies we skip the (hops-1) trailing entries our
          // internal proxies appended and take the next: index length-hops. If the
          // client forged extra LEFT entries they are ignored; if the client sent
          // fewer entries than trusted hops, clamp to the leftmost present entry.
          //
          // The selected entry is only honored when it parses as a bare IP.
          // When the origin is ALSO directly reachable (a misconfig with
          // TRUST_PROXY_HOPS set — the header is then client-forged), this
          // caps the damage: a non-IP value falls through to the socket
          // address rather than becoming an attacker-chosen bucket key of
          // unbounded size. Forged-but-valid IPs remain possible in that
          // misconfig — deployment docs require the origin port to be
          // reachable only via the proxy chain.
          const idx = Math.max(0, parts.length - hops);
          const candidate = parts[idx]!;
          if (isIP(candidate) !== 0) return candidate;
        }
      }
    }

    // Fall back to direct IP connection (safe default when not behind a proxy).
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  /**
   * Number of trusted reverse-proxy hops in front of this service, counted from
   * the right of the X-Forwarded-For chain. Zero (the default) means XFF is not
   * trusted at all. `TRUST_PROXY_HOPS` takes precedence; the legacy
   * `TRUST_PROXY=true` flag maps to a single trusted hop.
   */
  private trustedProxyHops(): number {
    const raw = process.env.TRUST_PROXY_HOPS;
    if (raw !== undefined && raw !== '') {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
      return 0;
    }
    return process.env.TRUST_PROXY === 'true' ? 1 : 0;
  }

  public middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const clientId = this.getClientId(req);
      let decision: RateLimitDecision;
      try {
        decision = await this.store.take(clientId);
      } catch (err) {
        // Fail closed: a shared (Redis) store that is unreachable must not let
        // requests through unthrottled — the rate limiter is a hot-wallet
        // protection, so availability yields to safety. The in-memory store
        // never rejects, so this only bites a Redis outage.
        logger.error('Rate limiter store error — failing closed', {
          error: (err as Error).message,
        });
        return res.status(503).json({
          error: 'Rate limiter temporarily unavailable',
          code: 'server_error',
        });
      }

      if (!decision.allowed) {
        const retryAfter = decision.retryAfterSec;
        res.set('Retry-After', retryAfter.toString());
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter
        });
      }

      return next();
    };
  }

  public reset(clientId?: string) {
    (this.store as { reset?: (clientId?: string) => void }).reset?.(clientId);
  }
}

export default RateLimiter;
