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

/**
 * Thrown by {@link StealthSession.unlock} when the public keys stored in the
 * clear on the envelope do NOT match the public keys re-derived from the
 * decrypted private scalars. The private material is protected by AES-GCM, but
 * the cleartext `spendPublicKey`/`viewPublicKey` are not — a storage-WRITE
 * attacker (no password) could otherwise substitute a wrong pubkey and silently
 * break scanning (denial of discovery). Re-deriving and asserting equality on
 * unlock turns that silent mis-scan into a loud, diagnosable failure.
 */
export class SessionIntegrityError extends Error {
  constructor(which: 'spend' | 'view') {
    super(
      `Session integrity check failed: the stored ${which} public key does not ` +
        'match the decrypted private key. The stored session may have been tampered with.',
    );
    this.name = 'SessionIntegrityError';
  }
}

/**
 * Thrown by the pool withdraw path when the resolved stealth address holds no
 * balance in the pool contract for the requested asset — there is nothing to
 * withdraw. Recoverable: the caller may have already withdrawn, or is querying
 * the wrong asset.
 */
export class NoBalanceError extends Error {
  constructor() {
    super('Stealth address has no balance in the pool.');
    this.name = 'NoBalanceError';
  }
}

/**
 * Thrown by the pool withdraw path when no announcement matching the given
 * stealth address can be found for these keys — the payment is not ours or has
 * not yet been indexed.
 */
export class AnnouncementNotFoundError extends Error {
  constructor() {
    super('Could not find announcement for this stealth address.');
    this.name = 'AnnouncementNotFoundError';
  }
}

/**
 * Thrown by the account claim path when the stealth account cannot be found on
 * Horizon — typically because the funding send has not yet confirmed.
 */
export class StealthAccountNotFoundError extends Error {
  constructor() {
    super('Stealth account not found on Horizon — has the send confirmed?');
    this.name = 'StealthAccountNotFoundError';
  }
}

/**
 * Thrown by a token claim when the destination account does not (or cannot yet)
 * trust the asset being claimed. The message names the actionable fix — add the
 * trustline on the destination before claiming.
 */
export class DestinationTrustlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationTrustlineError';
  }
}

/**
 * Thrown by the pool withdraw path when a fee-payer secret is required (to pay
 * the Soroban invocation fee) but none was supplied.
 */
export class FeePayerRequiredError extends Error {
  constructor() {
    super('A fee payer secret is required for pool withdrawals.');
    this.name = 'FeePayerRequiredError';
  }
}

/**
 * Thrown by the pool claim path when an external {@link TransactionSigner} is
 * supplied (via `signTransaction`) but no `feePayerAddress` is given. A pool
 * claim needs a fee payer; with external signing the fee payer is identified by
 * its G-address, never a secret. Failing loudly here prevents the SDK from ever
 * calling `Keypair.fromSecret` on a public key.
 */
export class FeePayerAddressRequiredError extends Error {
  constructor() {
    super(
      'feePayerAddress is required when signTransaction is set on a pool claim. ' +
        'Pass the fee payer G-address (opts.feePayerAddress) — the SDK signs it via signTransaction.',
    );
    this.name = 'FeePayerAddressRequiredError';
  }
}

/**
 * Thrown by the pool withdraw path when the recipient's persistent Balance/Nonce
 * ledger entry has been archived (Soroban state expiration) and the automatic
 * RestoreFootprint transaction that must precede the withdraw could not be
 * completed. Withdrawing over an archived footprint fails on-chain even though
 * `get_balance`/`scan` still report the funds, so the SDK restores the entry
 * first; if that restore itself fails the funds are recoverable but the withdraw
 * cannot proceed until the entry is restored. The message carries the underlying
 * cause so the operator can diagnose (e.g. an unfunded fee payer or a relayer
 * rejection).
 */
export class EntryArchivedRestoringError extends Error {
  constructor(cause: string) {
    super(
      `Stealth entry is archived and the automatic restore failed (${cause}). ` +
        'The funds are safe but the withdraw cannot proceed until the Balance/Nonce ' +
        'entry is restored — retry, or restore the footprint manually.',
    );
    this.name = 'EntryArchivedRestoringError';
  }
}

/**
 * Thrown by the {@link StealthClient} constructor when a pool-capable method is
 * enabled but no contract id could be resolved for the target network (there is
 * no built-in default outside `local`). Failing here — rather than deep inside a
 * later Soroban call with an opaque error — makes the misconfiguration obvious:
 * pass `contractId` explicitly for `testnet`.
 */
export class ContractIdRequiredError extends Error {
  constructor(network: string) {
    super(
      `contractId is required for network '${network}'. Deploy the pool contract ` +
        'and pass its C-address as ClientConfig.contractId (only `local` has a built-in default).',
    );
    this.name = 'ContractIdRequiredError';
  }
}
