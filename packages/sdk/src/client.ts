import {
  generateMetaAddress,
  encodeMetaAddress,
  decodeMetaAddress,
  deriveStealthAddressWithSecret,
  scanAnnouncements,
  recoverStealthPrivateKey,
  signWithStealthKey,
  generateMnemonic,
  mnemonicToStealthKeys,
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
  getNetworkConfig,
  resolveTokenAddress,
  fetchAnnouncements,
  queryBalance,
  queryNonce,
  buildWithdrawMessage,
  waitForTransaction,
} from './soroban.js';
import type {
  ClientConfig,
  StealthKeys,
  SendReceipt,
  SendOpts,
  Payment,
  Balance,
  WithdrawReceipt,
  WithdrawOpts,
} from './types.js';

/** Default contract addresses per network. */
const DEFAULT_CONTRACTS: Record<string, string> = {
  local: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGABAX',
};

/**
 * High-level client for stealth payments on Stellar.
 *
 * Wraps DKSAP cryptography and Soroban contract interaction into a simple API.
 * Developers don't need to understand the underlying protocol to use this.
 *
 * @example
 * ```typescript
 * const client = new StealthClient({ network: 'local', contractId: 'CXXX...' });
 *
 * // Generate keys
 * const keys = StealthClient.keygen();
 *
 * // Send 100 XLM to a stealth address
 * const receipt = await client.send(keys.metaAddress, 100, 'SXXX...');
 *
 * // Scan for received payments
 * const payments = await client.scan(keys);
 *
 * // Withdraw
 * await client.withdraw(payments[0].stealthAddress, 'GDEST...', {
 *   keys,
 *   feePayer: 'SXXX...',
 * });
 * ```
 */
export class StealthClient {
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly server: StellarSdk.rpc.Server;

  constructor(config: ClientConfig) {
    this.contractId = config.contractId || DEFAULT_CONTRACTS[config.network] || '';
    const netConfig = getNetworkConfig(config.network);
    this.networkPassphrase = netConfig.networkPassphrase;
    this.server = netConfig.server;
  }

  /**
   * Generate a new random stealth key pair.
   * No network connection needed.
   */
  static keygen(): StealthKeys {
    const keys = generateMetaAddress();
    const metaAddress = encodeMetaAddress(keys.metaAddress);

    return {
      metaAddress,
      spendPubKey: Buffer.from(keys.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(keys.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(keys.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(keys.viewPrivKey).toString('hex'),
    };
  }

  /**
   * Generate stealth keys from a BIP-39 mnemonic.
   * Returns the mnemonic alongside the keys for backup.
   * No network connection needed.
   */
  static fromMnemonic(mnemonic?: string): StealthKeys & { mnemonic: string } {
    const phrase = mnemonic || generateMnemonic();
    const keys = mnemonicToStealthKeys(phrase);
    const metaAddress = encodeMetaAddress(keys.metaAddress);

    return {
      mnemonic: phrase,
      metaAddress,
      spendPubKey: Buffer.from(keys.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(keys.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(keys.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(keys.viewPrivKey).toString('hex'),
    };
  }

  /**
   * Send tokens to a stealth address.
   *
   * Derives a one-time stealth address from the recipient's meta-address,
   * deposits tokens into the pool contract, and records the announcement.
   *
   * @param metaAddress - Recipient's meta-address (st:stellar:... format)
   * @param amount - Amount in whole units (e.g. 100 = 100 XLM)
   * @param senderSecret - Sender's Stellar secret key
   * @param opts - Optional: asset to send
   */
  async send(
    metaAddress: string,
    amount: number,
    senderSecret: string,
    opts?: SendOpts,
  ): Promise<SendReceipt> {
    if (amount <= 0) throw new Error('Amount must be positive');

    const { spendPubKey, viewPubKey } = decodeMetaAddress(metaAddress);
    const senderKeypair = Keypair.fromSecret(senderSecret);
    const tokenAddress = resolveTokenAddress(opts?.asset, this.networkPassphrase);
    const stroops = BigInt(Math.round(amount * 1e7));

    // Derive stealth address
    const ephemeralPrivKey = new Uint8Array(randomBytes(32));
    const stealth = deriveStealthAddressWithSecret(
      spendPubKey,
      viewPubKey,
      ephemeralPrivKey,
    );

    // Build and submit deposit transaction
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
   * Scan for stealth payments you received.
   *
   * Uses the view key to detect which announcements are yours,
   * then queries the contract for current balances.
   *
   * @param keys - Your stealth keys (needs viewPrivKey + spendPubKey)
   */
  async scan(keys: StealthKeys): Promise<Payment[]> {
    const viewPrivKey = Buffer.from(keys.viewPrivKey, 'hex');
    const spendPubKey = Buffer.from(keys.spendPubKey, 'hex');

    const announcements = await fetchAnnouncements(
      this.contractId,
      this.server,
      this.networkPassphrase,
    );

    if (announcements.length === 0) return [];

    const matches = scanAnnouncements(
      viewPrivKey,
      spendPubKey,
      announcements.map(a => ({
        ephemeralPubKey: a.ephemeralPubKey,
        viewTag: a.viewTag,
        stealthAddress: a.stealthAddress,
      })),
    );

    const payments: Payment[] = [];

    for (const match of matches) {
      if (!match) continue;
      const ann = announcements.find(a => a.stealthAddress === match.address);
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
      });
    }

    return payments;
  }

  /**
   * Get balances for all your stealth addresses in the pool.
   *
   * @param keys - Your stealth keys (needs viewPrivKey + spendPubKey)
   */
  async balance(keys: StealthKeys): Promise<Balance[]> {
    const payments = await this.scan(keys);
    return payments.map(p => ({
      stealthAddress: p.stealthAddress,
      token: p.token,
      amount: p.amount,
    }));
  }

  /**
   * Withdraw tokens from the stealth pool.
   *
   * Recovers the stealth private key, signs a withdraw message,
   * and submits the transaction. Use `opts.relay` for privacy-preserving
   * withdrawal via a relayer.
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
    if (!StrKey.isValidEd25519PublicKey(stealthAddress)) {
      throw new Error('Invalid stealth address');
    }
    if (!StrKey.isValidEd25519PublicKey(destination)) {
      throw new Error('Invalid destination address');
    }

    const viewPrivKey = Buffer.from(opts.keys.viewPrivKey, 'hex');
    const spendPrivKey = Buffer.from(opts.keys.spendPrivKey, 'hex');
    const spendPubKey = Buffer.from(opts.keys.spendPubKey, 'hex');
    const tokenAddress = resolveTokenAddress(opts.asset, this.networkPassphrase);

    // Find matching announcement
    const announcements = await fetchAnnouncements(
      this.contractId,
      this.server,
      this.networkPassphrase,
    );

    const allMatches = scanAnnouncements(
      viewPrivKey,
      spendPubKey,
      announcements.map(a => ({
        ephemeralPubKey: a.ephemeralPubKey,
        viewTag: a.viewTag,
        stealthAddress: a.stealthAddress,
      })),
    );

    const matchedAnn = announcements.find(a => {
      if (a.stealthAddress !== stealthAddress) return false;
      return allMatches.some(m => m?.address === stealthAddress);
    });

    if (!matchedAnn) {
      throw new Error('Could not find announcement for this stealth address');
    }

    // Recover stealth private key
    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      matchedAnn.ephemeralPubKey,
    );

    // Get balance
    const balance = await queryBalance(
      this.contractId,
      matchedAnn.stealthPubKey,
      tokenAddress,
      this.server,
      this.networkPassphrase,
    );

    if (balance <= 0n) throw new Error('Stealth address has no balance in the pool');

    // Determine amount
    let withdrawAmount: bigint;
    if (opts.amount !== undefined) {
      withdrawAmount = BigInt(Math.round(opts.amount * 1e7));
      if (withdrawAmount > balance) {
        throw new Error(`Requested ${opts.amount} but balance is ${Number(balance) / 1e7}`);
      }
    } else {
      withdrawAmount = balance;
    }

    // Get nonce and build signed message
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

    // Build transaction
    const feePayerKeypair = Keypair.fromSecret(opts.feePayer);
    const contract = new Contract(this.contractId);
    const feePayerAccount = await this.server.getAccount(feePayerKeypair.publicKey());

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

    // Submit (direct or via relay)
    let txHash: string;

    if (opts.relay) {
      const url = opts.relay.endsWith('/relay') ? opts.relay : `${opts.relay}/relay`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xdr: prepared.toEnvelope().toXDR('base64') }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(`Relay error: ${err.error || 'unknown'}`);
      }
      const data = await res.json() as { txHash: string };
      txHash = data.txHash;
    } else {
      const result = await this.server.sendTransaction(prepared);
      if (result.status === 'ERROR') throw new Error('Transaction submission failed');
      if (result.status === 'PENDING') {
        await waitForTransaction(this.server, result.hash);
      }
      txHash = result.hash;
    }

    return {
      txHash,
      amount: Number(withdrawAmount) / 1e7,
    };
  }
}
