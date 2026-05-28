import { Request, Response } from 'express';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Horizon,
  Account,
  StrKey
} from '@stellar/stellar-sdk';

let relayerKeypair: Keypair | null = null;

export function initSponsorRoute(keypair: Keypair) {
  relayerKeypair = keypair;
}

export async function handleSponsor(req: Request, res: Response) {
  try {
    if (!relayerKeypair) {
      return res.status(500).json({ error: 'Relayer not initialized' });
    }

    const { address } = req.body;

    if (!address || !StrKey.isValidEd25519PublicKey(address)) {
      return res.status(400).json({ error: 'Invalid Stellar address' });
    }

    const network = process.env.NETWORK || 'local';
    const networkPassphrase = network === 'local'
      ? Networks.STANDALONE
      : Networks.TESTNET;

    const horizonUrl = network === 'local'
      ? 'http://localhost:8000'
      : 'https://horizon-testnet.stellar.org';

    const server = new Horizon.Server(horizonUrl);

    let accountExists = false;
    try {
      await server.loadAccount(address);
      accountExists = true;
    } catch (error: any) {
      if (error?.response?.status !== 404) {
        throw error;
      }
    }

    if (accountExists) {
      return res.status(400).json({ error: 'Account already exists' });
    }

    console.log(`[Sponsor] Creating sponsored account: ${address}`);

    const relayerAccount = await server.loadAccount(relayerKeypair.publicKey());

    const transaction = new TransactionBuilder(relayerAccount, {
      fee: '100',
      networkPassphrase
    })
    .addOperation(Operation.beginSponsoringFutureReserves({
      sponsoredId: address
    }))
    .addOperation(Operation.createAccount({
      destination: address,
      startingBalance: '0'
    }))
    .addOperation(Operation.endSponsoringFutureReserves({
      source: address
    }))
    .setTimeout(30)
    .build();

    transaction.sign(relayerKeypair);

    const response = await server.submitTransaction(transaction);

    console.log(`[Sponsor] Account created: ${response.hash}`);

    return res.json({
      txHash: response.hash,
      success: true,
      sponsored: address
    });

  } catch (error: any) {
    console.error('[Sponsor] Error:', error.message);

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