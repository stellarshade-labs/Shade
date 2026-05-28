#!/usr/bin/env node

import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
const { version } = packageJson;

const program = new Command();

program
  .name('stealth')
  .description('CLI for Stellar stealth addresses using DKSAP')
  .version(version)
  .option('-n, --network <network>', 'Network to use (local or testnet)', 'local');

program
  .command('keygen')
  .description('Generate a new stealth meta-address')
  .action(() => {
    console.log('Keygen command not yet implemented');
  });

program
  .command('send')
  .description('Send funds to a stealth address')
  .action(() => {
    console.log('Send command not yet implemented');
  });

program
  .command('scan')
  .description('Scan for incoming stealth payments')
  .action(() => {
    console.log('Scan command not yet implemented');
  });

program
  .command('withdraw')
  .description('Withdraw funds from a stealth address')
  .action(() => {
    console.log('Withdraw command not yet implemented');
  });

program.parse();