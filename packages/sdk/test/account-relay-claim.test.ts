import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import {
  Networks,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Keypair,
  Asset,
} from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import { HorizonClient, type FetchLike } from '../src/horizon.js';
import { challengeMessage } from '../src/relayer.js';
import { formatStroops } from '../src/stroops.js';
import type { StealthKeys, Payment } from '../src/types.js';

const NET = Networks.TESTNET;
const DEST = Keypair.random().publicKey();
const RELAYER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ASSET = `USDC:${ISSUER}`;
const CB_ID =
  '00000000' +
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

/** Build stealth keys + the derived stealth address for a fresh send. */
function makeFixture(): {
  keys: StealthKeys;
  stealthAddress: string;
  ephemeralPubKeyHex: string;
} {
  const raw = generateMetaAddress();
  const keys: StealthKeys = {
    metaAddress: encodeMetaAddress(raw.metaAddress),
    spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
  };
  const ephemeralPrivKey = new Uint8Array(randomBytes(32));
  const stealth = deriveStealthAddressWithSecret(
    raw.metaAddress.spendPubKey,
    raw.metaAddress.viewPubKey,
    ephemeralPrivKey,
  );
  return {
    keys,
    stealthAddress: stealth.stealthAddress,
    ephemeralPubKeyHex: Buffer.from(stealth.ephemeralPubKey).toString('hex'),
  };
}

/** A funded stealth account record (native balance) for getAccount probes. */
function accountRecord(address: string, nativeBalance: string) {
  return {
    id: address,
    sequence: '100',
    balances: [{ asset_type: 'native', balance: nativeBalance }],
  };
}

/** Horizon stub recording every directly-submitted transaction XDR. */
function makeCapturingHorizon(opts: {
  accountsByAddress?: Record<string, unknown>;
  submitted: string[];
}): HorizonClient {
  const fetchFn: FetchLike = async (url, init) => {
    if (url.includes('/accounts/')) {
      const address = url.split('/accounts/')[1]!.split(/[?/]/)[0]!;
      const account = opts.accountsByAddress?.[address];
      if (!account) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => account };
    }
    if (url.endsWith('/transactions') && init?.method === 'POST') {
      const body = init.body ?? '';
      opts.submitted.push(decodeURIComponent(body.replace(/^tx=/, '')));
      return { ok: true, status: 200, json: async () => ({ hash: 'SUBMITTED_HASH' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return new HorizonClient('https://horizon.mock', fetchFn);
}

/** A native payment fixture row for the given stealth identity. */
function nativePayment(stealthAddress: string, ephemeralPubKeyHex: string): Payment {
  return {
    stealthAddress,
    ephemeralPubKey: ephemeralPubKeyHex,
    token: 'native',
    amount: 5,
    amountStroops: '50000000',
    method: 'account',
  };
}

/**
 * Stub the global fetch (used by RelayerClient) serving /health, the credit
 * challenge, /relay and the sponsor-claim pair, recording every call.
 */
function stubRelayerFetch(opts?: {
  preparedXdr?: string;
  /** Override the /health body, or `'error'` for a 500 response. */
  health?: Record<string, unknown> | 'error';
}): Array<{
  url: string;
  body: Record<string, unknown>;
}> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, body });
      if (url.endsWith('/health')) {
        if (opts?.health === 'error') {
          return { ok: false, status: 500, json: async () => ({ error: 'down' }) };
        }
        const healthBody = opts?.health ?? {
          status: 'ok',
          requireCredit: true,
          maxRelayFeeXlm: 0.1,
        };
        return { ok: true, status: 200, json: async () => healthBody };
      }
      if (url.includes('/credit/challenge')) {
        return { ok: true, status: 200, json: async () => ({ nonce: 'NONCE123' }) };
      }
      if (url.endsWith('/relay')) {
        return { ok: true, status: 200, json: async () => ({ txHash: 'RELAYED_HASH' }) };
      }
      if (url.endsWith('/sponsor-claim/prepare')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ xdr: opts?.preparedXdr, expiresAt: 'later' }),
        };
      }
      if (url.endsWith('/sponsor-claim/submit')) {
        return { ok: true, status: 200, json: async () => ({ txHash: 'SPONSORED_HASH' }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    },
  );
  return calls;
}

/** The honest relayer-built sponsor-claim sandwich (unsigned XDR). */
function buildSponsorClaimXdr(args: {
  stealthAddress: string;
  destination: string;
  amount: string;
}): string {
  const asset = new Asset('USDC', ISSUER);
  return new TransactionBuilder(new Account(RELAYER, '5'), {
    fee: '200',
    networkPassphrase: NET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: args.stealthAddress }),
    )
    .addOperation(
      Operation.createAccount({ destination: args.stealthAddress, startingBalance: '0' }),
    )
    .addOperation(Operation.changeTrust({ asset, source: args.stealthAddress }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: args.stealthAddress }))
    .addOperation(
      Operation.claimClaimableBalance({ balanceId: CB_ID, source: args.stealthAddress }),
    )
    .addOperation(
      Operation.payment({
        destination: args.destination,
        asset,
        amount: args.amount,
        source: args.stealthAddress,
      }),
    )
    .setTimeout(60)
    .build()
    .toEnvelope()
    .toXDR('base64');
}

afterEach(() => vi.unstubAllGlobals());

describe('account relayed claim: fundingSigner auth (credit-gated relayers)', () => {
  it('threads the signed challenge triple into /relay, bound to the inner tx', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '5.0000000') },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);
    const calls = stubRelayerFetch();

    const fundingKp = Keypair.random();
    const receipt = await adapter.claim(
      nativePayment(stealthAddress, ephemeralPubKeyHex),
      DEST,
      {
        keys,
        relay: 'http://relayer.test',
        fundingAccount: fundingKp.publicKey(),
        fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
      },
    );
    expect(receipt.txHash).toBe('RELAYED_HASH');
    // Relayed merge delivers the whole balance (relayer pays the fee).
    expect(receipt.amount).toBe(5);

    // A challenge was fetched for the funding account, then /relay carried the
    // full proof-of-control triple. Without the signer a credit-gated relayer
    // rejects the bare {xdr, fundingAccount} with 401 missing_auth.
    const challengeCall = calls.find((c) => c.url.includes('/credit/challenge'));
    expect(challengeCall?.url).toContain(encodeURIComponent(fundingKp.publicKey()));
    const relayCall = calls.find((c) => c.url.endsWith('/relay'));
    expect(relayCall).toBeDefined();
    expect(relayCall!.body.fundingAccount).toBe(fundingKp.publicKey());
    expect(relayCall!.body.nonce).toBe('NONCE123');
    expect(typeof relayCall!.body.signature).toBe('string');
    // Ceiling from the relayer's advertised cap (/health maxRelayFeeXlm).
    expect(relayCall!.body.authAmount).toBe('0.1000000');

    // Signature verifies over the canonical message, bound to the exact inner
    // tx that was relayed (REL-01 tx-binding).
    const innerTxHash = new Transaction(relayCall!.body.xdr as string, NET)
      .hash()
      .toString('hex');
    const expectedMessage = challengeMessage(
      'relay',
      fundingKp.publicKey(),
      'NONCE123',
      '0.1000000',
      innerTxHash,
    );
    const sigOk = fundingKp.verify(
      Buffer.from(expectedMessage),
      Buffer.from(relayCall!.body.signature as string, 'base64'),
    );
    expect(sigOk).toBe(true);

    // The relayed XDR is the signed AccountMerge claim; nothing went direct.
    const inner = new Transaction(relayCall!.body.xdr as string, NET);
    expect(inner.operations.map((o) => o.type)).toEqual(['accountMerge']);
    expect(submitted).toHaveLength(0);
  });

  it('no signer: request body unchanged (free-relayer path), no challenge fetch', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '5.0000000') },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);
    const calls = stubRelayerFetch();

    const FUNDING = Keypair.random().publicKey();
    const receipt = await adapter.claim(
      nativePayment(stealthAddress, ephemeralPubKeyHex),
      DEST,
      { keys, relay: 'http://relayer.test', fundingAccount: FUNDING },
    );
    expect(receipt.txHash).toBe('RELAYED_HASH');

    const relayCall = calls.find((c) => c.url.endsWith('/relay'));
    expect(relayCall!.body.fundingAccount).toBe(FUNDING);
    expect('nonce' in relayCall!.body).toBe(false);
    expect('signature' in relayCall!.body).toBe(false);
    expect('authAmount' in relayCall!.body).toBe(false);
    expect(calls.find((c) => c.url.includes('/credit/challenge'))).toBeUndefined();
  });

  it('confirm: true polls the relayer-returned hash on the RPC handle', async () => {
    vi.useFakeTimers();
    try {
      const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
      const submitted: string[] = [];
      const horizon = makeCapturingHorizon({
        accountsByAddress: {
          [stealthAddress]: accountRecord(stealthAddress, '5.0000000'),
        },
        submitted,
      });
      const getTxCalls: string[] = [];
      const rpcServer = {
        async getTransaction(hash: string): Promise<{ status: string }> {
          getTxCalls.push(hash);
          return { status: 'SUCCESS' };
        },
      };
      const adapter = new AccountAdapter(NET, horizon, undefined, { rpcServer });
      stubRelayerFetch();

      const pending = adapter.claim(
        nativePayment(stealthAddress, ephemeralPubKeyHex),
        DEST,
        { keys, relay: 'http://relayer.test', confirm: true },
      );
      // The confirm poll sleeps 1s before each getTransaction probe.
      await vi.advanceTimersByTimeAsync(1_000);
      const receipt = await pending;

      expect(receipt.txHash).toBe('RELAYED_HASH');
      // The RELAYER'S hash was verified against the RPC — not trusted blindly.
      expect(getTxCalls).toEqual(['RELAYED_HASH']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes a gated claim through a dead-first relayer list to the live one (A3)', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '5.0000000') },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: { method?: string; body?: string }) => {
        if (url.startsWith('http://dead.invalid')) {
          throw new Error('getaddrinfo ENOTFOUND dead.invalid');
        }
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.endsWith('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: 'ok',
              network: 'testnet',
              balance: '50.0000000',
              requireCredit: true,
              maxRelayFeeXlm: 0.1,
            }),
          };
        }
        if (url.includes('/credit/challenge')) {
          return { ok: true, status: 200, json: async () => ({ nonce: 'NONCE123' }) };
        }
        if (url.endsWith('/relay')) {
          return { ok: true, status: 200, json: async () => ({ txHash: 'RELAYED_HASH' }) };
        }
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      },
    );

    const fundingKp = Keypair.random();
    const receipt = await adapter.claim(
      nativePayment(stealthAddress, ephemeralPubKeyHex),
      DEST,
      {
        keys,
        relay: ['http://dead.invalid', 'http://relayer.test'],
        fundingAccount: fundingKp.publicKey(),
        fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
      },
    );
    expect(receipt.txHash).toBe('RELAYED_HASH');

    // The auth triple landed at the live relayer; nothing went direct.
    const relayCalls = calls.filter((c) => c.url.endsWith('/relay'));
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.url).toBe('http://relayer.test/relay');
    expect(relayCalls[0]!.body.fundingAccount).toBe(fundingKp.publicKey());
    expect(relayCalls[0]!.body.nonce).toBe('NONCE123');
    expect(submitted).toHaveLength(0);
  });

  it('a per-call opts.relay wins over the ctor-configured relayer', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '5.0000000') },
      submitted,
    });
    // Regression: the old eager `this.relayerClient` silently shadowed a
    // DIFFERENT per-call relay URL with the ctor one.
    const adapter = new AccountAdapter(NET, horizon, 'http://ctor.test');
    const calls = stubRelayerFetch();

    await adapter.claim(nativePayment(stealthAddress, ephemeralPubKeyHex), DEST, {
      keys,
      relay: 'http://override.test',
    });

    const relayCalls = calls.filter((c) => c.url.endsWith('/relay'));
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.url).toBe('http://override.test/relay');
    expect(calls.some((c) => c.url.startsWith('http://ctor.test'))).toBe(false);
  });
});

describe('account sponsored claim: fundingSigner auth (credit-gated relayers)', () => {
  it('signs the sponsor-claim challenge over the EXACT fee+reserve total', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const preparedXdr = buildSponsorClaimXdr({
      stealthAddress,
      destination: DEST,
      amount: '100.0000000',
    });
    const calls = stubRelayerFetch({ preparedXdr });

    const destTrusts = {
      id: DEST,
      sequence: '1',
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: ISSUER,
          balance: '0.0000000',
        },
      ],
    };
    // No stealth account on Horizon -> sponsored path is taken.
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [DEST]: destTrusts },
      submitted: [],
    });
    const adapter = new AccountAdapter(NET, horizon, 'http://relayer.test');

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      amountStroops: '1000000000',
      method: 'account',
    };
    const fundingKp = Keypair.random();
    const receipt = await adapter.claim(payment, DEST, {
      keys,
      sponsored: true,
      fundingAccount: fundingKp.publicKey(),
      fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
    });
    expect(receipt.txHash).toBe('SPONSORED_HASH');

    // The submit leg carries the proof-of-control pair.
    const submit = calls.find((c) => c.url.endsWith('/sponsor-claim/submit'));
    expect(submit).toBeDefined();
    expect(submit!.body.fundingAccount).toBe(fundingKp.publicKey());
    expect(submit!.body.nonce).toBe('NONCE123');
    expect(typeof submit!.body.signature).toBe('string');

    // The relayer verifies the signature over the EXACT total it will debit:
    // the prepared tx's fee + the sponsored-reserve estimate — an exact match,
    // not a ceiling, and with no inner-tx bind on this endpoint. This stub's
    // /health does NOT advertise sponsoredReserveEstimate, so this doubles as
    // the absent-field case: the SDK falls back to the mirrored 1.0 XLM.
    const preparedFee = BigInt(new Transaction(preparedXdr, NET).fee);
    const expectedTotal = formatStroops(preparedFee + 10_000_000n);
    const expectedMessage = challengeMessage(
      'sponsor-claim',
      fundingKp.publicKey(),
      'NONCE123',
      expectedTotal,
    );
    const sigOk = fundingKp.verify(
      Buffer.from(expectedMessage),
      Buffer.from(submit!.body.signature as string, 'base64'),
    );
    expect(sigOk).toBe(true);
  });

  /**
   * Run one sponsored claim against the stubbed relayer with the given
   * /health behavior; assert the proof-of-control signature covers
   * `prepared fee + expectedReserveStroops` exactly.
   */
  async function expectSponsoredAuthTotal(
    health: Record<string, unknown> | 'error',
    expectedReserveStroops: bigint,
  ): Promise<void> {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const preparedXdr = buildSponsorClaimXdr({
      stealthAddress,
      destination: DEST,
      amount: '100.0000000',
    });
    const calls = stubRelayerFetch({ preparedXdr, health });

    const destTrusts = {
      id: DEST,
      sequence: '1',
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: ISSUER,
          balance: '0.0000000',
        },
      ],
    };
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [DEST]: destTrusts },
      submitted: [],
    });
    const adapter = new AccountAdapter(NET, horizon, 'http://relayer.test');

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      amountStroops: '1000000000',
      method: 'account',
    };
    const fundingKp = Keypair.random();
    const receipt = await adapter.claim(payment, DEST, {
      keys,
      sponsored: true,
      fundingAccount: fundingKp.publicKey(),
      fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
    });
    // The claim itself must succeed regardless of the /health behavior.
    expect(receipt.txHash).toBe('SPONSORED_HASH');

    const submit = calls.find((c) => c.url.endsWith('/sponsor-claim/submit'));
    const preparedFee = BigInt(new Transaction(preparedXdr, NET).fee);
    const expectedTotal = formatStroops(preparedFee + expectedReserveStroops);
    const expectedMessage = challengeMessage(
      'sponsor-claim',
      fundingKp.publicKey(),
      'NONCE123',
      expectedTotal,
    );
    const sigOk = fundingKp.verify(
      Buffer.from(expectedMessage),
      Buffer.from(submit!.body.signature as string, 'base64'),
    );
    expect(sigOk).toBe(true);
  }

  it('prefers the relayer-advertised sponsoredReserveEstimate from /health', async () => {
    // The relayer advertises 2.0 XLM — a silent relayer-side change away from
    // the mirrored 1.0 XLM constant must not break gated sponsored claims.
    await expectSponsoredAuthTotal(
      {
        status: 'ok',
        requireCredit: true,
        maxRelayFeeXlm: 0.1,
        sponsoredReserveEstimate: '2.0000000',
      },
      20_000_000n,
    );
  });

  it('falls back to the mirrored constant on an unparsable advertised estimate', async () => {
    await expectSponsoredAuthTotal(
      {
        status: 'ok',
        requireCredit: true,
        maxRelayFeeXlm: 0.1,
        sponsoredReserveEstimate: 'not-a-number',
      },
      10_000_000n,
    );
  });

  it('falls back to the mirrored constant when /health errors (claim not broken)', async () => {
    await expectSponsoredAuthTotal('error', 10_000_000n);
  });
});
