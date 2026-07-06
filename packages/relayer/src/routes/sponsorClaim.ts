import { Request, Response } from 'express';
import {
  TransactionBuilder,
  Operation,
  Account,
  Asset,
  Transaction,
} from '@stellar/stellar-sdk';
import { getContext } from '../context.js';
import { validateStellarAddress } from '../utils/validation.js';

const PREPARE_TTL_SECONDS = 60;

function parseAsset(asset: string): Asset {
  if (!asset || asset === 'native' || asset === 'XLM') return Asset.native();
  const [code, issuer] = asset.split(':');
  if (!code || !issuer) throw new Error(`Invalid asset "${asset}"`);
  return new Asset(code, issuer);
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
  const { stealthAddress, asset, balanceId } = req.body ?? {};

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

  let stellarAsset: Asset;
  try {
    stellarAsset = parseAsset(asset);
  } catch {
    return res.status(400).json({ error: 'Invalid asset', code: 'invalid_asset' });
  }

  let accountExists = false;
  try {
    await ctx.server.loadAccount(stealthAddress);
    accountExists = true;
  } catch (err: any) {
    if (err?.response?.status !== 404 && err?.status !== 404) {
      return res.status(500).json({ error: err?.message ?? 'load failed', code: 'server_error' });
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
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err?.message ?? 'prepare failed', code: 'server_error' });
  }
}

/**
 * Compare two operation lists field-by-field for sponsor-claim verification.
 * Checks op `type`, per-op `source`, and every security-relevant parameter
 * (createAccount destination + startingBalance, changeTrust asset,
 * beginSponsoring sponsoredId, claimClaimableBalance balanceId). Returns true
 * only when the submitted ops exactly match the ops the relayer would build.
 */
function opsMatch(
  submitted: readonly any[],
  expected: readonly any[],
  relayer: string,
): boolean {
  if (submitted.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = submitted[i];
    const b = expected[i];
    if (a.type !== b.type) return false;
    // Per-op source: undefined on the built op means "inherit tx source"
    // (the relayer). Normalize both sides before comparing.
    const aSource = a.source ?? relayer;
    const bSource = b.source ?? relayer;
    if (aSource !== bSource) return false;

    switch (b.type) {
      case 'beginSponsoringFutureReserves':
        if (a.sponsoredId !== b.sponsoredId) return false;
        break;
      case 'createAccount':
        if (a.destination !== b.destination) return false;
        if (a.startingBalance !== b.startingBalance) return false;
        break;
      case 'changeTrust': {
        const aa = a.line ?? a.asset;
        const bb = b.line ?? b.asset;
        const aStr = aa && typeof aa.toString === 'function' ? aa.toString() : String(aa);
        const bStr = bb && typeof bb.toString === 'function' ? bb.toString() : String(bb);
        if (aStr !== bStr) return false;
        break;
      }
      case 'claimClaimableBalance':
        if (a.balanceId !== b.balanceId) return false;
        break;
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
 * signature, submit, and (when credit-gated) debit the fee.
 *
 * Reserve subsidy: the base reserve fronted for the sponsored CreateAccount
 * (startingBalance '0') + one trustline entry is relayer-subsidized and is NOT
 * charged to `fundingAccount` — only the tx fee is debited under credit gating.
 */
export async function handleSponsorClaimSubmit(req: Request, res: Response) {
  const ctx = getContext();
  const { xdr, fundingAccount, stealthAddress, asset, balanceId } =
    req.body ?? {};

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
  } catch (err: any) {
    if (err?.response?.status !== 404 && err?.status !== 404) {
      return res
        .status(500)
        .json({ error: err?.message ?? 'load failed', code: 'server_error' });
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

  if (ctx.requireCredit) {
    if (!validateStellarAddress(fundingAccount)) {
      return res.status(402).json({ error: 'Funding account required', code: 'insufficient_credit' });
    }
    const feeXlm = (Number(tx.fee) / 1e7).toFixed(7);
    if (!ctx.ledger.hasSufficient(fundingAccount, feeXlm)) {
      return res.status(402).json({ error: 'Insufficient credit', code: 'insufficient_credit' });
    }
  }

  try {
    tx.sign(ctx.keypair);
    const response = (await ctx.server.submitTransaction(tx)) as unknown as {
      hash: string;
    };

    if (ctx.requireCredit) {
      const feeXlm = (Number(tx.fee) / 1e7).toFixed(7);
      ctx.ledger.debit(fundingAccount, feeXlm, `sponsor-claim:${response.hash}`);
    }

    return res.json({ txHash: response.hash });
  } catch (err: any) {
    if (err?.response?.data?.extras?.result_codes) {
      return res.status(400).json({
        error: 'Transaction failed',
        code: 'tx_failed',
        codes: err.response.data.extras.result_codes,
      });
    }
    return res.status(500).json({ error: err?.message ?? 'submit failed', code: 'server_error' });
  }
}
