import { Request, Response } from 'express';
import { getContext } from '../context.js';
import { toStroops, fromStroops } from '../ledger.js';
import { validateStellarAddress } from '../utils/validation.js';

interface HorizonTxRecord {
  successful: boolean;
  source_account: string;
  hash: string;
}

interface HorizonPaymentOp {
  type: string;
  from?: string;
  to?: string;
  asset_type?: string;
  amount?: string;
}

/**
 * POST /credit/claim { fundingAccount, txHash }
 *
 * Verify against Horizon that the tx succeeded, contains a native payment to
 * the relayer's account, is sourced by `fundingAccount`, and has not already
 * been consumed; then credit the paid amount to the app's ledger balance.
 */
export async function handleCreditClaim(req: Request, res: Response) {
  const ctx = getContext();
  const { fundingAccount, txHash } = req.body ?? {};

  if (!validateStellarAddress(fundingAccount)) {
    return res.status(400).json({ error: 'Invalid funding account', code: 'invalid_address' });
  }
  if (!txHash || typeof txHash !== 'string') {
    return res.status(400).json({ error: 'Missing txHash', code: 'invalid_tx' });
  }

  if (ctx.ledger.hasConsumed(txHash)) {
    return res.status(409).json({ error: 'Transaction already claimed', code: 'tx_already_claimed' });
  }

  let tx: HorizonTxRecord;
  try {
    tx = (await ctx.server
      .transactions()
      .transaction(txHash)
      .call()) as unknown as HorizonTxRecord;
  } catch (err: any) {
    if (err?.response?.status === 404 || err?.status === 404) {
      return res.status(404).json({ error: 'Transaction not found', code: 'tx_not_found' });
    }
    return res.status(500).json({ error: err?.message ?? 'lookup failed', code: 'server_error' });
  }

  if (!tx.successful) {
    return res.status(400).json({ error: 'Transaction did not succeed', code: 'not_a_deposit' });
  }
  if (tx.source_account !== fundingAccount) {
    return res.status(400).json({ error: 'Source account mismatch', code: 'not_a_deposit' });
  }

  let ops: HorizonPaymentOp[];
  try {
    const page = (await ctx.server
      .operations()
      .forTransaction(txHash)
      .call()) as unknown as { records: HorizonPaymentOp[] };
    ops = page.records ?? [];
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'ops lookup failed', code: 'server_error' });
  }

  const relayerAddress = ctx.keypair.publicKey();
  // Credit only native payments TO the relayer whose op-source (defaulting to
  // the tx source) is the funding account — a bundled payment sourced by a
  // different account must not be attributed to this funding account. Sum every
  // qualifying payment op.
  let totalStroops = 0n;
  for (const op of ops) {
    if (op.type !== 'payment') continue;
    if (op.asset_type !== 'native') continue;
    if (op.to !== relayerAddress) continue;
    const opSource = op.from ?? tx.source_account;
    if (opSource !== fundingAccount) continue;
    if (!op.amount) continue;
    totalStroops += toStroops(op.amount);
  }
  if (totalStroops <= 0n) {
    return res.status(400).json({ error: 'No native payment to relayer', code: 'not_a_deposit' });
  }

  const acct = ctx.ledger.credit(fundingAccount, fromStroops(totalStroops), txHash);
  return res.json({
    fundingAccount,
    balance: acct.balance,
    updatedAt: acct.updatedAt,
  });
}

/**
 * GET /credit/:account -> { fundingAccount, balance, updatedAt }
 */
export function handleCreditBalance(req: Request, res: Response) {
  const ctx = getContext();
  const account = req.params.account ?? '';
  const record = ctx.ledger.getAccount(account);
  if (!record) {
    return res.status(404).json({ error: 'Unknown account', code: 'account_unknown' });
  }
  return res.json({
    fundingAccount: account,
    balance: record.balance,
    updatedAt: record.updatedAt,
  });
}
