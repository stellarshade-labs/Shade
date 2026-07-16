import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { generateMetaAddress, encodeMetaAddress } from '@shade/crypto';
import { saveKeystore, type Keystore } from '../utils/keystore.js';
import { createAddressCommand } from './address.js';

describe('shade address (re-display meta-address without password)', () => {
  let dir: string;
  let keystorePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /** Fresh valid keys and the meta-address the command must reproduce. */
  function makeKeys(): { keystore: Keystore; expected: string } {
    const keys = generateMetaAddress();
    return {
      keystore: {
        spendPublicKey: Buffer.from(keys.metaAddress.spendPubKey).toString('hex'),
        spendPrivateKey: Buffer.from(keys.spendPrivKey).toString('hex'),
        viewPublicKey: Buffer.from(keys.metaAddress.viewPubKey).toString('hex'),
        viewPrivateKey: Buffer.from(keys.viewPrivKey).toString('hex'),
      },
      expected: encodeMetaAddress(keys.metaAddress),
    };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'address-cmd-'));
    keystorePath = path.join(dir, 'keys.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<void> {
    const cmd = createAddressCommand();
    await cmd.parseAsync(['node', 'address', ...args]);
  }

  function logOutput(): string {
    return logSpy.mock.calls.flat().join('\n');
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.flat().join('\n');
  }

  it('prints the meta-address from an ENCRYPTED keystore with NO password', async () => {
    const { keystore, expected } = makeKeys();
    await saveKeystore(keystorePath, keystore, 'super-secret-password');

    await run(['--keystore', keystorePath]);

    expect(logOutput()).toContain(expected);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints the meta-address from a PLAINTEXT keystore', async () => {
    const { keystore, expected } = makeKeys();
    await saveKeystore(keystorePath, keystore);

    await run(['--keystore', keystorePath]);

    expect(logOutput()).toContain(expected);
  });

  it('missing keystore → "no keystore at <path>" + keygen hint, exit 1', async () => {
    const missing = path.join(dir, 'nope.json');

    await expect(run(['--keystore', missing])).rejects.toThrow(/exit:1/);

    const out = errorOutput();
    expect(out).toMatch(/no keystore at/i);
    expect(out).toContain(missing);
    expect(out).toMatch(/shade keygen/);
  });

  it('keystore without public keys → clear error, NOT the missing-file hint', async () => {
    await fs.writeFile(keystorePath, JSON.stringify({ hello: 'world' }));

    await expect(run(['--keystore', keystorePath])).rejects.toThrow(/exit:1/);

    const out = errorOutput();
    expect(out).toMatch(/no public keys/i);
    expect(out).not.toMatch(/no keystore at/i);
  });
});
