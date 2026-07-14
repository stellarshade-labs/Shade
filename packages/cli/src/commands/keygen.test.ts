import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock only the interactive prompt so the keystore is still written to a real
// temp file (we then inspect the on-disk envelope to assert encryption).
const promptMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/keystore.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/keystore.js')>(
    '../utils/keystore.js',
  );
  return { ...actual, promptPassword: promptMock };
});

const { createKeygenCommand } = await import('./keygen.js');

describe('keygen CLI-02: encryption is the default', () => {
  let dir: string;
  let keystorePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygen-cli02-'));
    keystorePath = path.join(dir, 'keys.json');
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Make process.exit throw so a rejected/aborted flow is observable and does
    // not tear down the test runner.
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
    const cmd = createKeygenCommand();
    await cmd.parseAsync(['node', 'keygen', ...args, '--keystore', keystorePath]);
  }

  it('bare keygen (prompt answered) writes an ENCRYPTED keystore', async () => {
    promptMock.mockResolvedValue('correct horse battery staple');

    await run([]);

    expect(promptMock).toHaveBeenCalledOnce();
    const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
    expect(parsed).toHaveProperty('encrypted');
    expect(parsed.encrypted).toHaveProperty('data');
    expect(parsed).not.toHaveProperty('spendPrivateKey');
  });

  it('keygen --plaintext writes a PLAINTEXT keystore', async () => {
    await run(['--plaintext']);

    expect(promptMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
    expect(parsed).not.toHaveProperty('encrypted');
    expect(parsed).toHaveProperty('spendPrivateKey');
    expect(parsed).toHaveProperty('viewPrivateKey');
  });

  it('rejects an empty prompted password (no keystore written)', async () => {
    promptMock.mockResolvedValue('');

    await expect(run([])).rejects.toThrow(/exit:1/);
    await expect(fs.access(keystorePath)).rejects.toThrow();
  });

  it('keygen --password X writes an ENCRYPTED keystore without prompting', async () => {
    await run(['--password', 'supersecret']);

    expect(promptMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
    expect(parsed).toHaveProperty('encrypted');
  });
});
