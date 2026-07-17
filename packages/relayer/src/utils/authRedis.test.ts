import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import { challengeMessage } from './auth.js';
import { RedisChallengeStore } from './authRedis.js';

const REDIS_URL = process.env.TEST_REDIS_URL;

/** Sign the canonical challenge message the same way a real client would. */
function sign(kp: Keypair, endpoint: string, nonce: string, amount: string, bind?: string): string {
  const msg = challengeMessage(endpoint, kp.publicKey(), nonce, amount, bind);
  return kp.sign(Buffer.from(msg, 'utf8')).toString('base64');
}

// Every implementation-backed test is gated on a real Redis so `npm test` stays
// green with no infra: without TEST_REDIS_URL this whole suite is skipped.
describe.skipIf(!REDIS_URL)('RedisChallengeStore (requires TEST_REDIS_URL)', () => {
  let redis: Redis;

  beforeAll(async () => {
    // Mirror the production boot connection options (fail-fast, no offline queue
    // so a hot-wallet path never silently buffers). Because enableOfflineQueue is
    // false, commands sent before the socket is writeable are rejected — so, like
    // the real boot which PINGs first, wait for `ready` before any test runs.
    redis = new Redis(REDIS_URL as string, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });
  });

  afterEach(async () => {
    // Nonces are random 32-byte hex so cross-test collisions are impossible, but
    // sweep the namespace between tests to keep the instance tidy and isolated.
    const keys = await redis.keys('shade:nonce:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('issue -> verify happy path returns null and consumes the nonce', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());

    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature: sign(kp, 'relay', nonce, '0.0000600') },
      '0.0000600',
    );
    expect(err).toBeNull();

    // The nonce is gone after a successful verify (single-use).
    expect(await redis.get('shade:nonce:' + nonce)).toBeNull();
  });

  it('rejects invalid_account and never touches Redis', async () => {
    const store = new RedisChallengeStore(redis);
    await expect(store.issue('not-a-G-address')).rejects.toThrow('invalid_account');
  });

  it('missing fields -> missing_auth (before any Redis peek)', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    const err = await store.verify('relay', { fundingAccount: kp.publicKey(), nonce }, '1');
    expect(err).toBe('missing_auth');
    // Nonce untouched by a missing-field request.
    expect(await redis.get('shade:nonce:' + nonce)).toBe(kp.publicKey());
  });

  it('wrong signer -> invalid_signature and the nonce stays live', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const attacker = Keypair.random();
    const nonce = await store.issue(kp.publicKey());

    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature: sign(attacker, 'relay', nonce, '1') },
      '1',
    );
    expect(err).toBe('invalid_signature');

    // Bad signature must NOT burn the nonce: it is still GETtable...
    expect(await redis.get('shade:nonce:' + nonce)).toBe(kp.publicKey());
    // ...and a subsequent correctly-signed verify succeeds.
    const ok = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature: sign(kp, 'relay', nonce, '1') },
      '1',
    );
    expect(ok).toBeNull();
  });

  it('mismatched fundingAccount peek -> invalid_nonce WITHOUT burning the nonce', async () => {
    const store = new RedisChallengeStore(redis);
    const owner = Keypair.random();
    const other = Keypair.random();
    // Nonce is bound to `owner` but the request claims `other`.
    const nonce = await store.issue(owner.publicKey());

    const err = await store.verify(
      'relay',
      { fundingAccount: other.publicKey(), nonce, signature: sign(other, 'relay', nonce, '1') },
      '1',
    );
    expect(err).toBe('invalid_nonce');

    // The mismatch is non-consuming: the owner can still spend the nonce.
    expect(await redis.get('shade:nonce:' + nonce)).toBe(owner.publicKey());
    const ok = await store.verify(
      'relay',
      { fundingAccount: owner.publicKey(), nonce, signature: sign(owner, 'relay', nonce, '1') },
      '1',
    );
    expect(ok).toBeNull();
  });

  it('unknown nonce -> invalid_nonce', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce: 'deadbeef', signature: sign(kp, 'relay', 'deadbeef', '1') },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });

  it('endpoint / amount / bind binding is enforced via invalid_signature', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();

    const n1 = await store.issue(kp.publicKey());
    // Signed for endpoint 'relay' but verified as 'sponsor'.
    expect(
      await store.verify(
        'sponsor',
        { fundingAccount: kp.publicKey(), nonce: n1, signature: sign(kp, 'relay', n1, '1') },
        '1',
      ),
    ).toBe('invalid_signature');

    const n2 = await store.issue(kp.publicKey());
    // Signed for amount '1' but verified for '2'.
    expect(
      await store.verify(
        'relay',
        { fundingAccount: kp.publicKey(), nonce: n2, signature: sign(kp, 'relay', n2, '1') },
        '2',
      ),
    ).toBe('invalid_signature');

    const n3 = await store.issue(kp.publicKey());
    // Signed with bind 'AAAA' but verified with bind 'BBBB'.
    expect(
      await store.verify(
        'relay',
        { fundingAccount: kp.publicKey(), nonce: n3, signature: sign(kp, 'relay', n3, '1', 'AAAA') },
        '1',
        'BBBB',
      ),
    ).toBe('invalid_signature');

    // A matching bind verifies.
    const n4 = await store.issue(kp.publicKey());
    expect(
      await store.verify(
        'relay',
        { fundingAccount: kp.publicKey(), nonce: n4, signature: sign(kp, 'relay', n4, '1', 'CCCC') },
        '1',
        'CCCC',
      ),
    ).toBeNull();
  });

  it('replay after a successful verify -> invalid_nonce', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');

    expect(
      await store.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
    ).toBeNull();
    // The very same request replayed is rejected — the nonce was consumed.
    expect(
      await store.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
    ).toBe('invalid_nonce');
  });

  it('consume() is idempotent', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    await store.consume(nonce);
    expect(await redis.get('shade:nonce:' + nonce)).toBeNull();
    // Consuming an already-gone nonce does not throw.
    await expect(store.consume(nonce)).resolves.toBeUndefined();
  });

  it('cross-instance: A issues, B verifies, then replay on either -> invalid_nonce', async () => {
    // Two stores share ONE client (the second defineCommand must be a no-op).
    const a = new RedisChallengeStore(redis);
    const b = new RedisChallengeStore(redis);
    const kp = Keypair.random();

    const nonce = await a.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');

    // Instance B (a different process in production) verifies A's nonce.
    expect(
      await b.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
    ).toBeNull();

    // Replaying on A or B is rejected: the nonce is gone cluster-wide.
    expect(
      await a.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
    ).toBe('invalid_nonce');
    expect(
      await b.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
    ).toBe('invalid_nonce');
  });

  it('concurrent double-verify: exactly one wins', async () => {
    const a = new RedisChallengeStore(redis);
    const b = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const nonce = await a.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');

    // Fire both verifies concurrently against the one live nonce.
    const [r1, r2] = await Promise.all([
      a.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
      b.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
    ]);

    const results = [r1, r2];
    // Exactly one null (won) and one invalid_nonce (lost the atomic consume).
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'invalid_nonce')).toHaveLength(1);
    // And the nonce is gone.
    expect(await redis.get('shade:nonce:' + nonce)).toBeNull();
  });

  it('a high-concurrency verify storm still spends the nonce exactly once', async () => {
    const store = new RedisChallengeStore(redis);
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    const signature = sign(kp, 'relay', nonce, '1');

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.verify('relay', { fundingAccount: kp.publicKey(), nonce, signature }, '1'),
      ),
    );
    expect(attempts.filter((r) => r === null)).toHaveLength(1);
    expect(attempts.filter((r) => r === 'invalid_nonce')).toHaveLength(19);
  });

  it('TTL: an expired nonce is treated as unknown (invalid_nonce)', async () => {
    // ttlMs:1 makes the nonce expire near-instantly; PX rounds sub-ms up to 1ms.
    const store = new RedisChallengeStore(redis, { ttlMs: 1 });
    const kp = Keypair.random();
    const nonce = await store.issue(kp.publicKey());
    // Wait past the TTL without a foreground sleep call.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const err = await store.verify(
      'relay',
      { fundingAccount: kp.publicKey(), nonce, signature: sign(kp, 'relay', nonce, '1') },
      '1',
    );
    expect(err).toBe('invalid_nonce');
  });
});
