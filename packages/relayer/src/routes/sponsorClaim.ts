import { Request, Response } from 'express';
import {
  TransactionBuilder,
  Operation,
  Account,
  Asset,
  Transaction,
  type OperationRecord,
} from '@stellar/stellar-sdk';
import { getContext } from '../context.js';
import type { Reservation } from '../ledger.js';
import { toStroops, fromStroops } from '../ledger.js';
import { validateStellarAddress } from '../utils/validation.js';

const PREPARE_TTL_SECONDS = 60;

/**
 * Relayer-fronted sponsored reserve per claim: one base account reserve (0.5)
 * plus one trustline entry (0.5) held under the sponsorship sandwich. Charged to
 * the fundingAccount and tracked in `sponsoredHeld` (previously a silent drain).
 */
const SPONSORED_RESERVE_ESTIMATE = '1.0000000';

function parseAsset(asset: string): Asset {
  if (!asset || asset === 'native' || asset === 'XLM') return Asset.native();
  const [code, issuer] = asset.split(':');
  if (!code || !issuer) throw new Error(`Invalid asset "${asset}"`);
  return new Asset(code, issuer);
}

/** True when an unknown error carries an HTTP 404 (Horizon "not found"). */
function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; status?: number };
  return e?.response?.status === 404 || e?.status === 404;
}

/** Extract Horizon `result_codes` from an unknown error, if present. */
function resultCodes(err: unknown): unknown {
  return (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data?.extras?.result_codes;
}

/** Best-effort message from an unknown error. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a positive, finite 7-dp amount string. */
function isValidAmount(amount: unknown): amount is string {
  if (typeof amount !== 'string') return false;
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) return false;
  return Number(amount) > 0;
}

/**
 * Assert (via Horizon) that `destination` exists and already trusts `asset`
 * (native always passes). Returns null on success or an actionable error string
 * the caller surfaces to the client — the payout Payment would otherwise fail
 * on-chain after the fee is burned.
 */
async function destinationTrustError(
  server: { loadAccount(id: string): Promise<unknown> },
  destination: string,
  asset: Asset,
): Promise<string | null> {
  if (asset.isNative()) return null;
  let dest: unknown;
  try {
    dest = await server.loadAccount(destination);
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return `Destination ${destination} not found — fund it and add a ${asset.getCode()} trustline before claiming.`;
    }
    throw err;
  }
  const balances: Array<{ asset_code?: string; asset_issuer?: string }> =
    (dest as { balances?: Array<{ asset_code?: string; asset_issuer?: string }> })
      ?.balances ?? [];
  const trusts = balances.some(
    (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  if (!trusts) {
    return `Destination ${destination} does not trust ${asset.getCode()}:${asset.getIssuer()}. Add the trustline before claiming.`;
  }
  return null;
}

/**
 * Build the ordered op list for a sponsor-claim, given whether the stealth
 * account already exists. Shared by prepare (to build) and submit (to verify
 * the client did not tamper with the operations).
 */
function buildSponsorClaimOps(args: {
  relayer: string;
  stealthAddress: string;
  asset: Asset;
  balanceId: string;
  accountExists: boolean;
  destination: string;
  amount: string;
}) {
  const ops = [];
  ops.push(
    Operation.beginSponsoringFutureReserves({
      sponsoredId: args.stealthAddress,
    }),
  );
  if (!args.accountExists) {
    ops.push(
      Operation.createAccount({
        destination: args.stealthAddress,
        startingBalance: '0',
      }),
    );
  }
  ops.push(
    Operation.changeTrust({ asset: args.asset, source: args.stealthAddress }),
  );
  ops.push(
    Operation.endSponsoringFutureReserves({ source: args.stealthAddress }),
  );
  ops.push(
    Operation.claimClaimableBalance({
      balanceId: args.balanceId,
      source: args.stealthAddress,
    }),
  );
  // Pay the claimed token out to the destination in the same tx: the stealth
  // account (created with startingBalance 0 under sponsorship) can never pay a
  // fee to move the tokens itself, so the payout must ride here. The stealth
  // account signs this op but the relayer sources+pays the tx fee.
  ops.push(
    Operation.payment({
      destination: args.destination,
      asset: args.asset,
      amount: args.amount,
      source: args.stealthAddress,
    }),
  );
  return ops;
}

/**
 * POST /sponsor-claim/prepare { stealthAddress, asset, balanceId? }
 *   -> { xdr, expiresAt }
 *
 * Build a relayer-sourced, UNSIGNED transaction (timebounds now+60s):
 * BeginSponsoringFutureReserves -> [CreateAccount if missing] ->
 * ChangeTrust(source: stealth) -> EndSponsoringFutureReserves(source: stealth)
 * -> ClaimClaimableBalance(source: stealth). The client attaches the stealth
 * signature and returns it via /sponsor-claim/submit.
 */
export async function handleSponsorClaimPrepare(req: Request, res: Response) {
  const ctx = getContext();
  const { stealthAddress, asset, balanceId, destination, amount } =
    req.body ?? {};

  if (!validateStellarAddress(stealthAddress)) {
    return res
      .status(400)
      .json({ error: 'Invalid stealth address', code: 'invalid_address' });
  }
  if (!balanceId || typeof balanceId !== 'string') {
    return res
      .status(400)
      .json({ error: 'Missing balanceId', code: 'invalid_balance' });
  }
  if (!validateStellarAddress(destination)) {
    return res
      .status(400)
      .json({ error: 'Invalid destination', code: 'invalid_destination' });
  }
  if (!isValidAmount(amount)) {
    return res
      .status(400)
      .json({ error: 'Invalid amount', code: 'invalid_amount' });
  }

  let stellarAsset: Asset;
  try {
    stellarAsset = parseAsset(asset);
  } catch {
    return res.status(400).json({ error: 'Invalid asset', code: 'invalid_asset' });
  }

  // The destination must already trust the asset (the payout Payment would
  // otherwise fail on-chain after the relayer burns the fee).
  try {
    const trustErr = await destinationTrustError(
      ctx.server,
      destination,
      stellarAsset,
    );
    if (trustErr) {
      return res.status(400).json({ error: trustErr, code: 'destination_no_trust' });
    }
  } catch (err: unknown) {
    return res.status(500).json({ error: errMessage(err) || 'trust check failed', code: 'server_error' });
  }

  let accountExists = false;
  try {
    await ctx.server.loadAccount(stealthAddress);
    accountExists = true;
  } catch (err: unknown) {
    if (!isNotFound(err)) {
      return res.status(500).json({ error: errMessage(err) || 'load failed', code: 'server_error' });
    }
  }

  try {
    const relayerAccount = (await ctx.server.loadAccount(
      ctx.keypair.publicKey(),
    )) as unknown as { accountId(): string; sequenceNumber(): string };
    const source = new Account(
      relayerAccount.accountId(),
      relayerAccount.sequenceNumber(),
    );

    const ops = buildSponsorClaimOps({
      relayer: ctx.keypair.publicKey(),
      stealthAddress,
      asset: stellarAsset,
      balanceId,
      accountExists,
      destination,
      amount,
    });

    const builder = new TransactionBuilder(source, {
      fee: '200',
      networkPassphrase: ctx.networkPassphrase,
    });
    for (const op of ops) builder.addOperation(op);
    const tx = builder.setTimeout(PREPARE_TTL_SECONDS).build();

    return res.json({
      xdr: tx.toEnvelope().toXDR('base64'),
      expiresAt: new Date(Date.now() + PREPARE_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (err: unknown) {
    return res
      .status(500)
      .json({ error: errMessage(err) || 'prepare failed', code: 'server_error' });
  }
}

/** Stringify an Asset-like value (line/asset) for comparison. */
function assetStr(value: unknown): string {
  return value && typeof (value as { toString?: unknown }).toString === 'function'
    ? (value as { toString(): string }).toString()
    : String(value);
}

/**
 * Compare two operation lists field-by-field for sponsor-claim verification.
 * Checks op `type`, per-op `source`, and every security-relevant parameter
 * (createAccount destination + startingBalance, changeTrust asset,
 * beginSponsoring sponsoredId, claimClaimableBalance balanceId). Returns true
 * only when the submitted ops exactly match the ops the relayer would build.
 *
 * Operations are typed as `readonly OperationRecord[]`; each branch narrows to
 * the specific `Operation.<Type>` shape (the SDK union is discriminated on
 * `type`). `OperationRecord` is the element type of `Transaction.operations`.
 */
function opsMatch(
  submitted: readonly OperationRecord[],
  expected: readonly OperationRecord[],
  relayer: string,
): boolean {
  if (submitted.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = submitted[i]!;
    const b = expected[i]!;
    if (a.type !== b.type) return false;
    // Per-op source: undefined on the built op means "inherit tx source"
    // (the relayer). Normalize both sides before comparing.
    const aSource = a.source ?? relayer;
    const bSource = b.source ?? relayer;
    if (aSource !== bSource) return false;

    switch (b.type) {
      case 'beginSponsoringFutureReserves': {
        const av = a as Operation.BeginSponsoringFutureReserves;
        const bv = b as Operation.BeginSponsoringFutureReserves;
        if (av.sponsoredId !== bv.sponsoredId) return false;
        break;
      }
      case 'createAccount': {
        const av = a as Operation.CreateAccount;
        const bv = b as Operation.CreateAccount;
        if (av.destination !== bv.destination) return false;
        if (av.startingBalance !== bv.startingBalance) return false;
        break;
      }
      case 'changeTrust': {
        const av = a as Operation.ChangeTrust;
        const bv = b as Operation.ChangeTrust;
        if (assetStr(av.line) !== assetStr(bv.line)) return false;
        break;
      }
      case 'claimClaimableBalance': {
        const av = a as Operation.ClaimClaimableBalance;
        const bv = b as Operation.ClaimClaimableBalance;
        if (av.balanceId !== bv.balanceId) return false;
        break;
      }
      case 'payment': {
        const av = a as Operation.Payment;
        const bv = b as Operation.Payment;
        if (av.destination !== bv.destination) return false;
        if (av.amount !== bv.amount) return false;
        if (assetStr(av.asset) !== assetStr(bv.asset)) return false;
        break;
      }
      case 'endSponsoringFutureReserves':
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * POST /sponsor-claim/submit { xdr, stealthAddress, asset, balanceId, fundingAccount? }
 *
 * Verify the client-signed tx matches exactly what the relayer would have
 * prepared for the trusted inputs (stealthAddress, asset, balanceId) — rebuild
 * the expected op list with `buildSponsorClaimOps` and compare field-by-field
 * (type + source + destination + asset + balanceId + sponsoredId). A client
 * cannot mutate any operation parameter and still pass. Then add the relayer
 * signature, submit, and (when credit-gated) authenticate + debit the caller.
 *
 * Reserve accounting: under a credit-gated relayer the base reserve fronted for
 * the sponsored CreateAccount (startingBalance '0') + one trustline entry is
 * charged to `fundingAccount` (recorded in `sponsoredHeld` under a per-funder
 * cap) ALONGSIDE the tx fee — it is no longer a silent, uncharged drain.
 */
export async function handleSponsorClaimSubmit(req: Request, res: Response) {
  const ctx = getContext();
  const {
    xdr,
    fundingAccount,
    nonce,
    signature,
    stealthAddress,
    asset,
    balanceId,
    destination,
    amount,
  } = req.body ?? {};

  if (!xdr || typeof xdr !== 'string') {
    return res.status(400).json({ error: 'Missing xdr', code: 'invalid_xdr' });
  }
  if (!validateStellarAddress(stealthAddress)) {
    return res
      .status(400)
      .json({ error: 'Missing or invalid stealthAddress', code: 'invalid_address' });
  }
  if (!balanceId || typeof balanceId !== 'string') {
    return res
      .status(400)
      .json({ error: 'Missing balanceId', code: 'invalid_balance' });
  }
  if (!validateStellarAddress(destination)) {
    return res
      .status(400)
      .json({ error: 'Missing or invalid destination', code: 'invalid_destination' });
  }
  if (!isValidAmount(amount)) {
    return res
      .status(400)
      .json({ error: 'Missing or invalid amount', code: 'invalid_amount' });
  }

  let stellarAsset: Asset;
  try {
    stellarAsset = parseAsset(asset);
  } catch {
    return res.status(400).json({ error: 'Invalid asset', code: 'invalid_asset' });
  }

  let tx: Transaction;
  try {
    tx = new Transaction(xdr, ctx.networkPassphrase);
  } catch {
    return res.status(400).json({ error: 'Invalid transaction XDR', code: 'invalid_xdr' });
  }

  // The tx must be relayer-sourced.
  if (tx.source !== ctx.keypair.publicKey()) {
    return res.status(400).json({ error: 'Unexpected source account', code: 'tampered' });
  }

  // Re-derive whether the stealth account exists so we rebuild the exact op list.
  let accountExists = false;
  try {
    await ctx.server.loadAccount(stealthAddress);
    accountExists = true;
  } catch (err: unknown) {
    if (!isNotFound(err)) {
      return res
        .status(500)
        .json({ error: errMessage(err) || 'load failed', code: 'server_error' });
    }
  }

  // Build the expected ops into a throwaway tx and read them back so both sides
  // are in the same parsed representation (Operation.* builders return raw XDR
  // objects without the .type/.source accessors used for comparison).
  let expectedOps;
  try {
    const built = buildSponsorClaimOps({
      relayer: ctx.keypair.publicKey(),
      stealthAddress,
      asset: stellarAsset,
      balanceId,
      accountExists,
      destination,
      amount,
    });
    const expectedBuilder = new TransactionBuilder(
      new Account(ctx.keypair.publicKey(), '0'),
      { fee: '200', networkPassphrase: ctx.networkPassphrase },
    );
    for (const op of built) expectedBuilder.addOperation(op);
    expectedOps = expectedBuilder.setTimeout(PREPARE_TTL_SECONDS).build().operations;
  } catch {
    return res.status(400).json({ error: 'Invalid claim parameters', code: 'tampered' });
  }

  if (!opsMatch(tx.operations, expectedOps, ctx.keypair.publicKey())) {
    return res.status(400).json({ error: 'Operations were modified', code: 'tampered' });
  }

  // Fee cap: prepare builds at 200 stroops/op, so the client cannot re-sign an
  // inflated fee and drain the relayer. Reject anything above the per-op cap.
  const expectedMaxFee = 200 * tx.operations.length;
  if (Number(tx.fee) > expectedMaxFee) {
    return res.status(400).json({ error: 'Fee exceeds per-op cap', code: 'tampered' });
  }

  // Enforce the advertised TTL server-side and forbid memos (prepare builds none).
  const nowSec = Math.floor(Date.now() / 1000);
  const clockSlack = 5;
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime || maxTime > nowSec + PREPARE_TTL_SECONDS + clockSlack) {
    return res.status(400).json({ error: 'Invalid timebounds', code: 'tampered' });
  }
  if (tx.memo && tx.memo.type !== 'none') {
    return res.status(400).json({ error: 'Unexpected memo', code: 'tampered' });
  }

  // Reserve BEFORE submit (credit gating). Under a credit-gated relayer the
  // fundingAccount is authenticated (proof-of-control), then charged the FULL
  // relayer-fronted cost: the sponsored reserve (base account reserve + one
  // trustline entry) PLUS the tx fee — the sponsored reserve was previously an
  // uncharged, unbounded drain. The reserve is recorded in `sponsoredHeld` under
  // a per-funder cap. The reservation is refunded if submit throws and settled
  // on success so a replay cannot refund a legitimate charge.
  const feeXlm = (Number(tx.fee) / 1e7).toFixed(7);
  const totalXlm = fromStroops(
    toStroops(feeXlm) + toStroops(SPONSORED_RESERVE_ESTIMATE),
  );
  let reservation: Reservation | null = null;
  let heldRecorded = false;
  // Key the sponsored-reserve hold by the SAME ref as the fee reservation (the
  // signed tx hash) so a genuine retry of the identical tx does not double-count
  // sponsoredHeld, and a released-then-retried tx re-applies the hold.
  const holdRef = `sponsor-claim:${tx.hash().toString('hex')}`;
  if (ctx.requireCredit) {
    if (!validateStellarAddress(fundingAccount)) {
      return res
        .status(401)
        .json({ error: 'Funding account required', code: 'missing_auth' });
    }
    // Proof-of-control: fundingAccount signs a fresh challenge nonce binding this
    // endpoint + account + the total (reserve + fee) it authorizes.
    const authErr = ctx.challenges.verify(
      'sponsor-claim',
      { fundingAccount, nonce, signature },
      totalXlm,
    );
    if (authErr) {
      return res.status(401).json({ error: 'Unauthorized', code: authErr });
    }
    // Enforce the per-funder sponsored-reserve ceiling BEFORE debiting the fee.
    try {
      await ctx.ledger.holdReserve(
        fundingAccount,
        SPONSORED_RESERVE_ESTIMATE,
        ctx.sponsorClaimMaxHeld.toFixed(7),
        holdRef,
      );
      heldRecorded = true;
    } catch {
      return res.status(402).json({
        error: 'Sponsored reserve cap exceeded',
        code: 'sponsored_held_exceeded',
      });
    }
    try {
      reservation = await ctx.ledger.reserve(fundingAccount, totalXlm, holdRef);
    } catch {
      if (heldRecorded) {
        await ctx.ledger.releaseReserve(
          fundingAccount,
          SPONSORED_RESERVE_ESTIMATE,
          holdRef,
        );
      }
      return res.status(402).json({ error: 'Insufficient credit', code: 'insufficient_credit' });
    }
  }

  try {
    tx.sign(ctx.keypair);
    const response = (await ctx.server.submitTransaction(tx)) as unknown as {
      hash: string;
    };
    if (reservation) await ctx.ledger.settle(reservation);

    return res.json({ txHash: response.hash });
  } catch (err: unknown) {
    if (reservation) await ctx.ledger.refund(reservation);
    if (heldRecorded) {
      await ctx.ledger.releaseReserve(
        fundingAccount,
        SPONSORED_RESERVE_ESTIMATE,
        holdRef,
      );
    }
    const codes = resultCodes(err);
    if (codes) {
      return res.status(400).json({
        error: 'Transaction failed',
        code: 'tx_failed',
        codes,
      });
    }
    return res.status(500).json({ error: errMessage(err) || 'submit failed', code: 'server_error' });
  }
}
