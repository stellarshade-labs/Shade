import { describe, it, expect, afterEach } from 'vitest';
import { resolveSecret } from './secrets.js';

describe('resolveSecret', () => {
  const ENV = 'STEALTH_TEST_SECRET';

  afterEach(() => {
    delete process.env[ENV];
  });

  it('prefers an inline flag over the env var', async () => {
    process.env[ENV] = 'from-env';
    const resolved = await resolveSecret('from-flag', ENV, 'unused: ');
    expect(resolved).toBe('from-flag');
  });

  it('reads the secret from the env var when the flag is absent', async () => {
    process.env[ENV] = 'SXXXENVSECRET';
    const resolved = await resolveSecret(undefined, ENV, 'unused: ');
    expect(resolved).toBe('SXXXENVSECRET');
  });

  it('ignores an empty-string flag and falls back to the env var', async () => {
    process.env[ENV] = 'SXXXENVSECRET';
    const resolved = await resolveSecret('', ENV, 'unused: ');
    expect(resolved).toBe('SXXXENVSECRET');
  });
});
