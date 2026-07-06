import {
  decodeMetaAddress,
  deriveStealthAddressWithSecret,
  recoverStealthPrivateKey,
  signWithStealthKey,
  scalarMult,
  scalarMultBase,
  pointAdd,
  hashToScalar,
  encodePublicKey,
} from '@stealth/crypto';
import {
  Account,
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { randomBytes } from '@noble/hashes/utils';
import { HorizonClient } from '../horizon.js';
import { MethodNotAvailableError, MinimumAmountError } from '../errors.js';
import type {
  StealthKeys,
  SendReceipt,
  Payment,
  ClaimReceipt,
  ClaimOpts,
} from '../types.js';
import type { DeliveryAdapter, AdapterSendParams } from './types.js';

const HORIZON_PAGE_SIZE = 200;

function isNativeAsset(asset?: string): boolean {
  return !asset || asset === 'native' || asset === 'XLM';
}

/**
 * Recompute the receiver-side stealth address from the ephemeral key R.
 *
 * `S = k_view * R`, `s = SHA256(S) mod L`, `P = K_spend + s*G`. Encoding P as a
 * StrKey G-address gives the exact stealth address the sender created — matching
 * it against the transaction's destination IS the full DKSAP verification, so no
 * separate view tag is required for the account method.
 */
export function computeReceiverStealthAddress(
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
): string {
  const S = scalarMult(viewPrivKey, ephemeralPubKey);
  const s = hashToScalar(S);
  const sG = scalarMultBase(s);
  const P = pointAdd(spendPubKey, sG);
  return encodePublicKey(P);
}

/**
 * The account delivery adapter: a direct classic Stellar payment that
 * creates/pays a one-time stealth account, with the ephemeral key R carried in
 * a 32-byte MemoHash. No view tag is needed — the destination match against the
 * DKSAP-derived address IS the full verification. Native XLM only for now.
 */
export class AccountAdapter implements DeliveryAdapter {
  readonly method = 'account' as const;

  constructor(
    private readonly networkPassphrase: string,
    private readonly horizon: HorizonClient,
    private readonly relayer?: string,
  ) {}

  /**
   * Send native XLM directly to a one-time stealth account. Amount MUST be
   * strictly greater than 1 XLM. Uses CreateAccount; on `op_already_exists`
   * (e.g. a retry) it rebuilds the send as a Payment to the same destination
   * with the same memo — the scanner matches both op types.
   */
  async send(params: AdapterSendParams): Promise<SendReceipt> {
    const { metaAddress, amount, senderSecret, asset } = params;
    if (!isNativeAsset(asset)) {
      throw new MethodNotAvailableError(
        'token sends via the account method arrive in a later stage',
      );
    }
    if (amount <= 1) {
      throw new MinimumAmountError(amount);
    }

    const { spendPubKey, viewPubKey } = decodeMetaAddress(metaAddress);
    const ephemeralPrivKey = new Uint8Array(randomBytes(32));
    const stealth = deriveStealthAddressWithSecret(
      spendPubKey,
      viewPubKey,
      ephemeralPrivKey,
    );

    const memo = Memo.hash(Buffer.from(stealth.ephemeralPubKey));
    const startingBalance = amount.toFixed(7);

    const submit = async (useCreate: boolean): Promise<string> => {
      const senderKeypair = Keypair.fromSecret(senderSecret);
      const account = await this.horizon.getAccount(senderKeypair.publicKey());
      if (!account) {
        throw new Error('Sender account not found on Horizon — is it funded?');
      }
      const source = new Account(account.id, account.sequence);

      const op = useCreate
        ? Operation.createAccount({
            destination: stealth.stealthAddress,
            startingBalance,
          })
        : Operation.payment({
            destination: stealth.stealthAddress,
            asset: Asset.native(),
            amount: startingBalance,
          });

      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .addMemo(memo)
        .setTimeout(30)
        .build();

      tx.sign(senderKeypair);
      const res = await this.horizon.submitTransaction(
        tx.toEnvelope().toXDR('base64'),
      );
      return res.hash;
    };

    let txHash: string;
    try {
      txHash = await submit(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('op_already_exists')) {
        txHash = await submit(false);
      } else {
        throw err;
      }
    }

    return { stealthAddress: stealth.stealthAddress, txHash };
  }

  /**
   * Discover incoming direct payments by paging Horizon transactions in
   * ascending order. For each tx with a hash memo, the memo decodes to a
   * candidate R; deriving the stealth address from (viewPrivKey, spendPubKey, R)
   * and finding an operation (create_account or payment) whose destination
   * equals that address confirms the payment is ours.
   */
  async scan(
    keys: StealthKeys,
    cursor?: string,
  ): Promise<{ payments: Payment[]; cursor?: string }> {
    const viewPrivKey = new Uint8Array(Buffer.from(keys.viewPrivKey, 'hex'));
    const spendPubKey = new Uint8Array(Buffer.from(keys.spendPubKey, 'hex'));

    const payments: Payment[] = [];
    let pageCursor = cursor;
    let lastToken = cursor;

    for (;;) {
      const txs = await this.horizon.getTransactions(pageCursor, HORIZON_PAGE_SIZE);
      if (txs.length === 0) break;

      for (const tx of txs) {
        lastToken = tx.paging_token;
        if (tx.memo_type !== 'hash' || !tx.memo) continue;
        if (tx.successful === false) continue;

        const ephemeralPubKey = new Uint8Array(Buffer.from(tx.memo, 'base64'));
        if (ephemeralPubKey.length !== 32) continue;

        let derivedAddress: string;
        try {
          derivedAddress = computeReceiverStealthAddress(
            viewPrivKey,
            spendPubKey,
            ephemeralPubKey,
          );
        } catch {
          continue;
        }

        const ops = await this.horizon.getTransactionOperations(tx.hash);
        const match = ops.find(
          (op) =>
            (op.type === 'create_account' && op.account === derivedAddress) ||
            (op.type === 'payment' && op.to === derivedAddress),
        );
        if (!match) continue;

        const amountStr =
          match.type === 'create_account' ? match.starting_balance : match.amount;

        payments.push({
          stealthAddress: derivedAddress,
          ephemeralPubKey: Buffer.from(ephemeralPubKey).toString('hex'),
          token: 'native',
          amount: amountStr ? Number(amountStr) : 0,
          method: 'account',
          txHash: tx.hash,
        });
      }

      if (txs.length < HORIZON_PAGE_SIZE) break;
      pageCursor = txs[txs.length - 1]!.paging_token;
    }

    return { payments, cursor: lastToken };
  }

  /**
   * Claim a direct-account payment. The stealth account is a real funded
   * Stellar account with a sequence number. Full sweep (default) uses
   * AccountMerge; a partial claim uses Payment. Signing uses the raw stealth
   * scalar (verifies as standard ed25519). Optionally fee-bumped via a relayer.
   */
  async claim(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    const viewPrivKey = new Uint8Array(Buffer.from(opts.keys.viewPrivKey, 'hex'));
    const spendPrivKey = new Uint8Array(Buffer.from(opts.keys.spendPrivKey, 'hex'));
    const ephemeralPubKey = new Uint8Array(
      Buffer.from(payment.ephemeralPubKey, 'hex'),
    );

    const stealthPrivKey = recoverStealthPrivateKey(
      spendPrivKey,
      viewPrivKey,
      ephemeralPubKey,
    );

    const stealthAddress = payment.stealthAddress;
    const account = await this.horizon.getAccount(stealthAddress);
    if (!account) {
      throw new Error(
        'Stealth account not found on Horizon — has the send confirmed?',
      );
    }

    const source = new Account(account.id, account.sequence);
    const merge = opts.merge !== false;

    const builder = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    let amount: number;
    if (merge) {
      builder.addOperation(Operation.accountMerge({ destination }));
      const native = account.balances.find((b) => b.asset_type === 'native');
      amount = native ? Number(native.balance) : 0;
    } else {
      if (opts.amount === undefined) {
        throw new Error('Partial account claim requires opts.amount');
      }
      builder.addOperation(
        Operation.payment({
          destination,
          asset: Asset.native(),
          amount: opts.amount.toFixed(7),
        }),
      );
      amount = opts.amount;
    }

    const tx = builder.setTimeout(30).build();
    const sig = signWithStealthKey(tx.hash(), stealthPrivKey);
    tx.addSignature(stealthAddress, Buffer.from(sig).toString('base64'));

    const relay = opts.relay ?? this.relayer;
    let txHash: string;
    if (relay) {
      const url = relay.endsWith('/relay') ? relay : `${relay}/relay`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xdr: tx.toEnvelope().toXDR('base64') }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(`Relay error: ${err.error || 'unknown'}`);
      }
      const data = (await res.json()) as { txHash: string };
      txHash = data.txHash;
    } else {
      const res = await this.horizon.submitTransaction(
        tx.toEnvelope().toXDR('base64'),
      );
      txHash = res.hash;
    }

    return { txHash, amount, method: 'account' };
  }
}
