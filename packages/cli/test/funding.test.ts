import { describe, it, expect, afterEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { resolveFundingAuth } from '../src/utils/funding.js';

const ORIGINAL_ENV = process.env.SHADE_FUNDING_SECRET;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SHADE_FUNDING_SECRET;
  else process.env.SHADE_FUNDING_SECRET = ORIGINAL_ENV;
});

describe('resolveFundingAuth', () => {
  it('returns {} without prompting when nothing is configured', async () => {
    delete process.env.SHADE_FUNDING_SECRET;
    // Would hang on the stderr prompt if the neither-source path prompted.
    const auth = await resolveFundingAuth({});
    expect(auth).toEqual({});
  });

  it('derives the funding account from a secret alone, with a working signer', async () => {
    const kp = Keypair.random();
    const auth = await resolveFundingAuth({ fundingSecret: kp.secret() });
    expect(auth.fundingAccount).toBe(kp.publicKey());
    expect(auth.fundingSigner).toBeDefined();

    const message = 'shade-relayer:v1:relay:acct:nonce:0.1000000';
    const raw = await auth.fundingSigner!(message);
    const sig = typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw);
    expect(kp.verify(Buffer.from(message), sig)).toBe(true);
  });

  it('accepts a matching account + secret pair', async () => {
    const kp = Keypair.random();
    const auth = await resolveFundingAuth({
      fundingAccount: kp.publicKey(),
      fundingSecret: kp.secret(),
    });
    expect(auth.fundingAccount).toBe(kp.publicKey());
    expect(auth.fundingSigner).toBeDefined();
  });

  it('throws when the secret does not control the given account', async () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    await expect(
      resolveFundingAuth({
        fundingAccount: other.publicKey(),
        fundingSecret: kp.secret(),
      }),
    ).rejects.toThrow(/does not|controls/);
  });

  it('throws on a malformed secret', async () => {
    await expect(
      resolveFundingAuth({ fundingSecret: 'not-a-secret' }),
    ).rejects.toThrow(/Invalid funding secret/);
  });

  it('falls back to SHADE_FUNDING_SECRET when no flag is given', async () => {
    const kp = Keypair.random();
    process.env.SHADE_FUNDING_SECRET = kp.secret();
    const auth = await resolveFundingAuth({});
    expect(auth.fundingAccount).toBe(kp.publicKey());
  });

  it('prefers the flag over the env var', async () => {
    const envKp = Keypair.random();
    const flagKp = Keypair.random();
    process.env.SHADE_FUNDING_SECRET = envKp.secret();
    const auth = await resolveFundingAuth({ fundingSecret: flagKp.secret() });
    expect(auth.fundingAccount).toBe(flagKp.publicKey());
  });
});
