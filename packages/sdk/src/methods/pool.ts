import {
  decodeMetaAddress,
  deriveStealthAddressWithSecret,
  scanAnnouncements,
  recoverStealthPrivateKey,
} from '@shade/crypto';
import {
  Keypair,
  TransactionBuilder,
  Contract,
  nativeToScVal,
  StrKey,
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { randomBytes } from '@noble/hashes/utils';
import {
  resolveTokenAddress,
  labelForToken,
  fetchAnnouncements,
  fetchAnnouncementCount,
  queryBalance,
  queryNonce,
  buildWithdrawMessage,
  resolveSendResult,
  type RawAnnouncement,
} from '../soroban.js';
import type {
  StealthKeys,
  SendReceipt,
  Payment,
  ClaimReceipt,
  ClaimOpts,
} from '../types.js';
import type { DeliveryAdapter, AdapterSendParams } from './types.js';
import type { TransactionSigner } from '../types.js';
import {
  NoBalanceError,
  AnnouncementNotFoundError,
  FeePayerRequiredError,
  FeePayerAddressRequiredError,
} from '../errors.js';
import { numberToStroops, formatStroops } from '../stroops.js';
import { RelayerClient, type FundingSigner } from '../relayer.js';
import { signTx } from './sign.js';
import { prepareWithRestore } from './restore.js';

const POOL_PAGE_SIZE = 200;

/**
 * The pool delivery adapter: deposit/scan/withdraw against the Soroban pool
 * contract. This is the original, private, multi-token path — the logic here is
 * the behavior previously inlined in `StealthClient`, extracted unchanged so the
 * client can treat it as one adapter among several.
 */
export class PoolAdapter implements DeliveryAdapter {
  readonly method = 'pool' as const;

  constructor(
    private readonly contractId: string,
    private readonly networkPassphrase: string,
    private readonly server: StellarSdk.rpc.Server,
  ) {}

  /**
   * Derive a one-time stealth address and deposit into the pool contract,
   * recording the announcement atomically with the deposit.
   */
  async send(params: AdapterSendParams): Promise<SendReceipt> {
    const { metaAddress, amount, senderSecret, asset, signTransaction } = params;
    if (amount <= 0) throw new Error('Amount must be positive');

    const { spendPubKey, viewPubKey } = decodeMetaAddress(metaAddress);
    const senderPublicKey = signTransaction
      ? senderSecret
      : Keypair.fromSecret(senderSecret).publicKey();
    const tokenAddress = resolveTokenAddress(asset, this.networkPassphrase);
    const stroops = numberToStroops(amount);

    const ephemeralPrivKey = new Uint8Array(randomBytes(32));
    const stealth = deriveStealthAddressWithSecret(
      spendPubKey,
      viewPubKey,
      ephemeralPrivKey,
    );

    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(senderPublicKey);

    const depositTx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          'deposit',
          new StellarSdk.Address(senderPublicKey).toScVal(),
          new StellarSdk.Address(tokenAddress).toScVal(),
          nativeToScVal(stroops, { type: 'i128' }),
          nativeToScVal(Buffer.from(stealth.stealthPubKey)),
          nativeToScVal(Buffer.from(stealth.ephemeralPubKey)),
          nativeToScVal(stealth.viewTag, { type: 'u32' }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(depositTx);
    const signed = await signTx(
      prepared,
      senderSecret,
      this.networkPassphrase,
      signTransaction,
    );
    const result = await this.server.sendTransaction(signed);
    const txHash = await resolveSendResult(this.server, result);

    return {
      stealthAddress: stealth.stealthAddress,
      txHash,
    };
  }

  /**
   * Scan pool announcements starting at the cursor (announcement index). The
   * cursor advances by the number of announcements returned; a cheap
   * `get_announcement_count` lets callers skip a full scan when nothing is new.
   */
  async scan(
    keys: StealthKeys,
    cursor?: string,
  ): Promise<{ payments: Payment[]; cursor?: string }> {
    const viewPrivKey = Buffer.from(keys.viewPrivKey, 'hex');
    const spendPubKey = Buffer.from(keys.spendPubKey, 'hex');

    const start = cursor ? Number(cursor) : 0;

    const total = await fetchAnnouncementCount(
      this.contractId,
      this.server,
      this.networkPassphrase,
    );
    if (total <= start) {
      return { payments: [], cursor: String(start) };
    }

    const announcements: RawAnnouncement[] = [];
    let offset = start;
    while (offset < total) {
      const page = await fetchAnnouncements(
        this.contractId,
        this.server,
        this.networkPassphrase,
        offset,
        POOL_PAGE_SIZE,
      );
      if (page.length === 0) break;
      announcements.push(...page);
      offset += page.length;
    }

    const nextCursor = String(start + announcements.length);
    const payments = await this.matchAndPrice(
      announcements,
      viewPrivKey,
      spendPubKey,
    );
    return { payments, cursor: nextCursor };
  }

  private async matchAndPrice(
    announcements: RawAnnouncement[],
    viewPrivKey: Buffer,
    spendPubKey: Buffer,
  ): Promise<Payment[]> {
    if (announcements.length === 0) return [];

    const matches = scanAnnouncements(
      viewPrivKey,
      spendPubKey,
      announcements.map((a) => ({
        ephemeralPubKey: a.ephemeralPubKey,
        viewTag: a.viewTag,
        stealthAddress: a.stealthAddress,
      })),
    );

    const payments: Payment[] = [];
    for (const match of matches) {
      if (!match) continue;
      const ann = announcements.find((a) => a.stealthAddress === match.address);
      if (!ann) continue;

      const balance = await queryBalance(
        this.contractId,
        ann.stealthPubKey,
        ann.token,
        this.server,
        this.networkPassphrase,
      );
      if (balance <= 0n) continue;

      payments.push({
        stealthAddress: ann.stealthAddress,
        ephemeralPubKey: Buffer.from(ann.ephemeralPubKey).toString('hex'),
        token: ann.token,
        asset: labelForToken(ann.token, this.networkPassphrase),
        amount: Number(balance) / 1e7,
        amountStroops: balance.toString(),
        method: 'pool',
      });
    }
    return payments;
  }

  /**
   * Claim (withdraw) a pool payment: recover the stealth key, sign a withdraw
   * message, and submit — directly or via a relayer fee-bump.
   */
  async claim(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    // A pool claim always needs a fee payer. With an external signer the fee
    // payer is identified by its G-address (never a secret) — require it up
    // front so the SDK never calls Keypair.fromSecret on a public key.
    if (opts.signTransaction && !opts.feePayerAddress) {
      throw new FeePayerAddressRequiredError();
    }
    const receipt = await this.withdraw(payment.stealthAddress, destination, {
      keys: opts.keys,
      feePayer: opts.feePayer ?? '',
      relay: opts.relay,
      asset: opts.asset,
      amount: opts.amount,
      signTransaction: opts.signTransaction,
      feePayerAddress: opts.feePayerAddress,
      fundingAccount: opts.fundingAccount,
      fundingSigner: opts.fundingSigner,
      confirm: opts.confirm,
    });
    return { txHash: receipt.txHash, amount: receipt.amount, method: 'pool' };
  }

  /**
   * The original pool withdraw path, preserved for the client's `@deprecated`
   * `withdraw()` alias and reused by `claim()`.
   */
  async withdraw(
    stealthAddress: string,
    destination: string,
    opts: {
      keys: StealthKeys;
      feePayer: string;
      relay?: string;
      asset?: string;
      amount?: number;
      signTransaction?: TransactionSigner;
      feePayerAddress?: string;
      /** App funding account to debit against (credit-gated relayers). */
      fundingAccount?: string;
      /**
       * Signer proving control of `fundingAccount` — a credit-gated relayer
       * rejects `/relay` without a signed challenge (proof-of-control), so
       * `fundingAccount` alone is not enough to spend credit.
       */
      fundingSigner?: FundingSigner;
      /**
       * Relayed submissions only: poll the relayer-returned txHash until it is
       * actually on-chain before returning (SDK-TXHASH-TRUST), surfacing a
       * `TransactionTimeoutError` (with the hash) if it never lands. Default
       * `false`: trust the relayer's response, exactly as before. The direct
       * (non-relay) path already confirms via `resolveSendResult` regardless.
       */
      confirm?: boolean;
    },
  ): Promise<{ txHash: string; amount: number }> {
    if (!StrKey.isValidEd25519PublicKey(stealthAddress)) {
      throw new Error('Invalid stealth address');
    }
    if (!StrKey.isValidEd25519PublicKey(destination)) {
      throw new Error('Invalid destination address');
    }
    // With an external signer the fee payer is a G-address, not a secret.
    if (opts.signTransaction) {
      if (!opts.feePayerAddress) {
        throw new FeePayerAddressRequiredError();
      }
    } else if (!opts.feePayer) {
      throw new FeePayerRequiredError();
    }

    const viewPrivKey = Buffer.from(opts.keys.viewPrivKey, 'hex');
    const spendPrivKey = Buffer.from(opts.keys.spendPrivKey, 'hex');
    const spendPubKey = Buffer.from(opts.keys.spendPubKey, 'hex');
    const tokenAddress = resolveTokenAddress(opts.asset, this.networkPassphrase);

    const total = await fetchAnnouncementCount(
      this.contractId,
      this.server,
      this.networkPassphrase,
    );
    const announcements: RawAnnouncement[] = [];
    let offset = 0;
    while (offset < total) {
      const page = await fetchAnnouncements(
        this.contractId,
        this.server,
        this.networkPassphrase,
        offset,
        POOL_PAGE_SIZE,
      );
      if (page.length === 0) break;
      announcements.push(...page);
      offset += page.length;
    }

    const allMatches = scanAnnouncements(
      viewPrivKey,
      spendPubKey,
      announcements.map((a) => ({
        ephemeralPubKey: a.ephemeralPubKey,
        viewTag: a.viewTag,
        stealthAddress: a.stealthAddress,
      })),
    );

    const matchedAnn = announcements.find((a) => {
      if (a.stealthAddress !== stealthAddress) return false;
      return allMatches.some((m) => m?.address === stealthAddress);
    });

    if (!matchedAnn) {
      throw new AnnouncementNotFoundError();
    }

    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      matchedAnn.ephemeralPubKey,
    );

    const balance = await queryBalance(
      this.contractId,
      matchedAnn.stealthPubKey,
      tokenAddress,
      this.server,
      this.networkPassphrase,
    );

    if (balance <= 0n) throw new NoBalanceError();

    let withdrawAmount: bigint;
    if (opts.amount !== undefined) {
      withdrawAmount = numberToStroops(opts.amount);
      if (withdrawAmount > balance) {
        throw new Error(
          `Requested ${opts.amount} but balance is ${formatStroops(balance)}`,
        );
      }
    } else {
      withdrawAmount = balance;
    }

    const currentNonce = await queryNonce(
      this.contractId,
      matchedAnn.stealthPubKey,
      this.server,
      this.networkPassphrase,
    );
    const nonce = currentNonce + 1n;

    const messageHash = buildWithdrawMessage(
      matchedAnn.stealthPubKey,
      tokenAddress,
      withdrawAmount,
      destination,
      nonce,
      this.contractId,
      this.networkPassphrase,
    );

    const signature = stealthPrivKey.sign(messageHash);
    stealthPrivKey.zeroize();

    const feePayerPublicKey = opts.signTransaction
      ? opts.feePayerAddress!
      : Keypair.fromSecret(opts.feePayer).publicKey();
    const contract = new Contract(this.contractId);
    const feePayerAccount = await this.server.getAccount(feePayerPublicKey);

    // Build the withdraw invocation from a given source account. Reused so the
    // restore branch can rebuild on a fresh sequence after the RestoreFootprint
    // consumes the fee payer's next seq (otherwise the withdraw collides →
    // txBAD_SEQ). The non-archived path builds it exactly once.
    const buildWithdrawTx = (
      source: StellarSdk.Account,
    ): StellarSdk.Transaction =>
      new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'withdraw',
            nativeToScVal(Buffer.from(matchedAnn.stealthPubKey)),
            new StellarSdk.Address(tokenAddress).toScVal(),
            nativeToScVal(withdrawAmount, { type: 'i128' }),
            new StellarSdk.Address(destination).toScVal(),
            nativeToScVal(nonce, { type: 'u64' }),
            nativeToScVal(Buffer.from(signature)),
          ),
        )
        .setTimeout(30)
        .build();

    const withdrawTx = buildWithdrawTx(feePayerAccount);

    // Sign the fee-payer leg of any Soroban tx (withdraw or restore).
    const signLeg = (tx: StellarSdk.Transaction): Promise<StellarSdk.Transaction> =>
      signTx(
        tx,
        opts.signTransaction ? feePayerPublicKey : opts.feePayer,
        this.networkPassphrase,
        opts.signTransaction,
      );

    // Submit a signed tx, fee-bumped through the relayer when one is configured,
    // otherwise directly to the RPC. Returns the transaction hash.
    //
    // The relayed path goes through the SDK's RelayerClient — exactly like the
    // account method — so `fundingAccount` (and the signed-challenge auth, when
    // a signer is configured on the client) threads into the `/relay` request.
    // A hand-rolled bare `{xdr}` POST would make a credit-gated relayer reject
    // every pool withdrawal with 402 insufficient_credit. The RelayerClient
    // accepts both a service-root URL and a bare `.../relay` URL (back-compat).
    // The adapter's own RPC server doubles as the confirm-poll handle so
    // `confirm: true` verifies the relayer's txHash against the same network.
    const relayerClient = opts.relay
      ? new RelayerClient(opts.relay, undefined, {
          fundingSigner: opts.fundingSigner,
          rpcServer: this.server,
        })
      : undefined;
    const submit = async (
      signed: StellarSdk.Transaction,
    ): Promise<string> => {
      if (relayerClient) {
        const { txHash } = await relayerClient.relay(
          signed.toEnvelope().toXDR('base64'),
          {
            fundingAccount: opts.fundingAccount,
            networkPassphrase: this.networkPassphrase,
            confirm: opts.confirm,
          },
        );
        return txHash;
      }
      const result = await this.server.sendTransaction(signed);
      return resolveSendResult(this.server, result);
    };

    // Restore an archived Balance/Nonce footprint before assembling the withdraw
    // (prepareTransaction alone ignores sim.restorePreamble — see restore.ts).
    const prepared = await prepareWithRestore(
      withdrawTx,
      buildWithdrawTx,
      this.server,
      this.networkPassphrase,
      signLeg,
      submit,
    );

    const signedWithdraw = await signLeg(prepared);
    const txHash = await submit(signedWithdraw);

    return { txHash, amount: Number(withdrawAmount) / 1e7 };
  }
}
