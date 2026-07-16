import { Command } from 'commander';
import {
  generateMetaAddress,
  encodeMetaAddress,
  generateMnemonic,
  validateMnemonic,
  mnemonicToStealthKeys,
  buildKeyDerivationMessage,
  deriveKeysFromSignature,
} from '@shade/crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha256';
import {
  saveKeystore,
  resolveKeystorePath,
  promptPassword,
  keystoreExists,
} from '../utils/keystore.js';
import chalk from 'chalk';
import readline from 'readline';

/**
 * Reproduce the SEP-53 signing envelope locally and derive stealth keys.
 * message = buildKeyDerivationMessage({ network: keyScope, appId }); the signer
 * signs SHA-256 of ("Stellar Signed Message:\n" + message), matching how a
 * wallet would sign the same derivation message.
 *
 * `keyScope` is the crypto `network` scope field and is DECOUPLED from the
 * transport `--network` flag: it defaults to 'stealth' here and in the SDK's
 * keysFromWalletSignature, so the same wallet derives the SAME meta-address
 * across both tools. Changing the transport network must NOT change the keys.
 */
export function deriveFromStellarSecret(
  secret: string,
  keyScope: string,
  appId: string,
): ReturnType<typeof deriveKeysFromSignature> {
  const keypair = Keypair.fromSecret(secret);
  const message = buildKeyDerivationMessage({ network: keyScope, appId });
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

/**
 * Build a fresh `keygen` Command. A factory (rather than a shared singleton) so
 * tests can parse it repeatedly without commander option state leaking between
 * invocations.
 */
export function createKeygenCommand(): Command {
  return new Command('keygen')
  .description('Generate a new stealth meta-address')
  .option('--keystore <path>', 'Keystore file path (defaults to $SHADE_KEYSTORE or ~/.shade-keys.json)')
  .option('--password [password]', 'Encrypt the keystore with AES-256-GCM (prompts on stderr if the flag is given without a value)')
  .option('--plaintext', 'Write an UNENCRYPTED keystore (opt out of default encryption)')
  .option('--no-encrypt', 'Alias for --plaintext: write an UNENCRYPTED keystore')
  .option('--mnemonic', 'Generate keys from a new BIP-39 mnemonic (enables recovery)')
  .option('--recover', 'Recover keys from an existing 12-word mnemonic')
  .option('--from-stellar-secret [secret]', 'Derive keys deterministically from a Stellar secret (SEP-53)')
  .option('--app-id <id>', 'Application id to scope derived keys', 'default')
  .option('--key-scope <scope>', 'Key-derivation scope (decoupled from transport network; must match across tools)', 'stealth')
  .option('--force', 'Overwrite an existing keystore (DESTROYS the old keys and access to their unclaimed funds)')
  .action(async (options) => {
    try {
      // Resolve the target path FIRST and refuse to clobber an existing
      // keystore: overwriting silently destroys the old spend/view keys, and
      // with them access to any funds not yet claimed from the old
      // meta-address. Checked before any key generation or prompting.
      const keystorePath = resolveKeystorePath(options.keystore);
      if (!options.force && (await keystoreExists(keystorePath))) {
        console.error(chalk.red(`Error: a keystore already exists at ${keystorePath}`));
        console.error(
          chalk.red(
            '  Overwriting it DESTROYS the old keys — any unclaimed funds sent to the old meta-address would be lost forever.',
          ),
        );
        console.error(chalk.gray('  Options:'));
        console.error(chalk.gray('    - write elsewhere with a different --keystore <path>'));
        console.error(chalk.gray("    - just re-display the existing meta-address with 'shade address'"));
        console.error(chalk.gray('    - re-run with --force if you REALLY mean to overwrite it'));
        process.exit(1);
      }

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
          const keys = deriveFromStellarSecret(secret, options.keyScope, options.appId);
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
        console.log(chalk.gray('You can recover your keys later with: shade keygen --recover'));

      } else {
        console.log(chalk.cyan('Generating stealth keys...'));
        const keys = generateMetaAddress();
        spendPrivKey = keys.spendPrivKey;
        viewPrivKey = keys.viewPrivKey;
        spendPubKey = keys.metaAddress.spendPubKey;
        viewPubKey = keys.metaAddress.viewPubKey;
      }

      const encoded = encodeMetaAddress({ spendPubKey, viewPubKey });

      // Encryption is the DEFAULT (CLI-02). A plaintext keystore is written only
      // when explicitly opted out via --plaintext (or its --no-encrypt alias).
      // Otherwise: use --password X, or prompt on stderr when no source is given
      // so the secret never lands in shell history. An empty password is rejected.
      const wantsPlaintext = options.plaintext === true || options.encrypt === false;
      let password: string | undefined;
      if (wantsPlaintext) {
        if (options.password !== undefined) {
          console.error(
            chalk.red('Error: --plaintext cannot be combined with --password'),
          );
          process.exit(1);
        }
        password = undefined;
      } else {
        password =
          typeof options.password === 'string' && options.password.length > 0
            ? options.password
            : await promptPassword(chalk.white('Enter a password to encrypt the keystore: '));
        if (!password) {
          console.error(chalk.red('Error: an empty password cannot encrypt the keystore'));
          process.exit(1);
        }
      }

      await saveKeystore(
        keystorePath,
        {
          spendPublicKey: Buffer.from(spendPubKey).toString('hex'),
          spendPrivateKey: Buffer.from(spendPrivKey).toString('hex'),
          viewPublicKey: Buffer.from(viewPubKey).toString('hex'),
          viewPrivateKey: Buffer.from(viewPrivKey).toString('hex'),
        },
        password,
      );

      console.log(chalk.green('\n\u2713 Stealth keys generated successfully'));
      console.log(chalk.white('\nMeta-address (share this to receive funds):'));
      console.log(chalk.yellow(encoded));
      console.log(chalk.gray(`\nKeystore saved to: ${keystorePath}`));
      if (password) {
        console.log(chalk.gray('Keystore is encrypted (AES-256-GCM). You will be prompted for the password on read.'));
      } else {
        console.log(chalk.yellow('Warning: keystore is UNENCRYPTED plaintext (--plaintext). Re-run without it to encrypt.'));
      }
      console.log(chalk.gray('Keep this file safe — it contains your private keys!'));

    } catch (error: any) {
      console.error(chalk.red('Error generating keys:'), error.message);
      process.exit(1);
    }
  });
}

/** Shared `keygen` command instance wired into the CLI program. */
export const keygenCommand = createKeygenCommand();
