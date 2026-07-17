#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import packageJson from '../package.json' with { type: 'json' };
import { keygenCommand } from './commands/keygen.js';
import { addressCommand } from './commands/address.js';
import { sendCommand } from './commands/send.js';
import { scanCommand } from './commands/scan.js';
import { withdrawCommand } from './commands/withdraw.js';
import { claimCommand } from './commands/claim.js';
import { balanceCommand } from './commands/balance.js';

const { version } = packageJson;

const program = new Command();

program
  .name('shade')
  .description('CLI for Stellar stealth addresses using DKSAP')
  .version(version);

program.addCommand(keygenCommand);
program.addCommand(addressCommand);
program.addCommand(sendCommand);
program.addCommand(scanCommand);
program.addCommand(withdrawCommand);
program.addCommand(claimCommand);
program.addCommand(balanceCommand);

// parseAsync (not parse) so a rejection escaping a command action — e.g. a
// prompt whose stdin closed — still prints on stderr and exits non-zero
// instead of node draining the event loop and exiting 0 mid-command.
program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red('Error:'), message);
  process.exit(1);
});