import { Request, Response } from 'express';
import { getContext } from '../context.js';
import { validateStellarAddress } from '../utils/validation.js';

/**
 * GET /credit/challenge?account=G...
 *
 * Issue a fresh, single-use proof-of-control nonce bound to `account`. The
 * client signs a canonical message binding the endpoint, account, this nonce,
 * and the authorized fee/amount with the account's ed25519 key, then attaches
 * `{ fundingAccount, nonce, signature }` to a fee-spending request. The nonce
 * expires after the store TTL and is consumed on first successful use.
 */
export async function handleCreditChallenge(req: Request, res: Response) {
  const ctx = getContext();
  const account = req.query?.account;
  if (typeof account !== 'string' || !validateStellarAddress(account)) {
    return res
      .status(400)
      .json({ error: 'Invalid or missing account', code: 'invalid_account' });
  }
  const nonce = await ctx.challenges.issue(account);
  return res.json({ account, nonce });
}
