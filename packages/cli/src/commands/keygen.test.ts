import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PassThrough } from 'stream';

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

describe('keygen overwrite protection (fund safety)', () => {
  let dir: string;
  let keystorePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keygen-force-'));
    keystorePath = path.join(dir, 'keys.json');
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
    const cmd = createKeygenCommand();
    await cmd.parseAsync(['node', 'keygen', ...args, '--keystore', keystorePath]);
  }

  it('refuses to overwrite an existing keystore without --force (before any prompt)', async () => {
    await run(['--password', 'first-password']);
    const before = await fs.readFile(keystorePath, 'utf-8');

    promptMock.mockClear();
    await expect(run([])).rejects.toThrow(/exit:1/);

    // Refused EARLY: no password prompt, no key generation output reached.
    expect(promptMock).not.toHaveBeenCalled();

    // The existing keystore is byte-identical — nothing was destroyed.
    const after = await fs.readFile(keystorePath, 'utf-8');
    expect(after).toBe(before);

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toMatch(/already exists/i);
    expect(output).toMatch(/DESTROYS/);
    expect(output).toMatch(/--force/);
    expect(output).toMatch(/--keystore/);
    expect(output).toMatch(/shade address/);
  });

  it('refusal also applies to --recover and --from-stellar-secret flows', async () => {
    await run(['--password', 'first-password']);
    const before = await fs.readFile(keystorePath, 'utf-8');

    await expect(run(['--recover'])).rejects.toThrow(/exit:1/);
    await expect(run(['--from-stellar-secret', 'SXXX'])).rejects.toThrow(/exit:1/);

    expect(await fs.readFile(keystorePath, 'utf-8')).toBe(before);
  });

  it('overwrites the keystore when --force is given', async () => {
    await run(['--password', 'first-password']);
    const before = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));

    await run(['--force', '--password', 'second-password']);
    const after = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));

    // Fresh random keys were written over the old envelope.
    expect(after).toHaveProperty('encrypted');
    expect(after.spendPublicKey).not.toBe(before.spendPublicKey);
  });

  it('writes normally when no keystore exists yet (no --force needed)', async () => {
    await run(['--password', 'pw']);
    const parsed = JSON.parse(await fs.readFile(keystorePath, 'utf-8'));
    expect(parsed).toHaveProperty('encrypted');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('promptLine (closed stdin must fail loudly, not exit 0)', () => {
  /** Swap process.stdin (a configurable getter on `process`) for a fake. */
  function useStdin(fake: unknown): void {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      fake as unknown as typeof process.stdin,
    );
  }

  beforeEach(() => {
    // readline echoes the question to stderr.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects when stdin ends before a line arrives', async () => {
    const input = new PassThrough();
    input.end(); // e.g. `shade keygen --recover < /dev/null`
    useStdin(input);
    const { promptLine } = await import('./keygen.js');

    await expect(promptLine('Enter your 12-word mnemonic: ')).rejects.toThrow(
      /stdin closed before input was received/,
    );
  });

  it('still resolves (and trims) a normal piped line', async () => {
    const input = new PassThrough();
    useStdin(input);
    const { promptLine } = await import('./keygen.js');

    const pending = promptLine('Enter your 12-word mnemonic: ');
    input.end('  alpha bravo charlie  \n');

    await expect(pending).resolves.toBe('alpha bravo charlie');
  });
});
