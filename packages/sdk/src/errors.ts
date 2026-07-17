import type { DeliveryMethod } from './types.js';

/**
 * Base class for every error the SDK throws deliberately.
 *
 * Carries a stable, machine-readable {@link code} so applications can branch on
 * the error KIND without string-matching messages (which may be reworded) or
 * relying on `instanceof` (which breaks across duplicated package instances).
 * Subclasses keep their own `name` and human-readable message.
 */
export class ShadeError extends Error {
  /**
   * Stable machine-readable identifier for this error kind (snake_case).
   * Guaranteed not to change across SDK versions, unlike the message text.
   */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShadeError';
    this.code = code;
  }
}

/**
 * Thrown when `send()` is called without an explicit delivery method.
 * The SDK deliberately has NO implicit default: the app must choose a method
 * (or `'auto'`) on every send so the privacy trade-off is always a conscious one.
 */
export class MethodRequiredError extends ShadeError {
  constructor() {
    super(
      'method_required',
      "A delivery method is required. Pass opts.method: 'pool' | 'account' | 'auto'.",
    );
    this.name = 'MethodRequiredError';
  }
}

/**
 * Thrown when a requested delivery method is not present in the client's
 * configured `methods` list.
 */
export class MethodNotEnabledError extends ShadeError {
  constructor(method: DeliveryMethod) {
    super(
      'method_not_enabled',
      `Delivery method '${method}' is not enabled. Add it to ClientConfig.methods to use it.`,
    );
    this.name = 'MethodNotEnabledError';
  }
}

/**
 * Thrown when a delivery method exists but cannot service the request
 * (e.g. a non-native asset over the account method, or the reserved spp method).
 */
export class MethodNotAvailableError extends ShadeError {
  constructor(message: string) {
    super('method_not_available', message);
    this.name = 'MethodNotAvailableError';
  }
}

/**
 * Thrown when an account-method XLM send is below the protocol minimum
 * (amount must be strictly greater than 1 XLM to fund a new stealth account).
 */
export class MinimumAmountError extends ShadeError {
  constructor(amount: number) {
    super(
      'minimum_amount',
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
export class ClaimAmountError extends ShadeError {
  /** The maximum amount that could be claimed for this account. */
  readonly max: number;
  constructor(requested: number, max: number) {
    super(
      'claim_amount_exceeds_max',
      `Partial claim of ${requested} XLM exceeds the maximum claimable ${max} XLM ` +
        '(account must retain its base reserve and cover the fee).',
    );
    this.name = 'ClaimAmountError';
    this.max = max;
  }
}

/**
 * Thrown when `opts.amount` is passed to a claim that CANNOT honor it, instead
 * of silently moving a different amount (fund-safety):
 * - An account-method NATIVE claim with an effective merge (`merge` omitted or
 *   `true`) sweeps the ENTIRE balance via AccountMerge — `amount` would be
 *   ignored. Pass `merge: false` for a partial claim, or drop `amount` to sweep.
 * - An account-method TOKEN claim always claims the claimable balance in full;
 *   `amount` is not supported there at all.
 *
 * Pool claims are unaffected: `amount` is honored as a partial withdrawal.
 */
export class ClaimAmountRequiresNoMergeError extends ShadeError {
  constructor(kind: 'native-merge' | 'token' = 'native-merge') {
    super(
      'claim_amount_requires_no_merge',
      kind === 'token'
        ? 'opts.amount is not supported on an account-method token claim: the ' +
            'claimable balance is always claimed (and paid out) in full. Drop ' +
            'opts.amount, then transfer any partial amount onward separately.'
        : 'opts.amount was passed but this account-method native claim would MERGE ' +
            'the stealth account and sweep its ENTIRE balance, ignoring amount. ' +
            'Pass opts.merge: false for a partial claim, or drop opts.amount to sweep.',
    );
    this.name = 'ClaimAmountRequiresNoMergeError';
  }
}

/**
 * Thrown when a send/claim amount is not a positive finite number, caught before
 * building the transaction so the caller gets an actionable SDK error rather than
 * an on-chain failure after the fee is burned.
 */
export class InvalidAmountError extends ShadeError {
  constructor(amount: unknown) {
    super(
      'invalid_amount',
      `Amount must be a positive finite number (got ${String(amount)}).`,
    );
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
export class SponsoredClaimMismatchError extends ShadeError {
  constructor(detail: string) {
    super(
      'sponsored_claim_mismatch',
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
export class WrongPasswordError extends ShadeError {
  constructor() {
    super(
      'wrong_password',
      'Wrong password: could not decrypt the stored stealth keys.',
    );
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
export class SessionIntegrityError extends ShadeError {
  constructor(which: 'spend' | 'view') {
    super(
      'session_integrity',
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
export class NoBalanceError extends ShadeError {
  constructor() {
    super('no_balance', 'Stealth address has no balance in the pool.');
    this.name = 'NoBalanceError';
  }
}

/**
 * Thrown by the pool withdraw path when no announcement matching the given
 * stealth address can be found for these keys — the payment is not ours or has
 * not yet been indexed.
 */
export class AnnouncementNotFoundError extends ShadeError {
  constructor() {
    super(
      'announcement_not_found',
      'Could not find announcement for this stealth address.',
    );
    this.name = 'AnnouncementNotFoundError';
  }
}

/**
 * Thrown by the account claim path when the stealth account cannot be found on
 * Horizon — typically because the funding send has not yet confirmed.
 */
export class StealthAccountNotFoundError extends ShadeError {
  constructor() {
    super(
      'stealth_account_not_found',
      'Stealth account not found on Horizon — has the send confirmed?',
    );
    this.name = 'StealthAccountNotFoundError';
  }
}

/**
 * Thrown by a token claim when the destination account does not (or cannot yet)
 * trust the asset being claimed. The message names the actionable fix — add the
 * trustline on the destination before claiming.
 */
export class DestinationTrustlineError extends ShadeError {
  constructor(message: string) {
    super('destination_trustline', message);
    this.name = 'DestinationTrustlineError';
  }
}

/**
 * Thrown by the pool withdraw path when a fee-payer secret is required (to pay
 * the Soroban invocation fee) but none was supplied.
 */
export class FeePayerRequiredError extends ShadeError {
  constructor() {
    super(
      'fee_payer_required',
      'A fee payer secret is required for pool withdrawals.',
    );
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
export class FeePayerAddressRequiredError extends ShadeError {
  constructor() {
    super(
      'fee_payer_address_required',
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
export class EntryArchivedRestoringError extends ShadeError {
  constructor(cause: string) {
    super(
      'entry_archived_restoring',
      `Stealth entry is archived and the automatic restore failed (${cause}). ` +
        'The funds are safe but the withdraw cannot proceed until the Balance/Nonce ' +
        'entry is restored — retry, or restore the footprint manually.',
    );
    this.name = 'EntryArchivedRestoringError';
  }
}

/**
 * Thrown when the RPC `sendTransaction` returns a non-terminal status that means
 * the transaction did NOT land — `TRY_AGAIN_LATER` (the node dropped it without
 * queueing) or any other non-`PENDING`/`SUCCESS` status. Nothing was submitted,
 * so the caller may safely retry with a fresh submission. Treating this as a
 * (retryable) failure prevents returning a success receipt for a tx that never
 * entered the ledger (SDK-01).
 */
export class TransactionRetryableError extends ShadeError {
  /** Marks this error as safe to retry (the tx never entered the ledger). */
  readonly retryable = true as const;
  constructor(status: string) {
    super(
      'transaction_retryable',
      `Transaction was not submitted (RPC status: ${status}). Nothing landed on-chain — ` +
        'retry the submission with a fresh transaction.',
    );
    this.name = 'TransactionRetryableError';
  }
}

/**
 * Thrown when confirmation polling gives up while the transaction is still
 * PENDING. The transaction was ACCEPTED by the RPC and MAY STILL LAND on-chain
 * after this error — blindly resubmitting could double-send the funds. The
 * error carries {@link txHash} so callers can keep polling that hash (e.g.
 * `getTransaction`) to a terminal status before deciding to retry;
 * `retryable` is `false` to distinguish it from
 * {@link TransactionRetryableError} in shared retry loops.
 */
export class TransactionTimeoutError extends ShadeError {
  /**
   * NOT safe to blind-retry: unlike {@link TransactionRetryableError}, the
   * transaction may still be applied after this error is thrown.
   */
  readonly retryable = false as const;
  /** Hash of the still-pending transaction — poll it before any resubmission. */
  readonly txHash: string;
  constructor(txHash: string) {
    super(
      'transaction_timeout',
      `Transaction ${txHash} confirmation timed out while still pending. It may ` +
        'STILL land on-chain — do NOT blindly resubmit (risk of double-send); ' +
        'poll this hash to a terminal status first.',
    );
    this.name = 'TransactionTimeoutError';
    this.txHash = txHash;
  }
}

/**
 * Thrown by the {@link StealthClient} constructor when a pool-capable method is
 * enabled but no contract id was supplied (there are no built-in defaults —
 * pool deployments are per-operator). Failing here — rather than deep inside a
 * later Soroban call with an opaque error — makes the misconfiguration obvious:
 * pass `contractId` explicitly.
 */
export class ContractIdRequiredError extends ShadeError {
  constructor(network: string) {
    super(
      'contract_id_required',
      `contractId is required for network '${network}'. Deploy the pool contract ` +
        'and pass its C-address as ClientConfig.contractId (there is no built-in default).',
    );
    this.name = 'ContractIdRequiredError';
  }
}

/**
 * Thrown by `getNetworkConfig` (and therefore the {@link StealthClient}
 * constructor) when the requested network name is not in the `NETWORKS` table.
 * The type system already restricts `network` to the supported names; this is
 * the runtime guard for plain-JS callers and stale configs. The message lists
 * the currently supported networks, so it stays accurate as new networks
 * (e.g. `'public'` after the external audit) are added to the table.
 */
export class UnsupportedNetworkError extends ShadeError {
  /** The unknown network name that was requested. */
  readonly network: string;
  /** The network names this SDK build supports. */
  readonly supported: string[];
  constructor(network: string, supported: string[]) {
    super(
      'unsupported_network',
      `Unsupported network '${network}'. Supported: ${supported.join(', ')}. ` +
        '(The local network has been removed — dev/test runs on testnet; ' +
        'mainnet arrives after the external audit.)',
    );
    this.name = 'UnsupportedNetworkError';
    this.network = network;
    this.supported = supported;
  }
}
