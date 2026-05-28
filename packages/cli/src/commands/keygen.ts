import { Command } from 'commander';
import {
  generateMetaAddress,
  encodeMetaAddress,
  generateMnemonic,
  validateMnemonic,
  mnemonicToStealthKeys,
} from '@stealth/crypto';
import { saveKeystore } from '../utils/keystore.js';
import chalk from 'chalk';
import path from 'path';
import os from 'os';
import readline from 'readline';

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
  .action(async (options) => {
    try {
      let spendPrivKey: Uint8Array;
      let viewPrivKey: Uint8Array;
      let spendPubKey: Uint8Array;
      let viewPubKey: Uint8Array;

      if (options.recover) {
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
