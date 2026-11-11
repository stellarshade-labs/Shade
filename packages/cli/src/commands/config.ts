import { Command } from 'commander';
import chalk from 'chalk';
import {
  CONTRACT_ENV_VAR,
  contractConfigFile,
  resolveContractAddress,
  saveContractAddress,
} from '../utils/config.js';
import { assertNetwork } from '../utils/network.js';

const SOURCE_LABEL = {
  flag: '--contract flag',
  env: `${CONTRACT_ENV_VAR} env var`,
  file: 'config file',
} as const;

const setContractCommand = new Command('set-contract')
  .description('Save the stealth pool contract id (C...) for a network to ~/.stealth/<network>-contract')
  .argument('<contract-id>', 'Soroban contract id of the stealth pool (see deployments/<network>.json in the Shade repo)')
  .option('--network <network>', 'Network to use', 'testnet')
  .action((contractId: string, options) => {
    const network = assertNetwork(options.network);
    try {
      const file = saveContractAddress(network, contractId);
      console.log(chalk.green(`✓ Saved ${network} pool contract ${contractId.trim()}`));
      console.log(chalk.gray(`  File: ${file}`));
      if (process.env[CONTRACT_ENV_VAR]?.trim()) {
        console.log(
          chalk.yellow(`  Note: ${CONTRACT_ENV_VAR} is set and takes precedence over this file.`),
        );
      }
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

const showCommand = new Command('show')
  .description('Show the stealth pool contract the other commands would use, and where it comes from')
  .option('--network <network>', 'Network to use', 'testnet')
  .option('--contract <id>', 'Contract override to validate (same precedence as other commands)')
  .action((options) => {
    const network = assertNetwork(options.network);
    try {
      const { address, source } = resolveContractAddress(network, options.contract);
      console.log(chalk.white(`Network:  ${network}`));
      console.log(chalk.white(`Contract: ${address}`));
      console.log(
        chalk.gray(
          `Source:   ${SOURCE_LABEL[source]}` +
            (source === 'file' ? ` (${contractConfigFile(network)})` : ''),
        ),
      );
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

export const configCommand = new Command('config')
  .description('Show or set CLI configuration (stealth pool contract)')
  .addCommand(setContractCommand)
  .addCommand(showCommand);
