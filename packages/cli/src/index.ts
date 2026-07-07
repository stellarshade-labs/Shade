#!/usr/bin/env node

import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { keygenCommand } from './commands/keygen.js';
import { sendCommand } from './commands/send.js';
import { scanCommand } from './commands/scan.js';
import { withdrawCommand } from './commands/withdraw.js';
import { claimCommand } from './commands/claim.js';
import { balanceCommand } from './commands/balance.js';

const { version } = packageJson;

const program = new Command();

program
  .name('stealth')
  .description('CLI for Stellar stealth addresses using DKSAP')
  .version(version);

program.addCommand(keygenCommand);
program.addCommand(sendCommand);
program.addCommand(scanCommand);
program.addCommand(withdrawCommand);
program.addCommand(claimCommand);
program.addCommand(balanceCommand);

program.parse();