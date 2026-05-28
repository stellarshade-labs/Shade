import { Request, Response, NextFunction } from 'express';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

class RateLimiter {
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

  private getClientId(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'] as string;
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
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

  private cleanup() {
    const now = Date.now();
    const staleTime = 600000;

    for (const [clientId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > staleTime) {
        this.buckets.delete(clientId);
      }
    }
  }

  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const clientId = this.getClientId(req);
      const bucket = this.getBucket(clientId);

      if (bucket.tokens <= 0) {
        const retryAfter = Math.ceil(this.refillInterval / 1000);
        res.set('Retry-After', retryAfter.toString());
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter
        });
      }

      bucket.tokens--;
      return next();
    };
  }

  public reset(clientId?: string) {
    if (clientId) {
      this.buckets.delete(clientId);
    } else {
      this.buckets.clear();
    }
  }
}

export default RateLimiter;