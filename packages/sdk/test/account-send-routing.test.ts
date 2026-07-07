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
import type { StealthKeys, Payment } from '../src/types.js';

const NET = Networks.STANDALONE;
const ISSUER = Keypair.random().publicKey();
const ASSET = `USDC:${ISSUER}`;
const DEST = Keypair.random().publicKey();
const CB_ID =
  '00000000' +
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function makeKeys(): StealthKeys {
  const raw = generateMetaAddress();
  return {
    metaAddress: encodeMetaAddress(raw.metaAddress),
    spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
  };
}

function stealthFor(keys: StealthKeys): { stealthAddress: string; ephemeralPubKeyHex: string } {
  const eph = new Uint8Array(randomBytes(32));
  const s = deriveStealthAddressWithSecret(
    new Uint8Array(Buffer.from(keys.spendPubKey, 'hex')),
    new Uint8Array(Buffer.from(keys.viewPubKey, 'hex')),
    eph,
  );
  return { stealthAddress: s.stealthAddress, ephemeralPubKeyHex: Buffer.from(s.ephemeralPubKey).toString('hex') };
}

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

afterEach(() => vi.unstubAllGlobals());

describe('account send: asset routing', () => {
  it('routes a non-native asset to the token path (createClaimableBalance, not a native payment)', async () => {
    const keys = makeKeys();
    const senderSecret = Keypair.random().secret();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: {
        [Keypair.fromSecret(senderSecret).publicKey()]: {
          id: Keypair.fromSecret(senderSecret).publicKey(),
          sequence: '100',
          balances: [{ asset_type: 'native', balance: '1000.0000000' }],
        },
      },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    await adapter.send({
      metaAddress: keys.metaAddress,
      amount: 200,
      senderSecret,
      asset: ASSET,
    });

    expect(submitted).toHaveLength(1);
    const ops = new Transaction(submitted[0]!, NET).operations;
    const types = ops.map((o) => o.type);
    // Token path opens a stub account then locks the token in a claimable
    // balance — a plain native payment would be the fund-loss bug.
    expect(types).toContain('createClaimableBalance');
    expect(types).not.toContain('payment');
    const cb = ops.find((o) => o.type === 'createClaimableBalance') as {
      asset: Asset;
      amount: string;
    };
    expect(cb.asset.getCode()).toBe('USDC');
    expect(cb.amount).toBe('200.0000000');
  });

  it('routes native XLM to the account-creation path (no claimable balance)', async () => {
    const keys = makeKeys();
    const senderSecret = Keypair.random().secret();
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({
      accountsByAddress: {
        [Keypair.fromSecret(senderSecret).publicKey()]: {
          id: Keypair.fromSecret(senderSecret).publicKey(),
          sequence: '100',
          balances: [{ asset_type: 'native', balance: '1000.0000000' }],
        },
      },
      submitted,
    });
    const adapter = new AccountAdapter(NET, horizon);

    await adapter.send({
      metaAddress: keys.metaAddress,
      amount: 5,
      senderSecret,
    });

    expect(submitted).toHaveLength(1);
    const types = new Transaction(submitted[0]!, NET).operations.map((o) => o.type);
    expect(types).toContain('createAccount');
    expect(types).not.toContain('createClaimableBalance');
  });
});

describe('account claim: fundingAccount threading', () => {
  it('threads fundingAccount into the sponsor-claim submit body when supplied', async () => {
    const keys = makeKeys();
    const { stealthAddress, ephemeralPubKeyHex } = stealthFor(keys);

    // Honest relayer-sourced sponsor-claim sandwich; the SDK verifies it op-by-op
    // before co-signing and threading fundingAccount into /submit.
    const relayerPub = Keypair.random().publicKey();
    const usdc = new Asset('USDC', ISSUER);
    const prepared = new TransactionBuilder(new Account(relayerPub, '5'), {
      fee: '200',
      networkPassphrase: NET,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({ sponsoredId: stealthAddress }),
      )
      .addOperation(
        Operation.createAccount({ destination: stealthAddress, startingBalance: '0' }),
      )
      .addOperation(Operation.changeTrust({ asset: usdc, source: stealthAddress }))
      .addOperation(
        Operation.endSponsoringFutureReserves({ source: stealthAddress }),
      )
      .addOperation(
        Operation.claimClaimableBalance({ balanceId: CB_ID, source: stealthAddress }),
      )
      .addOperation(
        Operation.payment({
          destination: DEST,
          asset: usdc,
          amount: '100.0000000',
          source: stealthAddress,
        }),
      )
      .setTimeout(60)
      .build();
    const preparedXdr = prepared.toEnvelope().toXDR('base64');

    const calls: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
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
    const submitted: string[] = [];
    const horizon = makeCapturingHorizon({ accountsByAddress: { [DEST]: destTrusts }, submitted });
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

    const FUNDING = Keypair.random().publicKey();
    const receipt = await adapter.claim(payment, DEST, {
      keys,
      sponsored: true,
      fundingAccount: FUNDING,
    });
    expect(receipt.txHash).toBe('SPONSORED_HASH');

    const submit = calls.find((c) => c.path === '/sponsor-claim/submit');
    expect(submit).toBeDefined();
    expect(submit!.body?.fundingAccount).toBe(FUNDING);
  });
});
