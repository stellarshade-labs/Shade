import { Request, Response } from 'express';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Horizon
} from '@stellar/stellar-sdk';
import { validateStellarAddress, validateAmount } from '../utils/validation.js';
import { logger } from '../utils/logger.js';

let relayerKeypair: Keypair | null = null;

export function initSponsorRoute(keypair: Keypair) {
  relayerKeypair = keypair;
}

export async function handleSponsor(req: Request, res: Response) {
  const requestId = (req as any).requestId;

  try {
    if (!relayerKeypair) {
      logger.error('Relayer not initialized', {}, requestId);
      return res.status(500).json({ error: 'Relayer not initialized' });
    }

    const { address, amount } = req.body;

    if (!validateStellarAddress(address)) {
      logger.warn('Invalid address format', { address }, requestId);
      return res.status(400).json({
        error: 'Invalid Stellar address format',
        expected: 'G... format (56 characters)'
      });
    }

    if (amount !== undefined) {
      const validAmount = validateAmount(amount);
      if (!validAmount) {
        logger.warn('Invalid amount', { amount }, requestId);
        return res.status(400).json({
          error: 'Invalid amount',
          minimum: 1,
          maximum: 1000000
        });
      }
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
      logger.info('Account already exists', { address }, requestId);
      return res.status(400).json({ error: 'Account already exists' });
    }

    logger.info('Creating sponsored account', { address }, requestId);

    const relayerAccount = await server.loadAccount(relayerKeypair.publicKey());

    // CAP-0033 sponsoring requires the sponsored account's signature,
    // which we don't have (stealth private key is only known to recipient).
    // Instead, the relayer directly creates and funds the stealth account
    // with the minimum base reserve so the sender can then pay into it.
    const startingBalance = amount ? String(amount) : '1';

    const transaction = new TransactionBuilder(relayerAccount, {
      fee: '100',
      networkPassphrase
    })
    .addOperation(Operation.createAccount({
      destination: address,
      startingBalance
    }))
    .setTimeout(30)
    .build();

    transaction.sign(relayerKeypair);

    const response = await server.submitTransaction(transaction);

    logger.info('Account sponsored successfully', {
      address,
      txHash: response.hash
    }, requestId);

    return res.json({
      txHash: response.hash,
      success: true,
      sponsored: address
    });

  } catch (error: any) {
    logger.error('Sponsor request failed', {
      error: error.message,
      stack: error.stack
    }, requestId);

    if (error.response?.data?.extras?.result_codes) {
      const codes = error.response.data.extras.result_codes;
      return res.status(400).json({
        error: 'Transaction failed',
        codes,
        message: codes.transaction || codes.operations?.join(', ')
      });
    }

    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
}