import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same isolation as config.test.ts: point `os.homedir` (namespace AND default
// export) at a throwaway dir so these tests never read or write the real
// ~/.stealth/<network>-contract file.
const { TEMP_HOME } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-contract-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => TEMP_HOME };
  return { ...mocked, default: mocked };
});

const fs = await import('fs');
const {
  CONTRACT_ENV_VAR,
  contractConfigFile,
  getContractAddress,
  resolveContractAddress,
  saveContractAddress,
} = await import('./config.js');

const NET = 'testnet' as const;
// Two real, valid testnet contract ids (the canonical pool and the native SAC).
const POOL = 'CDWHNQU2URGJOI6VJU2ZVKRKRMMIKFVXCAMZC45HB6SZKTKGISS7YJ42';
const OTHER = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('pool contract resolution', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[CONTRACT_ENV_VAR];
    delete process.env[CONTRACT_ENV_VAR];
    fs.rmSync(contractConfigFile(NET), { force: true });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[CONTRACT_ENV_VAR];
    else process.env[CONTRACT_ENV_VAR] = savedEnv;
    fs.rmSync(contractConfigFile(NET), { force: true });
  });

  it('keeps the config file under the mocked home directory', () => {
    expect(contractConfigFile(NET).startsWith(TEMP_HOME)).toBe(true);
  });

  it('throws an actionable error naming every source when nothing is configured', () => {
    expect(() => getContractAddress(NET)).toThrow(/--contract/);
    expect(() => getContractAddress(NET)).toThrow(/SHADE_CONTRACT/);
    expect(() => getContractAddress(NET)).toThrow(/set-contract/);
    expect(() => getContractAddress(NET)).toThrow(/deployments\/testnet\.json/);
  });

  it('reads the per-network file written by saveContractAddress', () => {
    const file = saveContractAddress(NET, `  ${POOL}\n`);
    expect(file).toBe(contractConfigFile(NET));
    expect(fs.readFileSync(file, 'utf-8')).toBe(POOL);
    expect(resolveContractAddress(NET)).toEqual({ address: POOL, source: 'file' });
  });

  it('prefers SHADE_CONTRACT over the file', () => {
    saveContractAddress(NET, POOL);
    process.env[CONTRACT_ENV_VAR] = OTHER;
    expect(resolveContractAddress(NET)).toEqual({ address: OTHER, source: 'env' });
  });

  it('prefers the --contract flag over env and file', () => {
    saveContractAddress(NET, OTHER);
    process.env[CONTRACT_ENV_VAR] = OTHER;
    expect(resolveContractAddress(NET, POOL)).toEqual({ address: POOL, source: 'flag' });
  });

  it('ignores blank flag and env values', () => {
    saveContractAddress(NET, POOL);
    process.env[CONTRACT_ENV_VAR] = '   ';
    expect(resolveContractAddress(NET, '')).toEqual({ address: POOL, source: 'file' });
  });

  it('rejects a non-contract value from each source, naming the source', () => {
    const account = 'GA56OH72C23VNBDDUQ5DDSPUFQSFAL55HEBYR4RC3SWDB6NOIJQXUGZM';
    expect(() => resolveContractAddress(NET, account)).toThrow(/from --contract/);

    process.env[CONTRACT_ENV_VAR] = 'not-a-contract';
    expect(() => resolveContractAddress(NET)).toThrow(/from SHADE_CONTRACT/);

    delete process.env[CONTRACT_ENV_VAR];
    fs.mkdirSync(TEMP_HOME + '/.stealth', { recursive: true });
    fs.writeFileSync(contractConfigFile(NET), 'CBROKEN');
    expect(() => resolveContractAddress(NET)).toThrow(/Invalid stealth pool contract/);
  });

  it('refuses to save an invalid contract id', () => {
    expect(() => saveContractAddress(NET, 'GBAD')).toThrow(/Invalid stealth pool contract/);
    expect(fs.existsSync(contractConfigFile(NET))).toBe(false);
  });
});
