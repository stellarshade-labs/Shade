import {
  generateMetaAddress,
  generateMnemonic,
  mnemonicToStealthKeys,
} from '@shade/crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getNetworkConfig } from './soroban.js';
import { stealthKeysFromRaw } from './wallet.js';
import { HorizonClient } from './horizon.js';
import { PoolAdapter } from './methods/pool.js';
import { AccountAdapter } from './methods/account.js';
import { SppAdapter } from './methods/spp.js';
import { normalizeRelayList, type RelayerSelection } from './relayerPool.js';
import {
  MethodRequiredError,
  MethodNotEnabledError,
  MethodNotAvailableError,
  ContractIdRequiredError,
} from './errors.js';
import type { DeliveryAdapter } from './methods/types.js';
import type {
  ClientConfig,
  StealthKeys,
  SendReceipt,
  SendOpts,
  Payment,
  Balance,
  WithdrawReceipt,
  WithdrawOpts,
  DeliveryMethod,
  ScanOpts,
  ScanResult,
  ScanCursor,
  ClaimOpts,
  ClaimReceipt,
} from './types.js';

/**
 * High-level client for stealth payments on Stellar.
 *
 * Wraps DKSAP cryptography behind pluggable delivery methods. Each method
 * (`'pool'`, `'account'`, and the reserved `'spp'`) is an adapter; the client
 * builds a registry from `config.methods` and routes send/scan/claim through it.
 *
 * @example
 * ```typescript
 * const client = new StealthClient({
 *   network: 'testnet',
 *   contractId: 'C...', // your deployed pool contract (required for 'pool')
 *   methods: ['pool', 'account'],
 * });
 *
 * const keys = StealthClient.keygen();
 *
 * // A method is REQUIRED on every send — no implicit default.
 * await client.send(keys.metaAddress, 100, 'SXXX...', { method: 'auto' });
 *
 * const { payments } = await client.scanWithCursor(keys);
 * await client.claim(payments[0], 'GDEST...', { keys });
 * ```
 */
export class StealthClient {
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly server: StellarSdk.rpc.Server;
  private readonly enabledMethods: DeliveryMethod[];
  private readonly adapters: Map<DeliveryMethod, DeliveryAdapter>;
  private readonly relayer?: string | string[];
  private readonly relayerSelection?: RelayerSelection;

  constructor(config: ClientConfig) {
    this.contractId = config.contractId || '';
    const netConfig = getNetworkConfig(config.network);
    this.networkPassphrase = netConfig.networkPassphrase;
    this.server = netConfig.server;
    this.relayer = config.relayer;
    this.relayerSelection = config.relayerSelection;
    this.enabledMethods = config.methods && config.methods.length > 0
      ? config.methods
      : ['pool'];

    // The pool method cannot function without a contract id, and there are no
    // built-in defaults (pool deployments are per-operator), so a client with
    // pool enabled and no explicit contractId must fail loudly here instead of
    // surfacing an opaque Soroban error on the first pool call.
    if (this.enabledMethods.includes('pool') && !this.contractId) {
      throw new ContractIdRequiredError(config.network);
    }

    const horizonUrl = config.horizonUrl || netConfig.horizonUrl;
    const horizon = new HorizonClient(horizonUrl);

    this.adapters = new Map();
    for (const method of this.enabledMethods) {
      switch (method) {
        case 'pool':
          this.adapters.set(
            'pool',
            new PoolAdapter(this.contractId, this.networkPassphrase, this.server, {
              relayerSelection: this.relayerSelection,
            }),
          );
          break;
        case 'account':
          this.adapters.set(
            'account',
            new AccountAdapter(this.networkPassphrase, horizon, this.relayer, {
              // Confirm-poll handle for relayed claims (`confirm: true`): the
              // Soroban RPC's getTransaction resolves classic tx hashes too.
              rpcServer: this.server,
              relayerSelection: this.relayerSelection,
            }),
          );
          break;
        case 'spp':
          this.adapters.set('spp', new SppAdapter());
          break;
      }
    }
  }

  /**
   * Generate a new random stealth key pair.
   * No network connection needed.
   */
  static keygen(): StealthKeys {
    return stealthKeysFromRaw(generateMetaAddress());
  }

  /**
   * Generate stealth keys from a BIP-39 mnemonic.
   * Returns the mnemonic alongside the keys for backup.
   * No network connection needed.
   */
  static fromMnemonic(mnemonic?: string): StealthKeys & { mnemonic: string } {
    const phrase = mnemonic || generateMnemonic();
    return {
      mnemonic: phrase,
      ...stealthKeysFromRaw(mnemonicToStealthKeys(phrase)),
    };
  }

  /**
   * Resolve `'auto'` to a concrete method: native asset AND amount > 1 AND
   * 'account' enabled -> 'account'; otherwise 'pool'.
   */
  private resolveMethod(
    requested: DeliveryMethod | 'auto',
    amount: number,
    asset?: string,
  ): DeliveryMethod {
    if (requested === 'auto') {
      const isNative = !asset || asset === 'native' || asset === 'XLM';
      if (isNative && amount > 1 && this.adapters.has('account')) {
        return 'account';
      }
      return 'pool';
    }
    return requested;
  }

  private getAdapter(method: DeliveryMethod): DeliveryAdapter {
    const adapter = this.adapters.get(method);
    if (!adapter) throw new MethodNotEnabledError(method);
    return adapter;
  }

  /**
   * Send tokens to a stealth address via the chosen delivery method.
   *
   * A method is REQUIRED on every call (`opts.method`). Pass `'auto'` to let the
   * client resolve one; there is deliberately no implicit default.
   *
   * @param metaAddress - Recipient's meta-address (shade:stellar:... format)
   * @param amount - Amount in whole units (e.g. 100 = 100 XLM)
   * @param senderSecret - Sender's Stellar secret key
   * @param opts - Delivery method (required) and optional asset
   * @throws {MethodRequiredError} If no method is provided.
   * @throws {MethodNotEnabledError} If the resolved method is not enabled.
   */
  async send(
    metaAddress: string,
    amount: number,
    senderSecret: string,
    opts: SendOpts,
  ): Promise<SendReceipt> {
    // opts is required at the type level too, but keep the runtime guard for
    // plain-JS callers (and for `{}` casts) so misuse still fails loudly.
    if (!opts || !opts.method) {
      throw new MethodRequiredError();
    }
    const method = this.resolveMethod(opts.method, amount, opts.asset);
    const adapter = this.getAdapter(method);
    return adapter.send({
      metaAddress,
      amount,
      senderSecret,
      asset: opts.asset,
      signTransaction: opts.signTransaction,
    });
  }

  /**
   * Scan for stealth payments across every enabled delivery method.
   *
   * @param keys - Your stealth keys (needs viewPrivKey + spendPubKey)
   */
  async scan(keys: StealthKeys): Promise<Payment[]> {
    const { payments } = await this.scanWithCursor(keys);
    return payments;
  }

  /**
   * Cursor-aware scan across enabled (or explicitly requested) methods. Returns
   * the merged payments plus an updated per-method cursor to persist and pass to
   * the next scan for incremental discovery.
   *
   * @param keys - Your stealth keys (needs viewPrivKey + spendPubKey)
   * @param opts - Optional method filter and resume cursor
   */
  async scanWithCursor(
    keys: StealthKeys,
    opts?: ScanOpts,
  ): Promise<ScanResult> {
    return this.scanInternal(keys, opts, false);
  }

  /**
   * Shared scan implementation. When `suppressClaimed` is set (the balance
   * path), the account adapter drops fully-swept/merged native accounts (live
   * balance 0) so a spent stealth account is not reported as spendable — while
   * the plain discovery scan keeps returning still-claimable rows.
   */
  private async scanInternal(
    keys: StealthKeys,
    opts: ScanOpts | undefined,
    suppressClaimed: boolean,
  ): Promise<ScanResult> {
    const methods = (opts?.methods ?? this.enabledMethods).filter((m) =>
      this.adapters.has(m),
    );
    const cursor: ScanCursor = { ...(opts?.cursor ?? {}) };
    const payments: Payment[] = [];

    for (const method of methods) {
      const adapter = this.getAdapter(method);
      const prev = cursor[method];
      const result = await adapter.scan(keys, prev, {
        suppressClaimedNative: suppressClaimed,
      });
      for (const p of result.payments) {
        payments.push({ ...p, method });
      }
      cursor[method] = result.cursor;
    }

    return { payments, cursor };
  }

  /**
   * Get balances for all your stealth payments across enabled methods.
   *
   * @param keys - Your stealth keys (needs viewPrivKey + spendPubKey)
   * @param opts - Optional method filter and resume cursor (a cursor returned
   *   by a previous {@link scanWithCursor}/{@link balanceWithCursor}). With no
   *   opts the whole history is scanned, exactly as before. Passing the
   *   persisted cursor turns the account phase from a full Horizon re-walk
   *   into O(new transactions); use {@link balanceWithCursor} when you also
   *   need the advanced cursor back to persist it.
   */
  async balance(keys: StealthKeys, opts?: ScanOpts): Promise<Balance[]> {
    const { payments } = await this.balanceWithCursor(keys, opts);
    return payments.map((p) => ({
      stealthAddress: p.stealthAddress,
      token: p.token,
      amount: p.amount,
      amountStroops: p.amountStroops,
    }));
  }

  /**
   * Cursor-aware balance check: like {@link balance}, but resumes the
   * underlying scan from `opts.cursor` and returns the full live payments
   * (ephemeral key, txHash, claimable-balance id) PLUS the advanced cursor so
   * callers can persist it for the next call — the exact counterpart of
   * {@link scanWithCursor} for the balance path.
   *
   * The rows are the balance view: claimed/fully-swept payments are dropped
   * and native rows report the LIVE remaining account balance (not the
   * original per-transaction amount). Callers that persist discovered
   * payments should merge these rows into their cache BEFORE persisting the
   * advanced cursor, since the next resumed scan will skip everything behind
   * it.
   *
   * @param keys - Your stealth keys (needs viewPrivKey + spendPubKey)
   * @param opts - Optional method filter and resume cursor
   */
  async balanceWithCursor(
    keys: StealthKeys,
    opts?: ScanOpts,
  ): Promise<ScanResult> {
    return this.scanInternal(keys, opts, true);
  }

  /**
   * Claim a detected payment to a destination, branching on the payment's
   * delivery method: `'pool'` uses the withdraw path, `'account'` sweeps or
   * partially pays out the stealth account.
   *
   * @param payment - A payment returned from {@link scan}/{@link scanWithCursor}.
   * @param destination - Destination Stellar G-address.
   * @param opts - Claim options (keys required; relay/merge/feePayer optional).
   */
  async claim(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    const adapter = this.getAdapter(payment.method);
    // Normalized so an empty/whitespace per-call list falls back to the config
    // relayer instead of shadowing it (and `[]` means "no relayer", not a pool
    // of zero candidates).
    const relay =
      normalizeRelayList(opts.relay) ?? normalizeRelayList(this.relayer);
    return adapter.claim(payment, destination, { ...opts, relay });
  }

  /**
   * Withdraw tokens from the stealth pool.
   *
   * @deprecated Use {@link claim} with a pool payment instead. Retained for
   * backwards compatibility; behaves exactly like the original pool withdraw.
   *
   * @param stealthAddress - The stealth address to withdraw from
   * @param destination - Destination Stellar address (G...)
   * @param opts - Withdraw options (keys, feePayer, optional relay/asset/amount)
   */
  async withdraw(
    stealthAddress: string,
    destination: string,
    opts: WithdrawOpts,
  ): Promise<WithdrawReceipt> {
    const adapter = this.adapters.get('pool');
    if (!(adapter instanceof PoolAdapter)) {
      throw new MethodNotAvailableError(
        "The 'pool' method must be enabled to use withdraw()",
      );
    }
    const result = await adapter.withdraw(stealthAddress, destination, {
      keys: opts.keys,
      feePayer: opts.feePayer,
      relay: normalizeRelayList(opts.relay) ?? normalizeRelayList(this.relayer),
      asset: opts.asset,
      amount: opts.amount,
      fundingAccount: opts.fundingAccount,
      fundingSigner: opts.fundingSigner,
      confirm: opts.confirm,
    });
    return { txHash: result.txHash, amount: result.amount };
  }
}
