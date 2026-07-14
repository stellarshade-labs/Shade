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
  Memo,
} from '@stellar/stellar-sdk';
import { AccountAdapter } from '../src/methods/account.js';
import { HorizonClient, type FetchLike } from '../src/horizon.js';
import {
  ClaimAmountError,
  InvalidAmountError,
  SponsoredClaimMismatchError,
} from '../src/errors.js';
import type { StealthKeys, Payment } from '../src/types.js';

const NET = Networks.STANDALONE;
const DEST = Keypair.random().publicKey();
const RELAYER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ASSET = `USDC:${ISSUER}`;
const CB_ID =
  '00000000' +
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

/** Build stealth keys + a native/token payment fixture for a fresh send. */
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
function accountRecord(address: string, nativeBalance: string, extra: unknown[] = []) {
  return {
    id: address,
    sequence: '100',
    balances: [
      { asset_type: 'native', balance: nativeBalance },
      ...extra,
    ],
  };
}

/**
 * Horizon stub that records every submitted transaction XDR. Serves accounts,
 * claimable balances, and a submit endpoint returning a fixed hash.
 */
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
      const xdr = decodeURIComponent(body.replace(/^tx=/, ''));
      opts.submitted.push(xdr);
      return { ok: true, status: 200, json: async () => ({ hash: 'SUBMITTED_HASH' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return new HorizonClient('http://localhost:8000', fetchFn);
}

/** Parse a captured base64 envelope XDR into a Transaction to inspect ops. */
function parseTx(xdr: string): Transaction {
  return new Transaction(xdr, NET);
}

/**
 * Build the full relayer-sourced sponsor-claim sandwich XDR (unsigned) exactly
 * as the relayer's `buildSponsorClaimOps` produces it, so the SDK's pre-signing
 * verification accepts the honest case. Optional overrides let a test tamper with
 * a single field (destination, amount, source), append an extra op, or add a memo
 * to prove the verification rejects a malicious relayer.
 */
function buildSponsorClaimXdr(args: {
  relayer: string;
  stealthAddress: string;
  asset: Asset;
  balanceId: string;
  destination: string;
  amount: string;
  withCreate?: boolean;
  payoutDestination?: string;
  payoutAmount?: string;
  paymentSource?: string;
  extraOp?: Operation;
  memo?: Memo;
  source?: string;
}): string {
  const builder = new TransactionBuilder(new Account(args.source ?? args.relayer, '5'), {
    fee: '200',
    networkPassphrase: NET,
  });
  builder.addOperation(
    Operation.beginSponsoringFutureReserves({ sponsoredId: args.stealthAddress }),
  );
  if (args.withCreate) {
    builder.addOperation(
      Operation.createAccount({ destination: args.stealthAddress, startingBalance: '0' }),
    );
  }
  builder.addOperation(
    Operation.changeTrust({ asset: args.asset, source: args.stealthAddress }),
  );
  builder.addOperation(
    Operation.endSponsoringFutureReserves({ source: args.stealthAddress }),
  );
  builder.addOperation(
    Operation.claimClaimableBalance({
      balanceId: args.balanceId,
      source: args.stealthAddress,
    }),
  );
  builder.addOperation(
    Operation.payment({
      destination: args.payoutDestination ?? args.destination,
      asset: args.asset,
      amount: args.payoutAmount ?? args.amount,
      source: args.paymentSource ?? args.stealthAddress,
    }),
  );
  if (args.extraOp) builder.addOperation(args.extraOp);
  if (args.memo) builder.addMemo(args.memo);
  return builder.setTimeout(60).build().toEnvelope().toXDR('base64');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('account claim: native', () => {
  it('full merge builds an AccountMerge and receipt is balance minus fee (non-relayed)', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '5.0000000') },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: 'native',
      amount: 5,
      method: 'account',
    };

    const receipt = await adapter.claim(payment, DEST, { keys, merge: true });

    // Receipt subtracts the self-paid base fee (100 stroops = 0.00001 XLM).
    expect(receipt.amount).toBeCloseTo(5 - 0.00001, 7);
    expect(receipt.method).toBe('account');

    expect(submitted).toHaveLength(1);
    const ops = parseTx(submitted[0]!).operations;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('accountMerge');
    expect((ops[0] as { destination: string }).destination).toBe(DEST);
  });

  it('partial claim builds a Payment op for the requested amount', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '10.0000000') },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: 'native',
      amount: 10,
      method: 'account',
    };

    const receipt = await adapter.claim(payment, DEST, {
      keys,
      merge: false,
      amount: 4,
    });
    expect(receipt.amount).toBe(4);

    const ops = parseTx(submitted[0]!).operations;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe('payment');
    expect((ops[0] as { amount: string }).amount).toBe('4.0000000');
  });

  it('partial claim over the max throws ClaimAmountError naming the max', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [stealthAddress]: accountRecord(stealthAddress, '5.0000000') },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: 'native',
      amount: 5,
      method: 'account',
    };

    // max = 5 - 1.0 (2x base reserve) - 0.00001 (fee) = 3.99999
    const err = await adapter
      .claim(payment, DEST, { keys, merge: false, amount: 4.5 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ClaimAmountError);
    expect((err as ClaimAmountError).max).toBeCloseTo(3.99999, 7);
    // Nothing was submitted — rejected before building.
    expect(submitted).toHaveLength(0);
  });
});

describe('account claim: token self-funded', () => {
  it('builds ChangeTrust -> Claim -> Payment -> ChangeTrust(0) -> AccountMerge', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    // Destination trusts the asset; stealth account exists (self-funded path).
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
      accountsByAddress: {
        [stealthAddress]: accountRecord(stealthAddress, '1.5001000'),
        [DEST]: destTrusts,
      },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      method: 'account',
    };

    const receipt = await adapter.claim(payment, DEST, { keys, merge: true });
    expect(receipt.amount).toBe(100);

    const ops = parseTx(submitted[0]!).operations;
    expect(ops.map((o) => o.type)).toEqual([
      'changeTrust',
      'claimClaimableBalance',
      'payment',
      'changeTrust',
      'accountMerge',
    ]);
  });

  it('pays the EXACT stroops from amountStroops, not the lossy number (SDK-PREC-1)', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
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
      accountsByAddress: {
        [stealthAddress]: accountRecord(stealthAddress, '1.5001000'),
        [DEST]: destTrusts,
      },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    // 2e9 units + 1 stroop. The exact stroop count is 20000000000000001, which a
    // JS double cannot represent (2000000000.0000001 rounds to ...0000000).
    const EXACT = '2000000000.0000001';
    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: Number(EXACT), // lossy — proves the code does NOT use this
      amountStroops: '20000000000000001',
      method: 'account',
    };

    await adapter.claim(payment, DEST, { keys, merge: true });

    const ops = parseTx(submitted[0]!).operations;
    const payOp = ops.find((o) => o.type === 'payment') as { amount: string };
    expect(payOp.amount).toBe(EXACT);
    expect(payOp.amount).not.toBe('2000000000.0000000');
  });

  it('rejects when the destination has no trustline', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    const destNoTrust = { id: DEST, sequence: '1', balances: [] };
    const horizon = makeCapturingHorizon({
      accountsByAddress: {
        [stealthAddress]: accountRecord(stealthAddress, '1.5001000'),
        [DEST]: destNoTrust,
      },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      method: 'account',
    };

    const err = await adapter.claim(payment, DEST, { keys }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/does not trust/);
    expect(submitted).toHaveLength(0);
  });

  it('rejects when the destination account is not found', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();
    const submitted: string[] = [];
    // DEST omitted -> 404.
    const horizon = makeCapturingHorizon({
      accountsByAddress: {
        [stealthAddress]: accountRecord(stealthAddress, '1.5001000'),
      },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      method: 'account',
    };

    const err = await adapter.claim(payment, DEST, { keys }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not found/);
    expect(submitted).toHaveLength(0);
  });
});

describe('account claim: token sponsored', () => {
  it('threads destination through prepare/submit and returns a receipt after payout', async () => {
    const { keys, stealthAddress, ephemeralPubKeyHex } = makeFixture();

    // Build a real relayer-sourced prepared tx (unsigned) that the SDK co-signs.
    // The honest prepared tx is the full sponsor-claim sandwich the relayer
    // builds; the SDK verifies it op-by-op before signing.
    const preparedXdr = buildSponsorClaimXdr({
      relayer: RELAYER,
      stealthAddress,
      asset: new Asset('USDC', ISSUER),
      balanceId: CB_ID,
      destination: DEST,
      amount: '100.0000000',
      withCreate: true,
    });

    const calls: Array<{ path: string; body: unknown }> = [];
    // Stub global fetch: the RelayerClient uses it for prepare + submit.
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: { body?: string }) => {
        const path = url.replace('http://relayer', '');
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ path, body });
        if (path === '/sponsor-claim/prepare') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ xdr: preparedXdr, expiresAt: 'later' }),
          };
        }
        if (path === '/sponsor-claim/submit') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ txHash: 'SPONSORED_HASH' }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    );

    // No stealth account on Horizon -> sponsored path is taken. Destination
    // trust is enforced server-side (the SDK also probes via horizon here).
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
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [DEST]: destTrusts },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon, 'http://relayer');

    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      method: 'account',
    };

    const receipt = await adapter.claim(payment, DEST, { keys, sponsored: true });
    expect(receipt.txHash).toBe('SPONSORED_HASH');
    expect(receipt.amount).toBe(100);

    const prepare = calls.find((c) => c.path === '/sponsor-claim/prepare');
    const submit = calls.find((c) => c.path === '/sponsor-claim/submit');
    expect(prepare).toBeDefined();
    expect(submit).toBeDefined();
    // The destination and amount are threaded through both legs.
    expect((prepare!.body as { destination: string }).destination).toBe(DEST);
    expect((prepare!.body as { amount: string }).amount).toBe('100.0000000');
    expect((submit!.body as { destination: string }).destination).toBe(DEST);
    expect((submit!.body as { amount: string }).amount).toBe('100.0000000');
  });

  /**
   * Run a sponsored claim against a relayer that returns `preparedXdr`, and
   * assert the SDK throws SponsoredClaimMismatchError BEFORE any /submit call —
   * i.e. it refuses to sign a tampered relayer-prepared transaction.
   */
  async function expectSponsoredClaimRejects(
    fixture: ReturnType<typeof makeFixture>,
    preparedXdr: string,
  ): Promise<void> {
    const { keys, stealthAddress, ephemeralPubKeyHex } = fixture;
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      const path = url.replace('http://relayer', '');
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      if (path === '/sponsor-claim/prepare') {
        return { ok: true, status: 200, json: async () => ({ xdr: preparedXdr, expiresAt: 'later' }) };
      }
      if (path === '/sponsor-claim/submit') {
        return { ok: true, status: 200, json: async () => ({ txHash: 'SPONSORED_HASH' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const destTrusts = {
      id: DEST,
      sequence: '1',
      balances: [
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '0.0000000' },
      ],
    };
    const horizon = makeCapturingHorizon({
      accountsByAddress: { [DEST]: destTrusts },
      submitted: [],
    });
    const adapter = new AccountAdapter(NET, horizon, 'http://relayer');
    const payment: Payment = {
      stealthAddress,
      ephemeralPubKey: ephemeralPubKeyHex,
      token: ASSET,
      asset: ASSET,
      claimableBalanceId: CB_ID,
      amount: 100,
      method: 'account',
    };

    const err = await adapter
      .claim(payment, DEST, { keys, sponsored: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SponsoredClaimMismatchError);
    // The mismatch is detected BEFORE signing, so /submit is never reached.
    expect(calls.find((c) => c.path === '/sponsor-claim/submit')).toBeUndefined();
  }

  const baseArgs = (stealthAddress: string) => ({
    relayer: RELAYER,
    stealthAddress,
    asset: new Asset('USDC', ISSUER),
    balanceId: CB_ID,
    destination: DEST,
    amount: '100.0000000',
    withCreate: true,
  });

  it('rejects a tampered payout destination before signing', async () => {
    const fixture = makeFixture();
    const attacker = Keypair.random().publicKey();
    await expectSponsoredClaimRejects(
      fixture,
      buildSponsorClaimXdr({ ...baseArgs(fixture.stealthAddress), payoutDestination: attacker }),
    );
  });

  it('rejects a tampered payout amount before signing', async () => {
    const fixture = makeFixture();
    await expectSponsoredClaimRejects(
      fixture,
      buildSponsorClaimXdr({ ...baseArgs(fixture.stealthAddress), payoutAmount: '999.0000000' }),
    );
  });

  it('rejects an extra appended AccountMerge op before signing', async () => {
    const fixture = makeFixture();
    await expectSponsoredClaimRejects(
      fixture,
      buildSponsorClaimXdr({
        ...baseArgs(fixture.stealthAddress),
        extraOp: Operation.accountMerge({
          destination: Keypair.random().publicKey(),
          source: fixture.stealthAddress,
        }),
      }),
    );
  });

  it('rejects a payout op sourced by a non-stealth account before signing', async () => {
    const fixture = makeFixture();
    await expectSponsoredClaimRejects(
      fixture,
      buildSponsorClaimXdr({ ...baseArgs(fixture.stealthAddress), paymentSource: RELAYER }),
    );
  });

  it('rejects an unexpected memo before signing', async () => {
    const fixture = makeFixture();
    await expectSponsoredClaimRejects(
      fixture,
      buildSponsorClaimXdr({ ...baseArgs(fixture.stealthAddress), memo: Memo.text('gotcha') }),
    );
  });
});

describe('account send: amount validation', () => {
  it('sendToken throws InvalidAmountError for a zero amount before building', async () => {
    const { keys } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({ submitted });
    const adapter = new AccountAdapter(NET, horizon);

    const err = await adapter
      .send({
        metaAddress: keys.metaAddress,
        amount: 0,
        senderSecret: Keypair.random().secret(),
        asset: ASSET,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InvalidAmountError);
    expect(submitted).toHaveLength(0);
  });

  it('sendToken throws InvalidAmountError for a negative amount', async () => {
    const { keys } = makeFixture();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({ submitted });
    const adapter = new AccountAdapter(NET, horizon);

    const err = await adapter
      .send({
        metaAddress: keys.metaAddress,
        amount: -5,
        senderSecret: Keypair.random().secret(),
        asset: ASSET,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InvalidAmountError);
    expect(submitted).toHaveLength(0);
  });
});
