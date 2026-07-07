import { Request, Response } from 'express';
import {
  TransactionBuilder,
  Operation,
  Account,
} from '@stellar/stellar-sdk';
import { getContext } from '../context.js';
import type { Reservation } from '../ledger.js';
import { validateStellarAddress } from '../utils/validation.js';

interface HorizonAccountResponse {
  accountId(): string;
  sequenceNumber(): string;
}

/**
 * POST /sponsor { address, startingBalance?, fundingAccount? }
 *
 * Create a stealth account with a plain funded CreateAccount from the relayer's
 * balance.
 *
 * NOTE (vs the v1 route): there is deliberately NO
 * BeginSponsoringFutureReserves / EndSponsoringFutureReserves sandwich here.
 * EndSponsoringFutureReserves must be signed by the sponsored account, whose key
 * nobody holds at creation time — the v1 sandwich could never actually submit.
 * The sponsorship sandwich lives only in /sponsor-claim, where the client holds
 * the stealth key and co-signs.
 */
export async function handleSponsor(req: Request, res: Response) {
  const ctx = getContext();
  const { address, startingBalance, fundingAccount } = req.body ?? {};

  if (!validateStellarAddress(address)) {
    return res
      .status(400)
      .json({ error: 'Invalid Stellar address', code: 'invalid_address' });
  }

  const balance = startingBalance ?? '1';
  const balanceNum = Number(balance);
  if (!Number.isFinite(balanceNum) || balanceNum < 0) {
    return res
      .status(400)
      .json({ error: 'Invalid starting balance', code: 'invalid_balance' });
  }
  if (balanceNum > ctx.sponsorMaxXlm) {
    return res.status(400).json({
      error: `Starting balance exceeds SPONSOR_MAX_XLM (${ctx.sponsorMaxXlm})`,
      code: 'balance_exceeds_max',
    });
  }

  // Reject if the account already exists.
  try {
    await ctx.server.loadAccount(address);
    return res
      .status(409)
      .json({ error: 'Account already exists', code: 'account_exists' });
  } catch (err: any) {
    if (err?.response?.status !== 404 && err?.status !== 404) {
      return res
        .status(500)
        .json({ error: err?.message ?? 'load failed', code: 'server_error' });
    }
  }

  try {
    const relayerAccount = (await ctx.server.loadAccount(
      ctx.keypair.publicKey(),
    )) as unknown as HorizonAccountResponse;
    const source = new Account(
      relayerAccount.accountId(),
      relayerAccount.sequenceNumber(),
    );

    const tx = new TransactionBuilder(source, {
      fee: '100',
      networkPassphrase: ctx.networkPassphrase,
    })
      .addOperation(
        Operation.createAccount({
          destination: address,
          startingBalance: Number(balance).toFixed(7),
        }),
      )
      .setTimeout(30)
      .build();

    // Credit gating: reserve the starting balance PLUS the tx fee BEFORE submit
    // (the relayer pays both out of its own funds). Refund on submit failure.
    let reservation: Reservation | null = null;
    if (ctx.requireCredit) {
      if (!validateStellarAddress(fundingAccount)) {
        return res
          .status(402)
          .json({ error: 'Funding account required for credit', code: 'insufficient_credit' });
      }
      const feeXlm = Number(tx.fee) / 1e7;
      const totalXlm = (balanceNum + feeXlm).toFixed(7);
      try {
        reservation = await ctx.ledger.reserve(
          fundingAccount,
          totalXlm,
          `sponsor:${tx.hash().toString('hex')}`,
        );
      } catch {
        return res
          .status(402)
          .json({ error: 'Insufficient credit', code: 'insufficient_credit' });
      }
    }

    tx.sign(ctx.keypair);
    let response: { hash: string };
    try {
      response = (await ctx.server.submitTransaction(tx)) as unknown as {
        hash: string;
      };
    } catch (submitErr) {
      if (reservation) await ctx.ledger.refund(reservation);
      throw submitErr;
    }

    return res.json({ txHash: response.hash, stealthAddress: address });
  } catch (err: any) {
    return res
      .status(500)
      .json({ error: err?.message ?? 'submit failed', code: 'server_error' });
  }
}
