import { Command } from 'commander';
import { deriveStealthAddressWithSecret, encryptAmount } from '@stealth/crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  Horizon,
  StrKey,
  Contract,
  nativeToScVal,
  scValToNative
} from '@stellar/stellar-sdk';
import { Server as SorobanServer } from '@stellar/stellar-sdk/lib/soroban';
import { getContractAddress } from '../utils/config.js';
import { withRetry, formatError, validateMetaAddress } from '../utils/network.js';
import chalk from 'chalk';
import { randomBytes } from 'crypto';

async function announceToContract(
  contractId: string,
  ephemeralPubKey: Uint8Array,
  viewTag: number,
  encryptedAmount: Uint8Array | undefined,
  senderKeypair: Keypair,
  network: 'local' | 'testnet'
): Promise<void> {
  const rpcUrl = network === 'local'
    ? 'http://localhost:8000/soroban/rpc'
    : 'https://soroban-testnet.stellar.org';

  const server = new SorobanServer(rpcUrl);
  const contract = new Contract(contractId);

  const networkPassphrase = network === 'local'
    ? Networks.STANDALONE
    : Networks.TESTNET;

  const account = await server.getAccount(senderKeypair.publicKey());

  const announceTx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase
  })
  .addOperation(contract.call(
    'announce',
    nativeToScVal(Buffer.from(ephemeralPubKey)),
    nativeToScVal(viewTag, { type: 'u32' }),
    encryptedAmount
      ? nativeToScVal(Buffer.from(encryptedAmount))
      : nativeToScVal(null)
  ))
  .setTimeout(30)
  .build();

  const prepared = await server.prepareTransaction(announceTx);
  prepared.sign(senderKeypair);

  const result = await server.sendTransaction(prepared);

  if (result.status === 'PENDING') {
    let status = result.status;
    while (status === 'PENDING' || status === 'NOT_FOUND') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const update = await server.getTransaction(result.hash);
      status = update.status;
    }
  }

  console.log(chalk.gray('  Announcement stored on-chain'));
}

export const sendCommand = new Command('send')
  .description('Send funds to a stealth address')
  .argument('<meta-address>', 'Recipient meta-address (spend_pubkey:view_pubkey)')
  .argument('<amount>', 'Amount in XLM')
  .option('--network <network>', 'Network to use', 'local')
  .option('--from <secret>', 'Sender secret key')
  .option('--relay <url>', 'Relay URL for sponsored creation')
  .option('--encrypt-amount', 'Encrypt the amount in the announcement')
  .option('--verbose', 'Show detailed RPC requests and transaction details')
  .action(async (metaAddress: string, amount: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';

      const metaKeys = validateMetaAddress(metaAddress);
      if (!metaKeys) {
        console.error(chalk.red('Error: Invalid meta-address format'));
        console.error(chalk.gray('  Expected format: <64-hex-chars>:<64-hex-chars>'));
        console.error(chalk.gray('  Example: a1b2c3...d4e5:f6g7h8...i9j0'));
        process.exit(1);
      }

      const { spendPubKey, viewPubKey } = metaKeys;

      const xlmAmount = parseFloat(amount);
      if (isNaN(xlmAmount) || xlmAmount <= 0) {
        console.error(chalk.red('Error: Invalid amount'));
        process.exit(1);
      }

      let senderKeypair: Keypair;
      if (options.from) {
        senderKeypair = Keypair.fromSecret(options.from);
      } else {
        console.error(chalk.red('Error: Please provide sender secret key with --from'));
        process.exit(1);
      }

      console.log(chalk.cyan('Deriving stealth address...'));

      const ephemeralPrivKey = randomBytes(32);
      const stealth = deriveStealthAddressWithSecret(
        spendPubKey,
        viewPubKey,
        ephemeralPrivKey
      );

      if (options.verbose) {
        console.log(chalk.gray('  Ephemeral public key:', Buffer.from(stealth.ephemeralPubKey).toString('hex')));
        console.log(chalk.gray('  Shared secret:', Buffer.from(stealth.sharedSecret).toString('hex')));
      }

      const stealthAddress = stealth.stealthAddress;
      console.log(chalk.gray(`  Stealth address: ${stealthAddress}`));
      console.log(chalk.gray(`  View tag: ${stealth.viewTag}`));

      const horizonUrl = network === 'local'
        ? 'http://localhost:8000'
        : 'https://horizon-testnet.stellar.org';

      const server = new Horizon.Server(horizonUrl);
      const networkPassphrase = network === 'local'
        ? Networks.STANDALONE
        : Networks.TESTNET;

      let stealthAccountExists = false;
      try {
        if (options.verbose) {
          console.log(chalk.gray(`  Checking if stealth account exists...`));
        }
        await withRetry(
          () => server.loadAccount(stealthAddress),
          'load stealth account',
          { verbose: options.verbose }
        );
        stealthAccountExists = true;
        if (options.verbose) {
          console.log(chalk.gray(`  Account exists`));
        }
      } catch (error: any) {
        if (error?.response?.status !== 404) {
          throw error;
        }
        if (options.verbose) {
          console.log(chalk.gray(`  Account does not exist`));
        }
      }

      const senderAccount = await withRetry(
        () => server.loadAccount(senderKeypair.publicKey()),
        'load sender account',
        { verbose: options.verbose }
      );
      let transaction: any;

      if (stealthAccountExists) {
        console.log(chalk.cyan('Sending payment to existing stealth account...'));

        transaction = new TransactionBuilder(senderAccount, {
          fee: '100',
          networkPassphrase
        })
        .addOperation(Operation.payment({
          destination: stealthAddress,
          asset: Asset.native(),
          amount: xlmAmount.toFixed(7)
        }))
        .setTimeout(30)
        .build();
      } else {
        if (options.relay) {
          console.log(chalk.cyan('Creating sponsored stealth account via relay...'));

          const response = await withRetry(
            async () => {
              const res = await fetch(`${options.relay}/sponsor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: stealthAddress })
              });
              if (!res.ok) {
                const error = await res.json();
                throw new Error(`Relay error: ${error.error}`);
              }
              return res;
            },
            'sponsor account via relay',
            { verbose: options.verbose }
          );

          console.log(chalk.gray('  Account sponsored successfully'));

          console.log(chalk.cyan('Sending payment...'));

          transaction = new TransactionBuilder(senderAccount, {
            fee: '100',
            networkPassphrase
          })
          .addOperation(Operation.payment({
            destination: stealthAddress,
            asset: Asset.native(),
            amount: xlmAmount.toFixed(7)
          }))
          .setTimeout(30)
          .build();
        } else {
          console.log(chalk.cyan('Creating and funding stealth account...'));

          transaction = new TransactionBuilder(senderAccount, {
            fee: '100',
            networkPassphrase
          })
          .addOperation(Operation.createAccount({
            destination: stealthAddress,
            startingBalance: xlmAmount.toFixed(7)
          }))
          .setTimeout(30)
          .build();
        }
      }

      transaction.sign(senderKeypair);

      if (options.verbose) {
        console.log(chalk.gray(`  Transaction hash: ${transaction.hash().toString('hex')}`));
        console.log(chalk.gray(`  Fee: ${transaction.fee} stroops`));
      }

      console.log(chalk.cyan('Submitting transaction...'));
      const result = await withRetry(
        () => server.submitTransaction(transaction),
        'submit transaction',
        { verbose: options.verbose }
      );

      console.log(chalk.green(`✓ Sent ${xlmAmount} XLM to stealth address`));
      console.log(chalk.gray(`  Transaction: ${result.hash}`));

      console.log(chalk.cyan('Storing announcement on-chain...'));

      let encryptedAmount: Uint8Array | undefined;
      if (options.encryptAmount) {
        encryptedAmount = encryptAmount(
          xlmAmount,
          Buffer.from(stealth.sharedSecret)
        );
      }

      const contractAddress = getContractAddress(network);
      await announceToContract(
        contractAddress,
        stealth.ephemeralPubKey,
        stealth.viewTag,
        encryptedAmount,
        senderKeypair,
        network
      );

      console.log(chalk.green('✓ Payment sent and announced successfully'));

    } catch (error: any) {
      const formattedError = formatError(error);
      console.error(chalk.red('Error sending:'), formattedError);
      if (options.verbose && error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });