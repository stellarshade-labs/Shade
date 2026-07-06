import {
  decodeMetaAddress,
  deriveStealthAddressWithSecret,
  scanAnnouncements,
  recoverStealthPrivateKey,
  signWithStealthKey,
} from '@stealth/crypto';
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
  fetchAnnouncements,
  fetchAnnouncementCount,
  queryBalance,
  queryNonce,
  buildWithdrawMessage,
  waitForTransaction,
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
    const { metaAddress, amount, senderSecret, asset } = params;
    if (amount <= 0) throw new Error('Amount must be positive');

    const { spendPubKey, viewPubKey } = decodeMetaAddress(metaAddress);
    const senderKeypair = Keypair.fromSecret(senderSecret);
    const tokenAddress = resolveTokenAddress(asset, this.networkPassphrase);
    const stroops = BigInt(Math.round(amount * 1e7));

    const ephemeralPrivKey = new Uint8Array(randomBytes(32));
    const stealth = deriveStealthAddressWithSecret(
      spendPubKey,
      viewPubKey,
      ephemeralPrivKey,
    );

    const contract = new Contract(this.contractId);
    const account = await this.server.getAccount(senderKeypair.publicKey());

    const depositTx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          'deposit',
          new StellarSdk.Address(senderKeypair.publicKey()).toScVal(),
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
    prepared.sign(senderKeypair);
    const result = await this.server.sendTransaction(prepared);

    if (result.status === 'ERROR') {
      throw new Error('Transaction submission failed');
    }
    if (result.status === 'PENDING') {
      await waitForTransaction(this.server, result.hash);
    }

    return {
      stealthAddress: stealth.stealthAddress,
      txHash: result.hash,
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
        amount: Number(balance) / 1e7,
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
    const receipt = await this.withdraw(payment.stealthAddress, destination, {
      keys: opts.keys,
      feePayer: opts.feePayer ?? '',
      relay: opts.relay,
      asset: opts.asset,
      amount: opts.amount,
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
    },
  ): Promise<{ txHash: string; amount: number }> {
    if (!StrKey.isValidEd25519PublicKey(stealthAddress)) {
      throw new Error('Invalid stealth address');
    }
    if (!StrKey.isValidEd25519PublicKey(destination)) {
      throw new Error('Invalid destination address');
    }
    if (!opts.feePayer) {
      throw new Error('A fee payer secret is required for pool withdrawals');
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
      throw new Error('Could not find announcement for this stealth address');
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

    if (balance <= 0n) throw new Error('Stealth address has no balance in the pool');

    let withdrawAmount: bigint;
    if (opts.amount !== undefined) {
      withdrawAmount = BigInt(Math.round(opts.amount * 1e7));
      if (withdrawAmount > balance) {
        throw new Error(
          `Requested ${opts.amount} but balance is ${Number(balance) / 1e7}`,
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
    );

    const signature = signWithStealthKey(messageHash, stealthPrivKey);

    const feePayerKeypair = Keypair.fromSecret(opts.feePayer);
    const contract = new Contract(this.contractId);
    const feePayerAccount = await this.server.getAccount(
      feePayerKeypair.publicKey(),
    );

    const withdrawTx = new TransactionBuilder(feePayerAccount, {
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

    const prepared = await this.server.prepareTransaction(withdrawTx);
    prepared.sign(feePayerKeypair);

    let txHash: string;
    if (opts.relay) {
      const url = opts.relay.endsWith('/relay') ? opts.relay : `${opts.relay}/relay`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xdr: prepared.toEnvelope().toXDR('base64') }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(`Relay error: ${err.error || 'unknown'}`);
      }
      const data = (await res.json()) as { txHash: string };
      txHash = data.txHash;
    } else {
      const result = await this.server.sendTransaction(prepared);
      if (result.status === 'ERROR') throw new Error('Transaction submission failed');
      if (result.status === 'PENDING') {
        await waitForTransaction(this.server, result.hash);
      }
      txHash = result.hash;
    }

    return { txHash, amount: Number(withdrawAmount) / 1e7 };
  }
}
