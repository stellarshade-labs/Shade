import { Command } from 'commander';
import { recoverStealthPrivateKey, scanAnnouncements } from '@stealth/crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  Account,
  StrKey,
  Horizon
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { loadKeystore } from '../utils/keystore.js';
import { getContractAddress } from '../utils/config.js';
import chalk from 'chalk';
import axios from 'axios';

interface Announcement {
  ephemeralPubKey: Uint8Array;
  viewTag: number;
  stealthAddress: string;
  encryptedAmount?: string;
  ledger: number;
}

async function fetchAnnouncementsForAddress(
  stealthAddress: string,
  contractId: string,
  network: 'local' | 'testnet',
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array
): Promise<Uint8Array | null> {
  const rpcUrl = network === 'local'
    ? 'http://localhost:8000/soroban/rpc'
    : 'https://soroban-testnet.stellar.org';

  const server = new StellarSdk.rpc.Server(rpcUrl);
  const contract = new StellarSdk.Contract(contractId);

  try {
    const getLogs = contract.call('get_announcements');
    const sim = await server.simulateTransaction(
      new TransactionBuilder(
        new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
        {
          fee: '100',
          networkPassphrase: network === 'local'
            ? Networks.STANDALONE
            : Networks.TESTNET
        }
      )
      .addOperation(getLogs)
      .setTimeout(30)
      .build()
    );

    if (StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
      const result = sim.result?.retval;
      if (result) {
        const decoded = StellarSdk.scValToNative(result) as any[];
        const announcements: Announcement[] = decoded.map(ann => {
          const stealthPk = new Uint8Array(ann.stealth_pk);
          const announcementStealthAddress = StrKey.encodeEd25519PublicKey(Buffer.from(stealthPk));
          return {
            ephemeralPubKey: new Uint8Array(ann.ephemeral_pk),
            viewTag: ann.view_tag,
            stealthAddress: announcementStealthAddress,
            encryptedAmount: ann.encrypted_amount,
            ledger: Number(ann.sequence || 0)
          };
        });

        const stealthAddresses = scanAnnouncements(
          viewPrivKey,
          spendPubKey,
          announcements.map(a => ({
            ephemeralPubKey: a.ephemeralPubKey,
            viewTag: a.viewTag,
            stealthAddress: a.stealthAddress
          }))
        );

        for (const stealth of stealthAddresses) {
          if (stealth.address === stealthAddress) {
            // Find the corresponding announcement to get the ephemeral key
            const announcement = announcements.find(a => a.stealthAddress === stealthAddress);
            return announcement?.ephemeralPubKey || null;
          }
        }
      }
    }
  } catch (error) {
    console.error(chalk.yellow('Warning: Could not fetch announcements'));
  }

  return null;
}

async function submitViaRelay(
  xdr: string,
  relayUrl: string
): Promise<string> {
  try {
    const response = await axios.post(relayUrl, {
      xdr
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    return response.data.txHash;
  } catch (error: any) {
    throw new Error(`Relay error: ${error.response?.data?.error || error.message}`);
  }
}

export const withdrawCommand = new Command('withdraw')
  .description('Withdraw funds from a stealth address')
  .argument('<stealth-address>', 'Stealth address to withdraw from')
  .argument('<destination>', 'Destination address')
  .option('--network <network>', 'Network to use', 'local')
  .option('--relay <url>', 'Relay URL for fee-bumped submission')
  .option('--merge', 'Use account merge instead of payment')
  .action(async (stealthAddress: string, destination: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';
      const keystore = await loadKeystore();

      if (!keystore.viewPrivateKey || !keystore.spendPrivateKey) {
        console.error(chalk.red('Error: Missing private keys in keystore'));
        process.exit(1);
      }

      if (!StrKey.isValidEd25519PublicKey(stealthAddress)) {
        console.error(chalk.red('Error: Invalid stealth address'));
        process.exit(1);
      }

      if (!StrKey.isValidEd25519PublicKey(destination)) {
        console.error(chalk.red('Error: Invalid destination address'));
        process.exit(1);
      }

      console.log(chalk.cyan('Finding announcement for stealth address...'));

      const viewPrivKey = Buffer.from(keystore.viewPrivateKey, 'hex');
      const spendPrivKey = Buffer.from(keystore.spendPrivateKey, 'hex');
      const spendPubKey = Buffer.from(keystore.spendPublicKey, 'hex');

      const contractAddress = getContractAddress(network);
      const ephemeralPubKey = await fetchAnnouncementsForAddress(
        stealthAddress,
        contractAddress,
        network,
        viewPrivKey,
        spendPubKey
      );

      if (!ephemeralPubKey) {
        console.error(chalk.red('Error: Could not find announcement for this stealth address'));
        process.exit(1);
      }

      console.log(chalk.cyan('Recovering stealth private key...'));

      const stealthPrivKey = recoverStealthPrivateKey(
        spendPrivKey,
        viewPrivKey,
        ephemeralPubKey
      );

      const stealthKeypair = Keypair.fromRawEd25519Seed(Buffer.from(stealthPrivKey));

      const horizonUrl = network === 'local'
        ? 'http://localhost:8000'
        : 'https://horizon-testnet.stellar.org';

      const server = new Horizon.Server(horizonUrl);
      const networkPassphrase = network === 'local'
        ? Networks.STANDALONE
        : Networks.TESTNET;

      console.log(chalk.cyan('Loading stealth account...'));

      const account = await server.loadAccount(stealthAddress);
      const xlmBalance = account.balances.find(b => b.asset_type === 'native');
      const balance = parseFloat(xlmBalance?.balance || '0');

      if (balance <= 0) {
        console.error(chalk.yellow('Warning: Stealth account has no balance'));
        process.exit(0);
      }

      console.log(chalk.gray(`Balance: ${balance} XLM`));

      let transaction: any;

      if (options.merge) {
        console.log(chalk.cyan('Building account merge transaction...'));

        transaction = new TransactionBuilder(account, {
          fee: '100',
          networkPassphrase
        })
        .addOperation(Operation.accountMerge({
          destination: destination
        }))
        .setTimeout(30)
        .build();
      } else {
        console.log(chalk.cyan('Building payment transaction...'));

        const amount = (balance - 0.00001).toFixed(7);

        transaction = new TransactionBuilder(account, {
          fee: '100',
          networkPassphrase
        })
        .addOperation(Operation.payment({
          destination: destination,
          asset: Asset.native(),
          amount: amount
        }))
        .setTimeout(30)
        .build();
      }

      transaction.sign(stealthKeypair);

      let txHash: string;

      if (options.relay) {
        console.log(chalk.cyan('Submitting via relay...'));
        txHash = await submitViaRelay(
          transaction.toEnvelope().toXDR('base64'),
          options.relay
        );
      } else {
        console.log(chalk.cyan('Submitting transaction...'));
        const response = await server.submitTransaction(transaction);
        txHash = response.hash;
      }

      const withdrawnAmount = options.merge ? balance : balance - 0.00001;
      console.log(chalk.green(`✓ Withdrawn ${withdrawnAmount.toFixed(7)} XLM to ${destination}`));
      console.log(chalk.gray(`Transaction: ${txHash}`));

    } catch (error: any) {
      console.error(chalk.red('Error withdrawing:'), error.message);
      process.exit(1);
    }
  });