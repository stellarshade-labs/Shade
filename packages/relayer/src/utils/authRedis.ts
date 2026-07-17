import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import type { Redis } from 'ioredis';
import { validateStellarAddress } from './validation.js';
import { ChallengeStore, challengeMessage } from './auth.js';

/** Default lifetime of an issued challenge nonce (milliseconds). */
const DEFAULT_TTL_MS = 120_000;

/** Redis key namespace for challenge nonces: `shade:nonce:<nonce>` -> account. */
const KEY_PREFIX = 'shade:nonce:';

/** Bounded retries when `SET ... NX` collides with an existing (rare) nonce. */
const MAX_ISSUE_RETRIES = 5;

/**
 * Name of the atomic consume command registered via {@link Redis.defineCommand}.
 * ioredis compiles it to a cached `EVALSHA` script. Keep unique per client so it
 * does not clash with commands other modules define on the same connection.
 */
const CONSUME_COMMAND = 'shadeConsumeNonce';

/**
 * Lua: single-use consume. Delete the nonce key only if it still maps to the
 * expected account, atomically. Returns 1 when this call performed the delete
 * (the caller is the single winner) or 0 when the key is gone / already
 * mismatched (another instance consumed it first — the caller lost the race).
 */
const CONSUME_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * ioredis client augmented with the custom {@link CONSUME_COMMAND}. `defineCommand`
 * attaches the method at runtime but not to the static type, so we narrow to this
 * shape for a type-safe call without an `any`.
 */
type RedisWithConsume = Redis & {
  [CONSUME_COMMAND]: (key: string, account: string) => Promise<number>;
};

/**
 * A shared, cross-instance {@link ChallengeStore} backed by Redis. Behaviourally
 * identical to `MemoryChallengeStore` (same error-code order, same single-use
 * proof-of-control), but the nonce lives in Redis so any relayer instance can
 * issue and any instance can verify+consume it exactly once. Redis key TTL
 * replaces the in-memory store's sweep timer, and an atomic Lua compare-and-del
 * replaces the local delete so two instances cannot both consume one nonce.
 */
export class RedisChallengeStore implements ChallengeStore {
  private readonly redis: RedisWithConsume;
  private readonly ttlMs: number;

  constructor(redis: Redis, opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;

    // Register the compare-and-delete command once per client. Defining the same
    // command name twice on one connection throws, so guard for the case where a
    // second RedisChallengeStore shares the client (the cross-instance path).
    const client = redis as RedisWithConsume;
    if (typeof client[CONSUME_COMMAND] !== 'function') {
      redis.defineCommand(CONSUME_COMMAND, { numberOfKeys: 1, lua: CONSUME_LUA });
    }
    this.redis = client;
  }

  private key(nonce: string): string {
    return KEY_PREFIX + nonce;
  }

  /**
   * Issue a fresh random nonce bound to `account`, valid for the store TTL. The
   * nonce is written with `SET ... NX PX` so a (astronomically unlikely) key
   * collision does not clobber an existing account binding; on collision a new
   * nonce is generated, bounded by {@link MAX_ISSUE_RETRIES}.
   * @throws Error('invalid_account') when `account` is not a valid G-address.
   */
  async issue(account: string): Promise<string> {
    if (!validateStellarAddress(account)) {
      throw new Error('invalid_account');
    }
    for (let attempt = 0; attempt < MAX_ISSUE_RETRIES; attempt++) {
      const nonce = randomBytes(32).toString('hex');
      const res = await this.redis.set(this.key(nonce), account, 'PX', this.ttlMs, 'NX');
      if (res === 'OK') {
        return nonce;
      }
    }
    throw new Error('nonce_collision');
  }

  /** Consume (single-use) a nonce, removing it from the store. Idempotent. */
  async consume(nonce: string): Promise<void> {
    await this.redis.del(this.key(nonce));
  }

  /**
   * Verify a proof-of-control challenge. Mirrors `MemoryChallengeStore.verify`
   * exactly, including the error-code order and non-consuming peek:
   *  1. field/address checks -> `missing_auth` / `invalid_account`;
   *  2. a NON-consuming `GET` peek -> `invalid_nonce` on missing / account
   *     mismatch (a mismatch must NOT burn the nonce);
   *  3. local ed25519 signature check over the canonical message ->
   *     `invalid_signature` (the nonce is still live afterwards);
   *  4. atomic compare-and-delete consume -> `invalid_nonce` if another instance
   *     consumed it between the peek and here (raced single-use).
   * Resolves `null` on success (the nonce has been consumed).
   */
  async verify(
    endpoint: string,
    auth: {
      fundingAccount?: unknown;
      nonce?: unknown;
      signature?: unknown;
    },
    amount: string,
    bind?: string,
  ): Promise<string | null> {
    const fundingAccount = auth?.fundingAccount;
    const nonce = auth?.nonce;
    const signature = auth?.signature;
    if (
      typeof fundingAccount !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string'
    ) {
      return 'missing_auth';
    }
    if (!validateStellarAddress(fundingAccount)) {
      return 'invalid_account';
    }

    // Non-consuming peek: a missing nonce or an account mismatch must leave the
    // nonce untouched (matches MemoryChallengeStore.peek).
    const bound = await this.redis.get(this.key(nonce));
    if (bound !== fundingAccount) {
      return 'invalid_nonce';
    }

    const message = challengeMessage(endpoint, fundingAccount, nonce, amount, bind);
    let ok = false;
    try {
      const kp = Keypair.fromPublicKey(fundingAccount);
      const sigBytes = decodeSignature(signature);
      ok = kp.verify(Buffer.from(message, 'utf8'), Buffer.from(sigBytes));
    } catch {
      ok = false;
    }
    if (!ok) return 'invalid_signature';

    // Single-use: atomic compare-and-delete. A concurrent verify on another
    // instance can consume the nonce between the peek and here; the loser gets 0
    // and is rejected as a replay so a nonce is spent at most once cluster-wide.
    const consumed = await this.redis[CONSUME_COMMAND](this.key(nonce), fundingAccount);
    if (consumed !== 1) {
      return 'invalid_nonce';
    }
    return null;
  }
}

/**
 * Decode a signature provided as base64 or hex into raw bytes. Kept byte-for-byte
 * identical to the private helper in `auth.ts` (which is not exported); see the
 * batch deviations note. Hex is only used when it decodes to the ed25519
 * signature length (64 bytes = 128 hex chars); everything else is treated as
 * base64.
 */
function decodeSignature(signature: string): Uint8Array {
  if (/^[0-9a-fA-F]+$/.test(signature) && signature.length % 2 === 0) {
    if (signature.length === 128) {
      return Uint8Array.from(Buffer.from(signature, 'hex'));
    }
  }
  return Uint8Array.from(Buffer.from(signature, 'base64'));
}
