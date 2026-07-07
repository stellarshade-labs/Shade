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
import { StealthClient } from '@stealth/sdk';
import { getContractAddress } from '../utils/config.js';
import { formatError, validateMetaAddress } from '../utils/network.js';
import chalk from 'chalk';
import { randomBytes } from '@noble/hashes/utils';

function isNativeAsset(asset?: string): boolean {
  return !asset || asset === 'native' || asset === 'XLM';
}

/**
 * Direct account send, delegated to the SDK's account adapter. Native XLM opens
 * the stealth account with the sent amount (min > 1 XLM enforced by the SDK).
 * A non-native `--asset` routes to the token path: the send fronts ~1.5 XLM of
 * reserves (0.5 of which returns when the recipient claims the claimable
 * balance) and the token itself lands as a claimable balance — passing `asset`
 * here is what prevents the silent XLM-instead-of-token fund loss.
 */
async function sendViaAccount(
  network: 'local' | 'testnet',
  metaAddress: string,
  amount: number,
  from: string,
  relay: string | undefined,
  asset: string | undefined,
  verbose: boolean,
): Promise<void> {
  const native = isNativeAsset(asset);
  if (native && amount <= 1) {
    console.error(chalk.red('Error: native account sends require an amount strictly greater than 1 XLM'));
    process.exit(1);
  }

  const client = new StealthClient({
    network,
    methods: ['account'],
    relayer: relay,
  });

  if (native) {
    console.log(chalk.cyan('Sending XLM directly to a one-time stealth account...'));
  } else {
    console.log(chalk.cyan(`Sending ${asset} directly via a one-time stealth account...`));
    console.log(chalk.yellow('  Note: you front ~1.5 XLM of reserves to open the stealth account;'));
    console.log(chalk.yellow('  0.5 XLM returns to you when the recipient claims the balance.'));
  }

  const receipt = await client.send(metaAddress, amount, from, {
    method: 'account',
    asset,
  });

  const label = native ? 'XLM' : asset;
  console.log(chalk.green(`\u2713 Sent ${amount} ${label} to stealth account`));
  console.log(chalk.gray(`  Tx hash:  ${receipt.txHash}`));
  console.log(chalk.gray(`  Stealth:  ${receipt.stealthAddress}`));
  console.log(chalk.gray('  The transaction memo carries the ephemeral key (MemoHash of R).'));
  if (verbose) {
    console.log(chalk.gray('  Recipients discover this via memo scanning; no view tag is used.'));
  }
}

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
  .description('Send tokens to a stealth address (pool deposit or direct account send)')
  .argument('<meta-address>', 'Recipient meta-address (st:stellar:... or spend:view hex)')
  .argument('<amount>', 'Amount to send (in whole units, e.g. 100 for 100 XLM)')
  .option('--method <method>', 'Delivery method: pool | account | auto (you must choose)')
  .option('--network <network>', 'Network to use', 'local')
  .option('--from <secret>', 'Sender secret key')
  .option('--asset <asset>', 'Asset to send (default: native XLM, or CODE:ISSUER)')
  .option('--relay <url>', 'Relayer URL (account method fee-bump)')
  .option('--verbose', 'Show detailed output')
  .action(async (metaAddress: string, amount: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';

      const method = options.method as string | undefined;
      if (!method) {
        console.error(chalk.red('Error: --method is required. Choose one: pool | account | auto'));
        console.error(chalk.gray('  pool    — private deposit into the stealth pool contract'));
        console.error(chalk.gray('  account — direct XLM send that creates a one-time stealth account'));
        console.error(chalk.gray('  auto    — pick account for native XLM > 1, else pool'));
        process.exit(1);
      }
      if (!['pool', 'account', 'auto'].includes(method)) {
        console.error(chalk.red('Error: --method must be one of: pool | account | auto'));
        process.exit(1);
      }

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

      const isNative =
        !options.asset || options.asset === 'native' || options.asset === 'XLM';
      const resolvedMethod =
        method === 'auto'
          ? isNative && parsedAmount > 1
            ? 'account'
            : 'pool'
          : method;

      if (resolvedMethod === 'account') {
        await sendViaAccount(
          network,
          metaAddress,
          parsedAmount,
          options.from,
          options.relay,
          options.asset,
          options.verbose,
        );
        return;
      }

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
