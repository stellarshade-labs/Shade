import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.stealth');

export function getContractAddress(network: 'local' | 'testnet'): string {
  const configFile = path.join(CONFIG_DIR, `${network}-contract`);

  try {
    const address = fs.readFileSync(configFile, 'utf-8').trim();
    if (address) return address;
  } catch {
    // Fall through to defaults
  }

  // Default addresses (these should be updated after deployment)
  if (network === 'local') {
    // Try to read from project config first
    try {
      const projectConfig = path.join(process.cwd(), 'packages/cli/.stealth/local-contract');
      const address = fs.readFileSync(projectConfig, 'utf-8').trim();
      if (address) return address;
    } catch {
      // Use fallback
    }
    return 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGABAX';
  } else {
    return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  }
}

export function saveContractAddress(network: 'local' | 'testnet', address: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const configFile = path.join(CONFIG_DIR, `${network}-contract`);
  fs.writeFileSync(configFile, address);
}