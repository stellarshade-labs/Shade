import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import type { CreditLedger } from '../ledger.js';
import { JsonCreditLedger } from '../ledger.js';
import { initContext, resetContext, getContext } from '../context.js';
import { challengeMessage } from '../utils/auth.js';
import { handleSponsor } from './sponsor.js';

function mockRes(): Response & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/**
 * Mock server: `loadAccount` returns a relayer account for the relayer key and
 * throws 404 for the (not-yet-created) stealth address unless `existing` lists
 * it; `submitTransaction` returns a fixed hash.
 */
function mockServer(relayerKey: string, existing: string[] = []) {
  const submitTransaction = vi.fn(async () => ({ hash: 'SPONSOR_TX' }));
  const loadAccount = vi.fn(async (addr: string) => {
    if (addr === relayerKey || existing.includes(addr)) {
      return {
        accountId: () => addr,
        sequenceNumber: () => '1',
        balances: [{ asset_type: 'native', balance: '10000' }],
      };
    }
    const err: any = new Error('not found');
    err.response = { status: 404 };
    throw err;
  });
  return { server: { loadAccount, submitTransaction } as any, submitTransaction };
}

/** Issue a challenge for `funder` and sign the canonical `sponsor` message. */
async function signedAuth(funder: Keypair, totalXlm: string) {
  const nonce = await getContext().challenges.issue(funder.publicKey());
  const message = challengeMessage(
    'sponsor',
    funder.publicKey(),
    nonce,
    totalXlm,
  );
  const signature = funder
    .sign(Buffer.from(message, 'utf8'))
    .toString('base64');
  return { fundingAccount: funder.publicKey(), nonce, signature };
}

describe('sponsor route', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  const stealth = Keypair.random().publicKey();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsor-'));
    ledger = new JsonCreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects an unauthenticated request with 401 (no faucet)', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const req = { body: { address: stealth, startingBalance: '2' } } as Request;
    const res = mockRes();
    await handleSponsor(req, res);

    // No fundingAccount => 401, and no tx is submitted (fail-closed).
    expect(res.statusCode).toBe(401);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects a request whose signature is missing (401) even with a funder', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const req = {
      body: {
        address: stealth,
        startingBalance: '2',
        fundingAccount: funder.publicKey(),
      },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(401);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid address', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });
    const req = { body: { address: 'not-an-address' } } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('invalid_address');
  });

  it('rejects a startingBalance above the (lowered) cap with 400', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '100', 'DEP1');
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({
      keypair: relayer,
      network: 'testnet',
      server,
      ledger,
      sponsorMaxXlm: 5,
    });

    // 10 > cap of 5 — rejected before any auth/debit.
    const req = {
      body: {
        address: stealth,
        startingBalance: '10',
        fundingAccount: funder.publicKey(),
      },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('balance_exceeds_max');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('defaults the cap to 5 (a small bootstrap ceiling, not a faucet)', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '2000', 'DEP1');
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // The old faucet allowed up to 1000; the new default cap is 5.
    const req = {
      body: {
        address: stealth,
        startingBalance: '1000',
        fundingAccount: funder.publicKey(),
      },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('balance_exceeds_max');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('returns 409 when the account already exists', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server } = mockServer(relayer.publicKey(), [stealth]);
    initContext({ keypair: relayer, network: 'testnet', server, ledger });
    const req = {
      body: { address: stealth, fundingAccount: funder.publicKey() },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('account_exists');
  });

  it('accepts a valid authenticated+funded request and debits startingBalance + fee', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '3', 'DEP1');
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // fee = 100 stroops = 0.00001; total authorized = 2 + 0.00001.
    const auth = await signedAuth(funder,'2.0000100');
    const req = {
      body: { address: stealth, startingBalance: '2', ...auth },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.stealthAddress).toBe(stealth);
    expect(res.body.txHash).toBe('SPONSOR_TX');

    // Only a plain createAccount — no sponsorship sandwich.
    const submittedTx = submitTransaction.mock.calls[0]![0] as any;
    const opTypes = submittedTx.operations.map((o: any) => o.type);
    expect(opTypes).toEqual(['createAccount']);

    // 3 - 2 - 0.00001 = 0.99999.
    expect(await ledger.getBalance(funder.publicKey())).toBe('0.9999900');
  });

  it('returns 402 when the funder credit is insufficient', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '1', 'DEP1');
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const auth = await signedAuth(funder,'2.0000100');
    const req = {
      body: { address: stealth, startingBalance: '2', ...auth },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe('insufficient_credit');
  });

  it('rejects a signature bound to a different amount (401)', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    // Sign for a smaller amount than the route will actually authorize.
    const auth = await signedAuth(funder,'1.0000000');
    const req = {
      body: { address: stealth, startingBalance: '2', ...auth },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(401);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects a reused nonce (401 on replay)', async () => {
    const funder = Keypair.random();
    await ledger.credit(funder.publicKey(), '10', 'DEP1');
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'testnet', server, ledger });

    const auth = await signedAuth(funder,'2.0000100');
    const first = {
      body: { address: stealth, startingBalance: '2', ...auth },
    } as Request;
    const firstRes = mockRes();
    await handleSponsor(first, firstRes);
    expect(firstRes.statusCode).toBe(200);

    // Replaying the same nonce for a second (fresh) account must fail.
    const other = Keypair.random().publicKey();
    const second = {
      body: { address: other, startingBalance: '2', ...auth },
    } as Request;
    const secondRes = mockRes();
    await handleSponsor(second, secondRes);
    expect(secondRes.statusCode).toBe(401);
  });
});
