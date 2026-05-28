import { Command } from 'commander';
import { generateMetaAddress, encodeMetaAddress } from '@stealth/crypto';
import { saveKeystore } from '../utils/keystore.js';
import chalk from 'chalk';
import path from 'path';
import os from 'os';

export const keygenCommand = new Command('keygen')
  .description('Generate a new stealth meta-address')
  .option('--keystore <path>', 'Keystore file path', path.join(os.homedir(), '.stealth-keys.json'))
  .action(async (options) => {
    try {
      console.log(chalk.cyan('Generating stealth keys...'));

      const keys = generateMetaAddress();
      const encoded = encodeMetaAddress(keys.metaAddress);

      await saveKeystore(options.keystore, {
        spendPublicKey: Buffer.from(keys.metaAddress.spendPubKey).toString('hex'),
        spendPrivateKey: Buffer.from(keys.spendPrivKey).toString('hex'),
        viewPublicKey: Buffer.from(keys.metaAddress.viewPubKey).toString('hex'),
        viewPrivateKey: Buffer.from(keys.viewPrivKey).toString('hex'),
      });

      console.log(chalk.green('\n✓ Stealth keys generated successfully'));
      console.log(chalk.white('\nMeta-address (share this to receive funds):'));
      console.log(chalk.yellow(encoded));
      console.log(chalk.gray(`\nKeystore saved to: ${options.keystore}`));
      console.log(chalk.gray('Keep this file safe - it contains your private keys!'));

    } catch (error: any) {
      console.error(chalk.red('Error generating keys:'), error.message);
      process.exit(1);
    }
  });