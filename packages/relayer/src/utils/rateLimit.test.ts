import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import RateLimiter from './rateLimit';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFn: NextFunction;

  beforeEach(() => {
    rateLimiter = new RateLimiter(5, 5, 1000); // 5 tokens, refill 5 per second

    mockReq = {
      ip: '127.0.0.1',
      headers: {},
      socket: {
        remoteAddress: '127.0.0.1'
      } as any
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis()
    };

    nextFn = vi.fn();
  });

  it('should allow requests within rate limit', async () => {
    const middleware = rateLimiter.middleware();

    for (let i = 0; i < 5; i++) {
      await middleware(mockReq as Request, mockRes as Response, nextFn);
      expect(nextFn).toHaveBeenCalledTimes(i + 1);
    }

    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should block requests exceeding rate limit', async () => {
    const middleware = rateLimiter.middleware();

    // Use up all tokens
    for (let i = 0; i < 5; i++) {
      await middleware(mockReq as Request, mockRes as Response, nextFn);
    }

    // This request should be blocked
    await middleware(mockReq as Request, mockRes as Response, nextFn);

    expect(mockRes.status).toHaveBeenCalledWith(429);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Rate limit exceeded',
      retryAfter: 1
    });
    expect(mockRes.set).toHaveBeenCalledWith('Retry-After', '1');
    expect(nextFn).toHaveBeenCalledTimes(5); // Only the first 5 should pass
  });

  it('should track different clients separately', async () => {
    const middleware = rateLimiter.middleware();
    const req1 = { ...mockReq, ip: '192.168.1.1' };
    const req2 = { ...mockReq, ip: '192.168.1.2' };

    // Use up tokens for client 1
    for (let i = 0; i < 5; i++) {
      await middleware(req1 as Request, mockRes as Response, nextFn);
    }

    // Client 2 should still have tokens
    await middleware(req2 as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalledTimes(6);

    // Client 1 should be blocked
    await middleware(req1 as Request, mockRes as Response, nextFn);
    expect(mockRes.status).toHaveBeenCalledWith(429);
  });

  it('should refill tokens after interval', async () => {
    const fastLimiter = new RateLimiter(2, 2, 100); // Refill every 100ms
    const middleware = fastLimiter.middleware();

    // Use up tokens
    await middleware(mockReq as Request, mockRes as Response, nextFn);
    await middleware(mockReq as Request, mockRes as Response, nextFn);

    // Should be blocked
    await middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(mockRes.status).toHaveBeenCalledWith(429);

    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 150));

    // Reset mocks
    vi.clearAllMocks();

    // Should allow requests again
    await middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should handle x-forwarded-for when trust proxy is enabled', async () => {
    const originalEnv = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';

    const middleware = rateLimiter.middleware();
    const reqWithForwarded = {
      ...mockReq,
      headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' }
    };

    await middleware(reqWithForwarded as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalled();

    // Restore env
    process.env.TRUST_PROXY = originalEnv;
  });

  it('should ignore x-forwarded-for when trust proxy is disabled', async () => {
    const originalEnv = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;

    const middleware = rateLimiter.middleware();
    const reqWithForwarded = {
      ...mockReq,
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.1' }
    };

    // Should use direct IP, not forwarded
    for (let i = 0; i < 5; i++) {
      await middleware(reqWithForwarded as Request, mockRes as Response, nextFn);
    }

    // Should block based on direct IP
    await middleware(reqWithForwarded as Request, mockRes as Response, nextFn);
    expect(mockRes.status).toHaveBeenCalledWith(429);

    // Restore env
    process.env.TRUST_PROXY = originalEnv;
  });

  it('a spoofed leftmost X-Forwarded-For cannot mint unlimited buckets', async () => {
    // Behind a single trusted proxy. An attacker on one real connection varies
    // the client-supplied (leftmost) XFF entry on every request to try to get a
    // fresh bucket each time. The rightmost trusted hop is what our proxy
    // appended and is identical across the attacker's requests, so all requests
    // must land in the SAME bucket and get rate-limited.
    const originalHops = process.env.TRUST_PROXY_HOPS;
    const originalTrust = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY_HOPS = '1';
    delete process.env.TRUST_PROXY;

    const limiter = new RateLimiter(5, 5, 60000);
    const middleware = limiter.middleware();
    const proxyIp = '203.0.113.7'; // appended by our trusted proxy (rightmost)

    let blocked = false;
    for (let i = 0; i < 20; i++) {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      } as unknown as Response;
      const spoofReq = {
        ip: '10.9.9.9',
        socket: { remoteAddress: '10.9.9.9' } as any,
        headers: {
          // Unique forged client IP each request + constant real proxy hop.
          'x-forwarded-for': `10.0.0.${i}, ${proxyIp}`,
        },
      } as unknown as Request;
      await middleware(spoofReq, res, nextFn);
      if ((res.status as any).mock.calls.some((c: any[]) => c[0] === 429)) {
        blocked = true;
      }
    }

    // Capacity is 5; the attacker's 20 requests must not all pass.
    expect(blocked).toBe(true);
    expect((nextFn as any).mock.calls.length).toBeLessThanOrEqual(5);

    process.env.TRUST_PROXY_HOPS = originalHops;
    if (originalTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrust;
  });

  it('handle unknown client gracefully', async () => {
    const middleware = rateLimiter.middleware();
    const reqNoIp = { headers: {} } as Request;

    await middleware(reqNoIp, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  it('should reset specific client', async () => {
    const middleware = rateLimiter.middleware();

    // Use up tokens
    for (let i = 0; i < 5; i++) {
      await middleware(mockReq as Request, mockRes as Response, nextFn);
    }

    // Should be blocked
    vi.clearAllMocks();
    await middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(mockRes.status).toHaveBeenCalledWith(429);

    // Reset this client
    rateLimiter.reset('127.0.0.1');

    // Should allow requests again
    vi.clearAllMocks();
    await middleware(mockReq as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should reset all clients', async () => {
    const middleware = rateLimiter.middleware();
    const req1 = { ...mockReq, ip: '192.168.1.1' };
    const req2 = { ...mockReq, ip: '192.168.1.2' };

    // Use up tokens for both clients
    for (let i = 0; i < 5; i++) {
      await middleware(req1 as Request, mockRes as Response, nextFn);
      await middleware(req2 as Request, mockRes as Response, nextFn);
    }

    // Reset all
    rateLimiter.reset();

    // Both should allow requests again
    vi.clearAllMocks();
    await middleware(req1 as Request, mockRes as Response, nextFn);
    await middleware(req2 as Request, mockRes as Response, nextFn);
    expect(nextFn).toHaveBeenCalledTimes(2);
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
