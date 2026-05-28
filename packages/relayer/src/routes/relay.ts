import { Request, Response } from 'express';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Horizon,
  Transaction
} from '@stellar/stellar-sdk';

let relayerKeypair: Keypair | null = null;

export function initRelayRoute(keypair: Keypair) {
  relayerKeypair = keypair;
}

export async function handleRelay(req: Request, res: Response) {
  try {
    if (!relayerKeypair) {
      return res.status(500).json({ error: 'Relayer not initialized' });
    }

    const { xdr } = req.body;

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

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      relayerKeypair,
      (baseFee * 2).toString(),
      innerTx,
      networkPassphrase
    );

    feeBumpTx.sign(relayerKeypair);

    console.log(`[Relay] Submitting fee-bumped transaction...`);

    const response = await server.submitTransaction(feeBumpTx);

    console.log(`[Relay] Transaction submitted: ${response.hash}`);

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