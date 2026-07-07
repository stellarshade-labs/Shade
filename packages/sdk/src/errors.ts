import type { DeliveryMethod } from './types.js';

/**
 * Thrown when `send()` is called without an explicit delivery method.
 * The SDK deliberately has NO implicit default: the app must choose a method
 * (or `'auto'`) on every send so the privacy trade-off is always a conscious one.
 */
export class MethodRequiredError extends Error {
  constructor() {
    super(
      "A delivery method is required. Pass opts.method: 'pool' | 'account' | 'auto'.",
    );
    this.name = 'MethodRequiredError';
  }
}

/**
 * Thrown when a requested delivery method is not present in the client's
 * configured `methods` list.
 */
export class MethodNotEnabledError extends Error {
  constructor(method: DeliveryMethod) {
    super(
      `Delivery method '${method}' is not enabled. Add it to ClientConfig.methods to use it.`,
    );
    this.name = 'MethodNotEnabledError';
  }
}

/**
 * Thrown when a delivery method exists but cannot service the request
 * (e.g. a non-native asset over the account method, or the reserved spp method).
 */
export class MethodNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MethodNotAvailableError';
  }
}

/**
 * Thrown when an account-method XLM send is below the protocol minimum
 * (amount must be strictly greater than 1 XLM to fund a new stealth account).
 */
export class MinimumAmountError extends Error {
  constructor(amount: number) {
    super(
      `Account sends require an amount strictly greater than 1 XLM (got ${amount}).`,
    );
    this.name = 'MinimumAmountError';
  }
}

/**
 * Thrown when a partial account claim requests more than the stealth account can
 * pay out while keeping its base reserve and covering the fee. The message names
 * the maximum claimable amount so the caller can retry within bounds.
 */
export class ClaimAmountError extends Error {
  /** The maximum amount that could be claimed for this account. */
  readonly max: number;
  constructor(requested: number, max: number) {
    super(
      `Partial claim of ${requested} XLM exceeds the maximum claimable ${max} XLM ` +
        '(account must retain its base reserve and cover the fee).',
    );
    this.name = 'ClaimAmountError';
    this.max = max;
  }
}

/**
 * Thrown when a send/claim amount is not a positive finite number, caught before
 * building the transaction so the caller gets an actionable SDK error rather than
 * an on-chain failure after the fee is burned.
 */
export class InvalidAmountError extends Error {
  constructor(amount: unknown) {
    super(`Amount must be a positive finite number (got ${String(amount)}).`);
    this.name = 'InvalidAmountError';
  }
}

/**
 * Thrown by the sponsored token-claim path when the relayer-prepared XDR does
 * NOT match the operation list the client re-derives from its own trusted inputs
 * (stealth address, asset, balanceId, destination, amount). A malicious relayer
 * could otherwise redirect the payout or append an AccountMerge to steal the
 * just-claimed token; the client refuses to sign such a transaction. The message
 * names the specific mismatch (e.g. a tampered payout destination or an extra
 * appended operation) so the failure is diagnosable.
 */
export class SponsoredClaimMismatchError extends Error {
  constructor(detail: string) {
    super(
      `Refusing to sign sponsored claim: prepared transaction does not match ` +
        `the expected operations (${detail}). The relayer may be malicious.`,
    );
    this.name = 'SponsoredClaimMismatchError';
  }
}

/**
 * Thrown by {@link StealthSession.unlock} when the supplied password fails to
 * decrypt the stored envelope. Surfaces as an AES-GCM authentication failure
 * (the tag does not verify), which is indistinguishable from tampering — either
 * way the key material must not be trusted.
 */
export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password: could not decrypt the stored stealth keys.');
    this.name = 'WrongPasswordError';
  }
}
