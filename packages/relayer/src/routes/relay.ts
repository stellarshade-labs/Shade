import { Request, Response } from 'express';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Horizon,
  Transaction
} from '@stellar/stellar-sdk';
import type { CreditLedger, Reservation } from '../ledger.js';
import { validateStellarAddress } from '../utils/validation.js';
import { ChallengeStore } from '../utils/auth.js';

let relayerKeypair: Keypair | null = null;
let relayLedger: CreditLedger | null = null;
let relayRequireCredit = false;
let relayChallenges: ChallengeStore | null = null;

export function initRelayRoute(
  keypair: Keypair,
  opts?: {
    ledger?: CreditLedger;
    requireCredit?: boolean;
    challenges?: ChallengeStore;
  },
) {
  relayerKeypair = keypair;
  relayLedger = opts?.ledger ?? null;
  relayRequireCredit = opts?.requireCredit ?? false;
  relayChallenges = opts?.challenges ?? null;
}

export async function handleRelay(req: Request, res: Response) {
  try {
    if (!relayerKeypair) {
      return res.status(500).json({ error: 'Relayer not initialized' });
    }

    const { xdr, fundingAccount, nonce, signature } = req.body;

    if (!xdr || typeof xdr !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid XDR' });
    }

    const network = process.env.NETWORK || 'local';
    const networkPassphrase = network === 'local'
      ? Networks.STANDALONE
      : Networks.TESTNET;

    const horizonUrl = network === 'local'
      ? 'http://localhost:8000'
      : 'https://horizon-testnet.stellar.org';

    const server = new Horizon.Server(horizonUrl, {
      allowHttp: network === 'local',
    });

    let innerTx: Transaction;
    try {
      innerTx = new Transaction(xdr, networkPassphrase);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid transaction XDR' });
    }

    console.log(`[Relay] Wrapping transaction in fee bump...`);

    await server.loadAccount(relayerKeypair.publicKey());
    const baseFee = await server.fetchBaseFee();
    const bumpFee = (baseFee * 2).toString();

    // Build the fee-bump FIRST so we can debit the actual total outer fee
    // (per-op fee * (innerOps + 1)) rather than the per-op input, which
    // otherwise undercharges 2-6x on multi-op inner transactions.
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      relayerKeypair,
      bumpFee,
      innerTx,
      networkPassphrase
    );

    // Optional credit gating: reserve the actual built total fee BEFORE submit.
    const feeXlm = (Number(feeBumpTx.fee) / 1e7).toFixed(7);
    let reservation: Reservation | null = null;
    if (relayRequireCredit && relayLedger) {
      // Fail-closed: a credit-gated relayer MUST have a challenge store to prove
      // control of the fundingAccount. Without one we cannot authenticate the
      // caller, so we refuse rather than debit an attacker-named account with no
      // signature check.
      if (!relayChallenges) {
        return res.status(500).json({
          error: 'Relayer misconfigured: credit gating requires a challenge store',
          code: 'server_error',
        });
      }
      if (!validateStellarAddress(fundingAccount)) {
        return res
          .status(402)
          .json({ error: 'Funding account required', code: 'insufficient_credit' });
      }
      // Proof-of-control: the fundingAccount must sign a fresh challenge nonce
      // binding this endpoint + account + the authorized fee. Without it anyone
      // could name a victim's account and spend its credit.
      const authErr = relayChallenges.verify(
        'relay',
        { fundingAccount, nonce, signature },
        feeXlm,
      );
      if (authErr) {
        return res.status(401).json({ error: 'Unauthorized', code: authErr });
      }
      try {
        reservation = await relayLedger.reserve(
          fundingAccount,
          feeXlm,
          `relay:${feeBumpTx.hash().toString('hex')}`,
        );
      } catch {
        return res
          .status(402)
          .json({ error: 'Insufficient credit', code: 'insufficient_credit' });
      }
    }

    feeBumpTx.sign(relayerKeypair);

    console.log(`[Relay] Submitting fee-bumped transaction...`);

    let response;
    try {
      response = await server.submitTransaction(feeBumpTx);
    } catch (submitErr) {
      if (reservation && relayLedger) await relayLedger.refund(reservation);
      throw submitErr;
    }
    if (reservation && relayLedger) await relayLedger.settle(reservation);

    console.log(`[Relay] Transaction submitted: ${response.hash}`);

    return res.json({
      txHash: response.hash,
      success: true
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Relay] Error:', message);

    const codes = (
      error as { response?: { data?: { extras?: { result_codes?: unknown } } } }
    )?.response?.data?.extras?.result_codes;
    if (codes) {
      return res.status(400).json({
        error: 'Transaction failed',
        codes,
      });
    }

    return res.status(500).json({
      error: message || 'Internal server error',
    });
  }
}