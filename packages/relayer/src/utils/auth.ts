import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import { validateStellarAddress } from './validation.js';

/** Default lifetime of an issued challenge nonce (milliseconds). */
const DEFAULT_TTL_MS = 120_000;

interface IssuedNonce {
  account: string;
  expiresAt: number;
}

/**
 * In-memory, single-use challenge-nonce store keyed by nonce. Proof-of-control
 * for a `fundingAccount` works as: the client fetches a fresh nonce bound to the
 * account, signs a canonical message binding the endpoint + account + nonce +
 * authorized amount with the account's ed25519 key, and submits the signature.
 * The relayer verifies, then consumes the nonce so it cannot be replayed.
 */
export class ChallengeStore {
  private readonly nonces = new Map<string, IssuedNonce>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Issue a fresh random nonce bound to `account`, valid for the store TTL.
   * @throws Error('invalid_account') when `account` is not a valid G-address.
   */
  issue(account: string): string {
    if (!validateStellarAddress(account)) {
      throw new Error('invalid_account');
    }
    this.sweep();
    const nonce = randomBytes(32).toString('hex');
    this.nonces.set(nonce, { account, expiresAt: Date.now() + this.ttlMs });
    return nonce;
  }

  /** Drop expired nonces so the map cannot grow unbounded. */
  private sweep(): void {
    const now = Date.now();
    for (const [nonce, rec] of this.nonces) {
      if (rec.expiresAt <= now) this.nonces.delete(nonce);
    }
  }

  /**
   * Look up an unexpired nonce for `account`. Does NOT consume it — callers
   * verify the signature first, then {@link consume} on success.
   */
  private peek(account: string, nonce: string): boolean {
    const rec = this.nonces.get(nonce);
    if (!rec) return false;
    if (rec.expiresAt <= Date.now()) {
      this.nonces.delete(nonce);
      return false;
    }
    return rec.account === account;
  }

  /** Consume (single-use) a nonce, removing it from the store. */
  consume(nonce: string): void {
    this.nonces.delete(nonce);
  }

  /**
   * Verify a proof-of-control challenge for a fee-spending request. On success
   * the nonce is consumed (single-use) and `null` is returned; on any failure an
   * error code string is returned (the caller responds 401). Failure cases:
   * missing/invalid fields, unknown/expired nonce, account mismatch, or a
   * signature that does not verify against `fundingAccount`'s key.
   *
   * @param endpoint - Canonical endpoint name (e.g. `'relay'`, `'sponsor'`).
   * @param auth - The `{ fundingAccount, nonce, signature }` the client sent.
   * @param amount - The fee/amount (7-dp XLM string) the signature authorizes.
   */
  verify(
    endpoint: string,
    auth: {
      fundingAccount?: unknown;
      nonce?: unknown;
      signature?: unknown;
    },
    amount: string,
  ): string | null {
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
    if (!this.peek(fundingAccount, nonce)) {
      return 'invalid_nonce';
    }

    const message = challengeMessage(endpoint, fundingAccount, nonce, amount);
    let ok = false;
    try {
      const kp = Keypair.fromPublicKey(fundingAccount);
      const sigBytes = decodeSignature(signature);
      ok = kp.verify(Buffer.from(message, 'utf8'), Buffer.from(sigBytes));
    } catch {
      ok = false;
    }
    if (!ok) return 'invalid_signature';

    // Single-use: consume only after a fully successful verification.
    this.consume(nonce);
    return null;
  }
}

/**
 * Canonical single-line message the funding account signs to authorize a spend.
 * Binds the endpoint, funding account, nonce, and authorized amount so a
 * signature for one endpoint/amount/nonce cannot be replayed for another.
 */
export function challengeMessage(
  endpoint: string,
  fundingAccount: string,
  nonce: string,
  amount: string,
): string {
  return `shade-relayer:v1:${endpoint}:${fundingAccount}:${nonce}:${amount}`;
}

/** Decode a signature provided as base64 or hex into raw bytes. */
function decodeSignature(signature: string): Uint8Array {
  if (/^[0-9a-fA-F]+$/.test(signature) && signature.length % 2 === 0) {
    // Prefer hex only when it decodes to the ed25519 signature length (64B).
    if (signature.length === 128) {
      return Uint8Array.from(Buffer.from(signature, 'hex'));
    }
  }
  return Uint8Array.from(Buffer.from(signature, 'base64'));
}
