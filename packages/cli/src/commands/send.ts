import { Command } from 'commander';
import { deriveStealthAddressWithSecret } from '@stealth/crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Asset,
  Contract,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getContractAddress } from '../utils/config.js';
import { formatError, validateMetaAddress } from '../utils/network.js';
import chalk from 'chalk';
import { randomBytes } from '@noble/hashes/utils';

function resolveTokenAddress(
  assetArg: string | undefined,
  networkPassphrase: string
): string {
  if (!assetArg || assetArg === 'native' || assetArg === 'XLM') {
    return Asset.native().contractId(networkPassphrase);
  }
  const parts = assetArg.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid asset format. Use CODE:ISSUER or "native"');
  }
  return new Asset(parts[0], parts[1]).contractId(networkPassphrase);
}

async function waitForTransaction(
  server: StellarSdk.rpc.Server,
  hash: string,
  verbose?: boolean
): Promise<void> {
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const result = await server.getTransaction(hash);
      if (result.status === 'SUCCESS') return;
      if (result.status === 'FAILED') {
        throw new Error('Transaction failed on-chain');
      }
    } catch (e: any) {
      if (e.message === 'Transaction failed on-chain') throw e;
      // XDR parsing errors can occur; transaction may still be ok
      if (verbose) console.log(chalk.gray(`  Polling: ${e.message}`));
    }
    attempts++;
  }
  if (verbose) console.log(chalk.yellow('  Transaction confirmation timed out'));
}

export const sendCommand = new Command('send')
  .description('Deposit tokens into the stealth pool')
  .argument('<meta-address>', 'Recipient meta-address (st:stellar:... or spend:view hex)')
  .argument('<amount>', 'Amount to send (in whole units, e.g. 100 for 100 XLM)')
  .option('--network <network>', 'Network to use', 'local')
  .option('--from <secret>', 'Sender secret key')
  .option('--asset <asset>', 'Asset to send (default: native XLM, or CODE:ISSUER)')
  .option('--verbose', 'Show detailed output')
  .action(async (metaAddress: string, amount: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';

      const metaKeys = validateMetaAddress(metaAddress);
      if (!metaKeys) {
        console.error(chalk.red('Error: Invalid meta-address format'));
        process.exit(1);
      }

      const { spendPubKey, viewPubKey } = metaKeys;

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.error(chalk.red('Error: Invalid amount'));
        process.exit(1);
      }

      if (!options.from) {
        console.error(chalk.red('Error: Please provide sender secret key with --from'));
        process.exit(1);
      }
      const senderKeypair = Keypair.fromSecret(options.from);

      const networkPassphrase = network === 'local'
        ? Networks.STANDALONE
        : Networks.TESTNET;

      // Resolve token
      const tokenAddress = resolveTokenAddress(options.asset, networkPassphrase);
      const assetLabel = (!options.asset || options.asset === 'native' || options.asset === 'XLM')
        ? 'XLM' : options.asset;

      console.log(chalk.cyan('Deriving stealth address...'));

      const ephemeralPrivKey = new Uint8Array(randomBytes(32));
      const stealth = deriveStealthAddressWithSecret(
        spendPubKey,
        viewPubKey,
        ephemeralPrivKey
      );

      if (options.verbose) {
        console.log(chalk.gray(`  Ephemeral pubkey: ${Buffer.from(stealth.ephemeralPubKey).toString('hex')}`));
        console.log(chalk.gray(`  Stealth address:  ${stealth.stealthAddress}`));
        console.log(chalk.gray(`  View tag:         ${stealth.viewTag}`));
        console.log(chalk.gray(`  Token SAC:        ${tokenAddress}`));
      }

      // Convert amount to stroops (7 decimal places for Stellar assets)
      const stroops = BigInt(Math.round(parsedAmount * 1e7));

      // Setup Soroban RPC
      const rpcUrl = network === 'local'
        ? 'http://localhost:8000/soroban/rpc'
        : 'https://soroban-testnet.stellar.org';

      const server = new StellarSdk.rpc.Server(rpcUrl, {
        allowHttp: network === 'local',
      });

      const contractAddress = getContractAddress(network);
      const contract = new Contract(contractAddress);

      // Build deposit transaction
      console.log(chalk.cyan(`Depositing ${parsedAmount} ${assetLabel} into stealth pool...`));

      const account = await server.getAccount(senderKeypair.publicKey());

      const depositTx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase,
      })
        .addOperation(
          contract.call(
            'deposit',
            new StellarSdk.Address(senderKeypair.publicKey()).toScVal(),
            new StellarSdk.Address(tokenAddress).toScVal(),
            nativeToScVal(stroops, { type: 'i128' }),
            nativeToScVal(Buffer.from(stealth.stealthPubKey)),
            nativeToScVal(Buffer.from(stealth.ephemeralPubKey)),
            nativeToScVal(stealth.viewTag, { type: 'u32' }),
          )
        )
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(depositTx);
      prepared.sign(senderKeypair);

      if (options.verbose) {
        console.log(chalk.gray(`  Transaction hash: ${prepared.hash().toString('hex')}`));
      }

      const sendResult = await server.sendTransaction(prepared);

      if (sendResult.status === 'ERROR') {
        throw new Error(`Transaction submission failed: ${sendResult.status}`);
      }

      if (sendResult.status === 'PENDING') {
        await waitForTransaction(server, sendResult.hash, options.verbose);
      }

      console.log(chalk.green(`\u2713 Deposited ${parsedAmount} ${assetLabel} to stealth pool`));
      console.log(chalk.gray(`  Tx hash:  ${sendResult.hash}`));
      console.log(chalk.gray(`  Stealth:  ${stealth.stealthAddress}`));

    } catch (error: any) {
      const formattedError = formatError(error);
      console.error(chalk.red('Error:'), formattedError);
      if (options.verbose && error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });
