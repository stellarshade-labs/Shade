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
  Transaction,
  Operation,
  Asset,
  Claimant,
  Memo,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { randomBytes } from '@noble/hashes/utils';
import { HorizonClient } from '../horizon.js';
import { RelayerClient } from '../relayer.js';
import {
  MinimumAmountError,
  ClaimAmountError,
  InvalidAmountError,
  SponsoredClaimMismatchError,
} from '../errors.js';
import type {
  StealthKeys,
  SendReceipt,
  Payment,
  ClaimReceipt,
  ClaimOpts,
} from '../types.js';
import type { DeliveryAdapter, AdapterSendParams } from './types.js';

const HORIZON_PAGE_SIZE = 200;

/**
 * Reserves the sender fronts on a token send: 1 XLM to open the stealth account
 * plus 0.5 XLM trustline headroom plus a little fee slack. The 0.5 XLM
 * claimable-balance reserve returns to the sender when the balance is claimed.
 */
const TOKEN_ACCOUNT_STARTING_BALANCE = '1.5001';

function isNativeAsset(asset?: string): boolean {
  return !asset || asset === 'native' || asset === 'XLM';
}

/** Parse a "CODE:ISSUER" asset string into a Stellar Asset. */
function parseAsset(asset: string): Asset {
  if (isNativeAsset(asset)) return Asset.native();
  const [code, issuer] = asset.split(':');
  if (!code || !issuer) {
    throw new Error(`Invalid asset "${asset}" — expected CODE:ISSUER`);
  }
  return new Asset(code, issuer);
}

/** Render an Asset back to Horizon's "CODE:ISSUER" (or 'native') string form. */
function assetToString(asset: Asset): string {
  return asset.isNative() ? 'native' : `${asset.getCode()}:${asset.getIssuer()}`;
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
 * DKSAP-derived address IS the full verification.
 *
 * Native XLM lands via CreateAccount/Payment; tokens land as a
 * CreateClaimableBalance the recipient later claims (adding a trustline first).
 */
export class AccountAdapter implements DeliveryAdapter {
  readonly method = 'account' as const;
  private readonly relayerClient?: RelayerClient;

  constructor(
    private readonly networkPassphrase: string,
    private readonly horizon: HorizonClient,
    private readonly relayer?: string,
  ) {
    if (relayer) this.relayerClient = new RelayerClient(relayer);
  }

  /**
   * Send funds directly to a one-time stealth account. Native XLM uses a plain
   * CreateAccount/Payment; a non-native asset uses CreateAccount (to open the
   * stealth account) plus a CreateClaimableBalance carrying the token. Amount
   * MUST be strictly greater than 1 XLM for native sends.
   */
  async send(params: AdapterSendParams): Promise<SendReceipt> {
    const { asset } = params;
    if (!isNativeAsset(asset)) {
      return this.sendToken(params);
    }
    return this.sendNative(params);
  }

  /** Native XLM send: CreateAccount (falls back to Payment on retry). */
  private async sendNative(params: AdapterSendParams): Promise<SendReceipt> {
    const { metaAddress, amount, senderSecret } = params;
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
   * Token send: one classic tx carrying two operations —
   * CreateAccount(stealth, 1.5001 XLM) to open the account with trustline
   * headroom, then CreateClaimableBalance(asset, amount, claimant: stealth,
   * unconditional). The 0.5 XLM claimable-balance reserve returns to the sender
   * when the recipient claims. The ephemeral R rides in the MemoHash exactly as
   * for native sends.
   *
   * Not idempotent on retry: unlike {@link sendNative} (which falls back to a
   * Payment on `op_already_exists`), a token send has no such fallback. Each
   * token send uses a fresh ephemeral — hence a fresh, never-before-created
   * stealth address — so a resubmit targets a new account rather than colliding,
   * making the retry path unnecessary here.
   */
  private async sendToken(params: AdapterSendParams): Promise<SendReceipt> {
    const { metaAddress, amount, senderSecret, asset } = params;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InvalidAmountError(amount);
    }
    const stellarAsset = parseAsset(asset!);

    const { spendPubKey, viewPubKey } = decodeMetaAddress(metaAddress);
    const ephemeralPrivKey = new Uint8Array(randomBytes(32));
    const stealth = deriveStealthAddressWithSecret(
      spendPubKey,
      viewPubKey,
      ephemeralPrivKey,
    );

    const memo = Memo.hash(Buffer.from(stealth.ephemeralPubKey));
    const senderKeypair = Keypair.fromSecret(senderSecret);
    const account = await this.horizon.getAccount(senderKeypair.publicKey());
    if (!account) {
      throw new Error('Sender account not found on Horizon — is it funded?');
    }
    const source = new Account(account.id, account.sequence);

    const claimant = new Claimant(
      stealth.stealthAddress,
      Claimant.predicateUnconditional(),
    );

    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.createAccount({
          destination: stealth.stealthAddress,
          startingBalance: TOKEN_ACCOUNT_STARTING_BALANCE,
        }),
      )
      .addOperation(
        Operation.createClaimableBalance({
          asset: stellarAsset,
          amount: amount.toFixed(7),
          claimants: [claimant],
        }),
      )
      .addMemo(memo)
      .setTimeout(30)
      .build();

    tx.sign(senderKeypair);
    const res = await this.horizon.submitTransaction(
      tx.toEnvelope().toXDR('base64'),
    );

    return { stealthAddress: stealth.stealthAddress, txHash: res.hash };
  }

  /**
   * Discover incoming direct payments by paging Horizon transactions in
   * ascending order. For each tx with a hash memo, the memo decodes to a
   * candidate R; deriving the stealth address from (viewPrivKey, spendPubKey, R)
   * and finding an operation whose destination equals that address confirms the
   * payment is ours. Three op shapes are matched:
   * - `create_account` / `payment` -> a native XLM send.
   * - `create_claimable_balance` with our address as a claimant -> a token send;
   *   the claimable balance id is resolved via Horizon's claimable-balances API.
   */
  async scan(
    keys: StealthKeys,
    cursor?: string,
    opts?: { suppressClaimedNative?: boolean },
  ): Promise<{ payments: Payment[]; cursor?: string }> {
    const suppressClaimedNative = opts?.suppressClaimedNative ?? false;
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
        const ephHex = Buffer.from(ephemeralPubKey).toString('hex');

        const cbMatch = ops.find(
          (op) =>
            op.type === 'create_claimable_balance' &&
            (op.claimants ?? []).some((c) => c.destination === derivedAddress),
        );

        const nativeMatch = ops.find(
          (op) =>
            (op.type === 'create_account' && op.account === derivedAddress) ||
            (op.type === 'payment' && op.to === derivedAddress),
        );
        // Suppress the native leg ONLY when it is the token funding stub — a
        // CreateAccount whose starting balance is exactly the token-account
        // reserve constant (1.5001). Any other native amount (e.g. a genuine
        // 500 XLM CreateAccount bundled with a token) is real income and is
        // reported alongside the token payment.
        const isTokenFundingStub =
          !!nativeMatch &&
          nativeMatch.type === 'create_account' &&
          Number(nativeMatch.starting_balance) ===
            Number(TOKEN_ACCOUNT_STARTING_BALANCE);

        if (nativeMatch && !isTokenFundingStub) {
          // The income for THIS tx is the op amount (create_account
          // starting_balance / payment amount), not the account's aggregate
          // live balance — two sends to the same derived address, or a partial
          // spend, must each report their own op amount and txHash.
          const opAmount =
            nativeMatch.type === 'create_account'
              ? Number(nativeMatch.starting_balance ?? 0)
              : Number(nativeMatch.amount ?? 0);

          // Suppression (null-safe): only probe liveness when the merge flag is
          // set, to drop a fully-swept account rather than re-surfacing it
          // forever. A null/absent account or absent native balance is treated
          // as "unknown, not proven claimed" and falls back to the op amount —
          // never conflating current spendable balance with income for this tx.
          let claimed = false;
          if (suppressClaimedNative) {
            const live = await this.horizon.getAccount(derivedAddress);
            if (live) {
              const nativeBal = live.balances.find(
                (b) => b.asset_type === 'native',
              );
              claimed = nativeBal !== undefined && Number(nativeBal.balance) === 0;
            }
          }

          if (!claimed && opAmount > 0) {
            payments.push({
              stealthAddress: derivedAddress,
              ephemeralPubKey: ephHex,
              token: 'native',
              amount: opAmount,
              method: 'account',
              txHash: tx.hash,
            });
          }
        }

        if (cbMatch) {
          // Only report the claimable balance if it still exists live — an
          // already-claimed CB is dropped rather than re-surfaced.
          const cb = (await this.horizon.getClaimableBalances(derivedAddress)).find(
            (b) => b.claimants.some((c) => c.destination === derivedAddress),
          );
          if (cb) {
            payments.push({
              stealthAddress: derivedAddress,
              ephemeralPubKey: ephHex,
              token: cbMatch.asset ?? cb.asset ?? 'unknown',
              asset: cbMatch.asset ?? cb.asset,
              claimableBalanceId: cb.id,
              amount: Number(cb.amount),
              method: 'account',
              txHash: tx.hash,
            });
          }
        }
      }

      if (txs.length < HORIZON_PAGE_SIZE) break;
      pageCursor = txs[txs.length - 1]!.paging_token;
    }

    return { payments, cursor: lastToken };
  }

  /**
   * Claim a direct-account payment. Branches on the payment shape: a claimable
   * balance (token send) runs the trustline + claim recipe; a plain XLM send
   * sweeps or partially pays out the stealth account.
   */
  async claim(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    const isToken = !!payment.claimableBalanceId || !isNativeAsset(payment.asset);
    if (isToken) {
      return this.claimToken(payment, destination, opts);
    }
    return this.claimNative(payment, destination, opts);
  }

  /**
   * Claim a native XLM direct send. The stealth account is a real funded Stellar
   * account with a sequence number. Full sweep (default) uses AccountMerge; a
   * partial claim uses Payment. Signing uses the raw stealth scalar (verifies as
   * standard ed25519). Optionally fee-bumped via a relayer.
   */
  private async claimNative(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    const stealthPrivKey = this.recoverKey(payment, opts);
    const stealthAddress = payment.stealthAddress;
    const account = await this.horizon.getAccount(stealthAddress);
    if (!account) {
      throw new Error(
        'Stealth account not found on Horizon — has the send confirmed?',
      );
    }

    const source = new Account(account.id, account.sequence);
    const merge = opts.merge !== false;
    const relayed = !!(opts.relay ?? this.relayer);
    const feeXlm = Number(BASE_FEE) / 1e7;
    const nativeBal = account.balances.find((b) => b.asset_type === 'native');
    const nativeBalance = nativeBal ? Number(nativeBal.balance) : 0;

    const builder = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    let amount: number;
    if (merge) {
      builder.addOperation(Operation.accountMerge({ destination }));
      // A full merge delivers the whole native balance. When the stealth
      // account self-pays the fee (not relayed), the destination receives the
      // balance minus that fee — subtract it so the receipt does not overstate
      // what actually arrives.
      amount = relayed ? nativeBalance : nativeBalance - feeXlm;
    } else {
      if (opts.amount === undefined) {
        throw new Error('Partial account claim requires opts.amount');
      }
      // The account must retain 2x the base reserve (1.0 XLM) and cover the fee
      // (self-paid when not relayed). Reject an over-large partial before
      // building so it fails with a typed error, not an on-chain op_underfunded
      // after the fee is burned.
      const maxClaimable = nativeBalance - 1.0 - feeXlm;
      if (opts.amount > maxClaimable) {
        throw new ClaimAmountError(opts.amount, maxClaimable);
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

    const txHash = await this.submit(tx.toEnvelope().toXDR('base64'), opts);
    return { txHash, amount, method: 'account' };
  }

  /**
   * Claim a token direct send delivered as a claimable balance. Requires the
   * destination to already trust the asset (probed first with an actionable
   * error otherwise).
   *
   * Self-funded path (stealth account exists): ChangeTrust(asset) ->
   * ClaimClaimableBalance(id) -> optional full exit
   * [Payment(asset, destination) -> ChangeTrust(limit '0') ->
   * AccountMerge(destination)].
   *
   * Sponsored path (`opts.sponsored`, or account stub missing): delegate to the
   * relayer's sponsor-claim pair — prepare returns XDR, we attach the stealth
   * signature and submit.
   */
  private async claimToken(
    payment: Payment,
    destination: string,
    opts: ClaimOpts,
  ): Promise<ClaimReceipt> {
    if (!payment.claimableBalanceId) {
      throw new Error('Token claim requires a claimableBalanceId on the payment');
    }
    const asset = payment.asset ?? payment.token;
    const stellarAsset = parseAsset(asset);
    const amount = payment.amount;

    await this.assertDestinationTrusts(destination, stellarAsset);

    const stealthAddress = payment.stealthAddress;
    const account = await this.horizon.getAccount(stealthAddress);
    const relay = opts.relay ?? this.relayer;

    if (opts.sponsored || !account) {
      if (!relay) {
        throw new Error(
          'Sponsored token claim requires a relayer URL (opts.relay or client relayer).',
        );
      }
      return this.claimTokenSponsored(payment, opts, relay, amount, destination);
    }

    const stealthPrivKey = this.recoverKey(payment, opts);
    const source = new Account(account.id, account.sequence);
    const merge = opts.merge !== false;

    const builder = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.changeTrust({ asset: stellarAsset }))
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: payment.claimableBalanceId,
        }),
      );

    if (merge) {
      builder
        .addOperation(
          Operation.payment({
            destination,
            asset: stellarAsset,
            amount: amount.toFixed(7),
          }),
        )
        .addOperation(Operation.changeTrust({ asset: stellarAsset, limit: '0' }))
        .addOperation(Operation.accountMerge({ destination }));
    }

    const tx = builder.setTimeout(30).build();
    const sig = signWithStealthKey(tx.hash(), stealthPrivKey);
    tx.addSignature(stealthAddress, Buffer.from(sig).toString('base64'));

    const txHash = await this.submit(tx.toEnvelope().toXDR('base64'), opts);
    return { txHash, amount, method: 'account' };
  }

  /**
   * Sponsored claim: relayer prepares the XDR (BeginSponsoring -> [CreateAccount]
   * -> ChangeTrust -> EndSponsoring -> ClaimClaimableBalance -> Payment to the
   * destination), we co-sign with the stealth key, relayer submits and pays the
   * fee. The claimed token is delivered to `destination` in the same tx — the
   * stealth account never needs its own fee balance. The receipt's amount is the
   * amount that reached the destination.
   */
  private async claimTokenSponsored(
    payment: Payment,
    opts: ClaimOpts,
    relay: string,
    amount: number,
    destination: string,
  ): Promise<ClaimReceipt> {
    const client = this.relayerClient ?? new RelayerClient(relay);
    const asset = payment.asset ?? payment.token;

    const balanceId = payment.claimableBalanceId;
    if (!balanceId) {
      throw new Error('Sponsored token claim requires a claimableBalanceId');
    }

    const payoutAmount = amount.toFixed(7);
    const { xdr } = await client.sponsorClaimPrepare({
      stealthAddress: payment.stealthAddress,
      asset,
      balanceId,
      destination,
      amount: payoutAmount,
    });

    // CRITICAL: verify the relayer-prepared XDR against our OWN trusted inputs
    // BEFORE signing. A malicious relayer could otherwise redirect the payout
    // Payment or append an AccountMerge to steal the just-claimed token — the
    // relayer-side opsMatch protects the relayer, not us.
    const tx = this.verifySponsoredClaimXdr(xdr, {
      stealthAddress: payment.stealthAddress,
      asset,
      balanceId,
      destination,
      payoutAmount,
    });

    const stealthPrivKey = this.recoverKey(payment, opts);
    const sig = signWithStealthKey(tx.hash(), stealthPrivKey);
    tx.addSignature(payment.stealthAddress, Buffer.from(sig).toString('base64'));

    const { txHash } = await client.sponsorClaimSubmit(
      tx.toEnvelope().toXDR('base64'),
      {
        stealthAddress: payment.stealthAddress,
        asset,
        balanceId,
        destination,
        amount: payoutAmount,
        fundingAccount: opts.fundingAccount,
      },
    );
    return { txHash, amount, method: 'account' };
  }

  /**
   * Parse and verify a relayer-prepared sponsored-claim XDR against the client's
   * OWN trusted inputs BEFORE signing. This is the client-side security control:
   * the relayer-side `opsMatch` protects the relayer, not us, so a malicious
   * relayer could otherwise redirect the payout Payment or append an
   * AccountMerge to steal the just-claimed token.
   *
   * Verifies, throwing {@link SponsoredClaimMismatchError} on any mismatch:
   * - the tx is sourced by the relayer (never the stealth account);
   * - the tx carries no memo;
   * - every operation is one of the allowed sponsor-claim shapes, in the exact
   *   order the relayer builds — BeginSponsoring(stealth) -> optional
   *   CreateAccount(stealth, '0') -> ChangeTrust(asset, source stealth) ->
   *   EndSponsoring(source stealth) -> ClaimClaimableBalance(balanceId, source
   *   stealth) -> Payment(destination, asset, amount, source stealth);
   * - every value-moving op is sourced by the stealth account;
   * - the payout Payment's destination/asset/amount equal the caller's intent;
   * - no extra, missing, or reordered operations.
   *
   * Returns the parsed {@link Transaction} (ready to co-sign) on success.
   */
  private verifySponsoredClaimXdr(
    xdr: string,
    expected: {
      stealthAddress: string;
      asset: string;
      balanceId: string;
      destination: string;
      payoutAmount: string;
    },
  ): Transaction {
    let tx: Transaction;
    try {
      tx = new Transaction(xdr, this.networkPassphrase);
    } catch {
      throw new SponsoredClaimMismatchError('prepared XDR is not a valid transaction');
    }

    if (tx.memo && tx.memo.type !== 'none') {
      throw new SponsoredClaimMismatchError('unexpected memo on the prepared transaction');
    }

    const relayer = tx.source;
    const { stealthAddress, balanceId, destination, payoutAmount } = expected;
    const wantAsset = parseAsset(expected.asset);
    const wantAssetStr = wantAsset.isNative()
      ? 'native'
      : `${wantAsset.getCode()}:${wantAsset.getIssuer()}`;

    // Rebuild the exact op sequence the relayer must have produced. CreateAccount
    // is optional (only when the stealth account did not already exist), so we
    // build both a with-create and without-create expectation and require the
    // submitted ops to match one of them positionally.
    // Normalize a decimal amount string so '0' and '0.0000000' (and '100' vs
    // '100.0000000') compare equal regardless of how the SDK re-serialized it.
    const amt = (value: string): string => String(Number(value));

    const opStr = (op: Operation): string => {
      const src = op.source ?? relayer;
      switch (op.type) {
        case 'beginSponsoringFutureReserves':
          return `begin|${src}|${(op as Operation.BeginSponsoringFutureReserves).sponsoredId}`;
        case 'createAccount': {
          const o = op as Operation.CreateAccount;
          return `create|${src}|${o.destination}|${amt(o.startingBalance)}`;
        }
        case 'changeTrust': {
          const o = op as Operation.ChangeTrust;
          return `trust|${src}|${assetToString(o.line as Asset)}`;
        }
        case 'endSponsoringFutureReserves':
          return `end|${src}`;
        case 'claimClaimableBalance':
          return `claim|${src}|${(op as Operation.ClaimClaimableBalance).balanceId}`;
        case 'payment': {
          const o = op as Operation.Payment;
          return `pay|${src}|${o.destination}|${assetToString(o.asset as Asset)}|${amt(o.amount)}`;
        }
        default:
          return `UNSUPPORTED:${op.type}|${src}`;
      }
    };

    const buildExpected = (withCreate: boolean): string[] => {
      const ops: string[] = [];
      ops.push(`begin|${relayer}|${stealthAddress}`);
      // CreateAccount inherits the tx (relayer) source in the relayer's build.
      if (withCreate) ops.push(`create|${relayer}|${stealthAddress}|${amt('0')}`);
      ops.push(`trust|${stealthAddress}|${wantAssetStr}`);
      ops.push(`end|${stealthAddress}`);
      ops.push(`claim|${stealthAddress}|${balanceId}`);
      ops.push(`pay|${stealthAddress}|${destination}|${wantAssetStr}|${amt(payoutAmount)}`);
      return ops;
    };

    const submitted = tx.operations.map(opStr);
    const withCreate = buildExpected(true).join('\n');
    const withoutCreate = buildExpected(false).join('\n');
    const actual = submitted.join('\n');
    if (actual !== withCreate && actual !== withoutCreate) {
      throw new SponsoredClaimMismatchError(
        `operations do not match the expected sponsor-claim sequence (got: ${actual})`,
      );
    }

    return tx;
  }

  /** Recover the raw stealth scalar for signing from the payment's ephemeral R. */
  private recoverKey(payment: Payment, opts: ClaimOpts): Uint8Array {
    const viewPrivKey = new Uint8Array(Buffer.from(opts.keys.viewPrivKey, 'hex'));
    const spendPrivKey = new Uint8Array(
      Buffer.from(opts.keys.spendPrivKey, 'hex'),
    );
    const ephemeralPubKey = new Uint8Array(
      Buffer.from(payment.ephemeralPubKey, 'hex'),
    );
    return recoverStealthPrivateKey(spendPrivKey, viewPrivKey, ephemeralPubKey);
  }

  /** Fail with an actionable error unless the destination trusts the asset. */
  private async assertDestinationTrusts(
    destination: string,
    asset: Asset,
  ): Promise<void> {
    if (asset.isNative()) return;
    const dest = await this.horizon.getAccount(destination);
    if (!dest) {
      throw new Error(
        `Destination ${destination} not found on Horizon — fund it and add a ${asset.getCode()} trustline before claiming.`,
      );
    }
    const code = asset.getCode();
    const issuer = asset.getIssuer();
    const trusts = dest.balances.some(
      (b) =>
        (b as { asset_code?: string; asset_issuer?: string }).asset_code ===
          code &&
        (b as { asset_code?: string; asset_issuer?: string }).asset_issuer ===
          issuer,
    );
    if (!trusts) {
      throw new Error(
        `Destination ${destination} does not trust ${assetToString(asset)}. ` +
          `Add the trustline on the destination account before claiming.`,
      );
    }
  }

  /** Submit an XDR directly to Horizon, or via a relayer fee-bump when set. */
  private async submit(xdr: string, opts: ClaimOpts): Promise<string> {
    const relay = opts.relay ?? this.relayer;
    if (relay) {
      const client = this.relayerClient ?? new RelayerClient(relay);
      const { txHash } = await client.relay(xdr, {
        fundingAccount: opts.fundingAccount,
      });
      return txHash;
    }
    const res = await this.horizon.submitTransaction(xdr);
    return res.hash;
  }
}
