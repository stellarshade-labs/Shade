import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { CreditLedger } from '../ledger.js';
import { initContext, resetContext } from '../context.js';
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

describe('sponsor route', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;
  const stealth = Keypair.random().publicKey();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sponsor-'));
    ledger = new CreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('creates a new stealth account (no sponsorship sandwich)', async () => {
    const { server, submitTransaction } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });

    const req = { body: { address: stealth, startingBalance: '2' } } as Request;
    const res = mockRes();
    await handleSponsor(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.stealthAddress).toBe(stealth);
    expect(res.body.txHash).toBe('SPONSOR_TX');

    // The submitted tx must NOT contain any sponsorship sandwich ops.
    const submittedTx = submitTransaction.mock.calls[0]![0] as any;
    const opTypes = submittedTx.operations.map((o: any) => o.type);
    expect(opTypes).toEqual(['createAccount']);
    expect(opTypes).not.toContain('beginSponsoringFutureReserves');
    expect(opTypes).not.toContain('endSponsoringFutureReserves');
  });

  it('rejects an invalid address', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({ keypair: relayer, network: 'local', server, ledger });
    const req = { body: { address: 'not-an-address' } } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('invalid_address');
  });

  it('returns 409 when the account already exists', async () => {
    const { server } = mockServer(relayer.publicKey(), [stealth]);
    initContext({ keypair: relayer, network: 'local', server, ledger });
    const req = { body: { address: stealth } } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('account_exists');
  });

  it('enforces SPONSOR_MAX_XLM', async () => {
    const { server } = mockServer(relayer.publicKey());
    initContext({
      keypair: relayer,
      network: 'local',
      server,
      ledger,
      sponsorMaxXlm: 5,
    });
    const req = { body: { address: stealth, startingBalance: '10' } } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('requires + debits credit when credit-gated', async () => {
    const funding = Keypair.random().publicKey();
    ledger.credit(funding, '3', 'DEP1');
    const { server } = mockServer(relayer.publicKey());
    initContext({
      keypair: relayer,
      network: 'local',
      server,
      ledger,
      requireCredit: true,
    });

    const req = {
      body: { address: stealth, startingBalance: '2', fundingAccount: funding },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(200);
    // Debits startingBalance (2) PLUS the tx fee (100 stroops = 0.00001 XLM):
    // 3 - 2 - 0.00001 = 0.99999.
    expect(ledger.getBalance(funding)).toBe('0.9999900');
  });

  it('returns 402 when credit is insufficient', async () => {
    const funding = Keypair.random().publicKey();
    ledger.credit(funding, '1', 'DEP1');
    const { server } = mockServer(relayer.publicKey());
    initContext({
      keypair: relayer,
      network: 'local',
      server,
      ledger,
      requireCredit: true,
    });
    const req = {
      body: { address: stealth, startingBalance: '2', fundingAccount: funding },
    } as Request;
    const res = mockRes();
    await handleSponsor(req, res);
    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe('insufficient_credit');
  });
});
