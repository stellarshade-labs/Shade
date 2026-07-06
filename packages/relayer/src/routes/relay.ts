import { Request, Response } from 'express';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Horizon,
  Transaction
} from '@stellar/stellar-sdk';
import type { CreditLedger } from '../ledger.js';
import { validateStellarAddress } from '../utils/validation.js';

let relayerKeypair: Keypair | null = null;
let relayLedger: CreditLedger | null = null;
let relayRequireCredit = false;

export function initRelayRoute(
  keypair: Keypair,
  opts?: { ledger?: CreditLedger; requireCredit?: boolean },
) {
  relayerKeypair = keypair;
  relayLedger = opts?.ledger ?? null;
  relayRequireCredit = opts?.requireCredit ?? false;
}

export async function handleRelay(req: Request, res: Response) {
  try {
    if (!relayerKeypair) {
      return res.status(500).json({ error: 'Relayer not initialized' });
    }

    const { xdr, fundingAccount } = req.body;

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

    // Optional credit gating: require + reserve the fee-bump fee up front.
    if (relayRequireCredit && relayLedger) {
      const feeXlm = (Number(bumpFee) / 1e7).toFixed(7);
      if (!validateStellarAddress(fundingAccount)) {
        return res
          .status(402)
          .json({ error: 'Funding account required', code: 'insufficient_credit' });
      }
      if (!relayLedger.hasSufficient(fundingAccount, feeXlm)) {
        return res
          .status(402)
          .json({ error: 'Insufficient credit', code: 'insufficient_credit' });
      }
    }

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      relayerKeypair,
      bumpFee,
      innerTx,
      networkPassphrase
    );

    feeBumpTx.sign(relayerKeypair);

    console.log(`[Relay] Submitting fee-bumped transaction...`);

    const response = await server.submitTransaction(feeBumpTx);

    console.log(`[Relay] Transaction submitted: ${response.hash}`);

    if (relayRequireCredit && relayLedger && fundingAccount) {
      const feeXlm = (Number(bumpFee) / 1e7).toFixed(7);
      relayLedger.debit(fundingAccount, feeXlm, `relay:${response.hash}`);
    }

    return res.json({
      txHash: response.hash,
      success: true
    });

  } catch (error: any) {
    console.error('[Relay] Error:', error.message);

    if (error.response?.data?.extras?.result_codes) {
      return res.status(400).json({
        error: 'Transaction failed',
        codes: error.response.data.extras.result_codes
      });
    }

    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
}