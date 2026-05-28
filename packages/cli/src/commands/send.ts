import { Command } from 'commander';
import { deriveStealthAddress, encryptAmount } from '@stealth/crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  Account,
  Horizon,
  StrKey
} from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getContractAddress } from '../utils/config.js';
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

  const server = new StellarSdk.SorobanRpc.Server(rpcUrl);
  const contract = new StellarSdk.Contract(contractId);

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
    StellarSdk.nativeToScVal(Buffer.from(ephemeralPubKey)),
    StellarSdk.nativeToScVal(viewTag, { type: 'u32' }),
    encryptedAmount
      ? StellarSdk.nativeToScVal(Buffer.from(encryptedAmount))
      : StellarSdk.nativeToScVal(null)
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
  .action(async (metaAddress: string, amount: string, options) => {
    try {
      const network = options.network as 'local' | 'testnet';

      const parts = metaAddress.split(':');
      if (parts.length !== 2) {
        console.error(chalk.red('Error: Invalid meta-address format (expected spend_key:view_key)'));
        process.exit(1);
      }

      const spendPubKey = Buffer.from(parts[0], 'hex');
      const viewPubKey = Buffer.from(parts[1], 'hex');

      if (spendPubKey.length !== 32 || viewPubKey.length !== 32) {
        console.error(chalk.red('Error: Invalid public key length'));
        process.exit(1);
      }

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
      const stealth = deriveStealthAddress(
        spendPubKey,
        viewPubKey,
        ephemeralPrivKey
      );

      const stealthAddress = StrKey.encodeEd25519PublicKey(stealth.stealthPubKey);
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
        await server.loadAccount(stealthAddress);
        stealthAccountExists = true;
      } catch (error: any) {
        if (error?.response?.status !== 404) {
          throw error;
        }
      }

      const senderAccount = await server.loadAccount(senderKeypair.publicKey());
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

          const response = await fetch(`${options.relay}/sponsor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: stealthAddress })
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(`Relay error: ${error.error}`);
          }

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

      console.log(chalk.cyan('Submitting transaction...'));
      const result = await server.submitTransaction(transaction);

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
      console.error(chalk.red('Error sending:'), error.message);
      process.exit(1);
    }
  });