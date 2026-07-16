import { Command } from 'commander';
import { encodeMetaAddress } from '@shade/crypto';
import { readPublicKeys, resolveKeystorePath } from '../utils/keystore.js';
import chalk from 'chalk';

/**
 * Build a fresh `address` Command. A factory (mirroring keygen) so tests can
 * parse it repeatedly without commander option state leaking between runs.
 *
 * Re-displays the stealth meta-address from an EXISTING keystore. No password
 * is needed: both the plaintext and encrypted envelopes store the spend/view
 * public keys in cleartext, and the meta-address is derived purely from them.
 * This is the safe answer to "I lost my meta-address" — as opposed to
 * re-running `shade keygen`, which would overwrite the keys.
 */
export function createAddressCommand(): Command {
  return new Command('address')
    .description('Show the stealth meta-address of an existing keystore (no password needed)')
    .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
    .action(async (options) => {
      const keystorePath = resolveKeystorePath(options.keystore);
      try {
        const { spendPublicKey, viewPublicKey } = await readPublicKeys(keystorePath);
        const encoded = encodeMetaAddress({
          spendPubKey: Buffer.from(spendPublicKey, 'hex'),
          viewPubKey: Buffer.from(viewPublicKey, 'hex'),
        });
        console.log(chalk.white('Meta-address (share this to receive funds):'));
        console.log(chalk.yellow(encoded));
        console.log(chalk.gray(`Keystore: ${keystorePath}`));
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          console.error(chalk.red(`Error: no keystore at ${keystorePath}`));
          console.error(chalk.gray("  Run 'shade keygen' to create one"));
        } else {
          console.error(chalk.red('Error reading keystore:'), error.message);
        }
        process.exit(1);
      }
    });
}

/** Shared `address` command instance wired into the CLI program. */
export const addressCommand = createAddressCommand();
