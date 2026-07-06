import { Command } from 'commander';
import {
  generateMetaAddress,
  encodeMetaAddress,
  generateMnemonic,
  validateMnemonic,
  mnemonicToStealthKeys,
  buildKeyDerivationMessage,
  deriveKeysFromSignature,
} from '@stealth/crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha256';
import { saveKeystore } from '../utils/keystore.js';
import chalk from 'chalk';
import path from 'path';
import os from 'os';
import readline from 'readline';

/**
 * Reproduce the SEP-53 signing envelope locally and derive stealth keys.
 * message = buildKeyDerivationMessage({ network, appId }); the signer signs
 * SHA-256 of ("Stellar Signed Message:\n" + message), matching how a wallet
 * would sign the same derivation message.
 */
function deriveFromStellarSecret(
  secret: string,
  network: string,
  appId: string,
): ReturnType<typeof deriveKeysFromSignature> {
  const keypair = Keypair.fromSecret(secret);
  const message = buildKeyDerivationMessage({ network, appId });
  const envelope = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf-8'),
    Buffer.from(message, 'utf-8'),
  ]);
  const digest = sha256(new Uint8Array(envelope));
  const signature = new Uint8Array(keypair.sign(Buffer.from(digest)));
  return deriveKeysFromSignature(signature);
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const keygenCommand = new Command('keygen')
  .description('Generate a new stealth meta-address')
  .option('--keystore <path>', 'Keystore file path', path.join(os.homedir(), '.stealth-keys.json'))
  .option('--mnemonic', 'Generate keys from a new BIP-39 mnemonic (enables recovery)')
  .option('--recover', 'Recover keys from an existing 12-word mnemonic')
  .option('--from-stellar-secret [secret]', 'Derive keys deterministically from a Stellar secret (SEP-53)')
  .option('--app-id <id>', 'Application id to scope derived keys', 'default')
  .option('--network <network>', 'Network to scope derived keys', 'local')
  .action(async (options) => {
    try {
      let spendPrivKey: Uint8Array;
      let viewPrivKey: Uint8Array;
      let spendPubKey: Uint8Array;
      let viewPubKey: Uint8Array;

      if (options.fromStellarSecret !== undefined) {
        console.log(chalk.cyan('Deriving stealth keys from Stellar secret (SEP-53)...'));
        let secret =
          typeof options.fromStellarSecret === 'string' ? options.fromStellarSecret : '';
        if (!secret) {
          secret = await promptLine(chalk.white('Enter your Stellar secret (S...): '));
        }
        try {
          const keys = deriveFromStellarSecret(secret, options.network, options.appId);
          spendPrivKey = keys.spendPrivKey;
          viewPrivKey = keys.viewPrivKey;
          spendPubKey = keys.metaAddress.spendPubKey;
          viewPubKey = keys.metaAddress.viewPubKey;
        } catch (e: any) {
          console.error(chalk.red('Error: Invalid Stellar secret'), e.message);
          process.exit(1);
        }

      } else if (options.recover) {
        console.log(chalk.cyan('Recovering stealth keys from mnemonic...'));
        const words = await promptLine(chalk.white('Enter your 12-word mnemonic: '));

        if (!validateMnemonic(words)) {
          console.error(chalk.red('Error: Invalid mnemonic phrase'));
          process.exit(1);
        }

        const keys = mnemonicToStealthKeys(words);
        spendPrivKey = keys.spendPrivKey;
        viewPrivKey = keys.viewPrivKey;
        spendPubKey = keys.metaAddress.spendPubKey;
        viewPubKey = keys.metaAddress.viewPubKey;

      } else if (options.mnemonic) {
        console.log(chalk.cyan('Generating stealth keys from mnemonic...'));
        const mnemonic = generateMnemonic();

        const keys = mnemonicToStealthKeys(mnemonic);
        spendPrivKey = keys.spendPrivKey;
        viewPrivKey = keys.viewPrivKey;
        spendPubKey = keys.metaAddress.spendPubKey;
        viewPubKey = keys.metaAddress.viewPubKey;

        console.log(chalk.yellow('\nMnemonic (write this down — it is your only backup):'));
        console.log(chalk.white(`  ${mnemonic}`));
        console.log(chalk.gray('You can recover your keys later with: stealth keygen --recover'));

      } else {
        console.log(chalk.cyan('Generating stealth keys...'));
        const keys = generateMetaAddress();
        spendPrivKey = keys.spendPrivKey;
        viewPrivKey = keys.viewPrivKey;
        spendPubKey = keys.metaAddress.spendPubKey;
        viewPubKey = keys.metaAddress.viewPubKey;
      }

      const encoded = encodeMetaAddress({ spendPubKey, viewPubKey });

      await saveKeystore(options.keystore, {
        spendPublicKey: Buffer.from(spendPubKey).toString('hex'),
        spendPrivateKey: Buffer.from(spendPrivKey).toString('hex'),
        viewPublicKey: Buffer.from(viewPubKey).toString('hex'),
        viewPrivateKey: Buffer.from(viewPrivKey).toString('hex'),
      });

      console.log(chalk.green('\n\u2713 Stealth keys generated successfully'));
      console.log(chalk.white('\nMeta-address (share this to receive funds):'));
      console.log(chalk.yellow(encoded));
      console.log(chalk.gray(`\nKeystore saved to: ${options.keystore}`));
      console.log(chalk.gray('Keep this file safe — it contains your private keys!'));

    } catch (error: any) {
      console.error(chalk.red('Error generating keys:'), error.message);
      process.exit(1);
    }
  });
