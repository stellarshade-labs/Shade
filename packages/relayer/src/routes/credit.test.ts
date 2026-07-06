import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { CreditLedger } from '../ledger.js';
import { initContext, resetContext } from '../context.js';
import { handleCreditClaim, handleCreditBalance } from './credit.js';

const FUNDING = Keypair.random().publicKey();

function mockRes(): Response & {
  statusCode: number;
  body: any;
} {
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

/** A mock Horizon server exposing just the builders credit.ts touches. */
function mockServer(opts: {
  tx?: any;
  txError?: any;
  ops?: any[];
}) {
  return {
    transactions: () => ({
      transaction: (_hash: string) => ({
        call: async () => {
          if (opts.txError) throw opts.txError;
          return opts.tx;
        },
      }),
    }),
    operations: () => ({
      forTransaction: (_hash: string) => ({
        call: async () => ({ records: opts.ops ?? [] }),
      }),
    }),
  } as any;
}

describe('credit routes', () => {
  let dir: string;
  let ledger: CreditLedger;
  let relayer: Keypair;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-'));
    ledger = new CreditLedger(path.join(dir, 'ledger.json'));
    relayer = Keypair.random();
  });

  afterEach(() => {
    resetContext();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function setup(serverOpts: Parameters<typeof mockServer>[0]) {
    initContext({
      keypair: relayer,
      network: 'local',
      server: mockServer(serverOpts),
      ledger,
    });
  }

  it('credits a valid native deposit to the relayer', async () => {
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX1' },
      ops: [
        {
          type: 'payment',
          asset_type: 'native',
          to: relayer.publicKey(),
          amount: '7.5000000',
        },
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX1' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.balance).toBe('7.5000000');
    expect(ledger.getBalance(FUNDING)).toBe('7.5000000');
  });

  it('rejects a duplicate claim with 409', async () => {
    ledger.credit(FUNDING, '1', 'TX1');
    setup({ tx: { successful: true, source_account: FUNDING, hash: 'TX1' } });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX1' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('tx_already_claimed');
  });

  it('returns 404 when the tx is unknown', async () => {
    setup({ txError: { response: { status: 404 } } });
    const req = { body: { fundingAccount: FUNDING, txHash: 'MISSING' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('tx_not_found');
  });

  it('returns 400 not_a_deposit when there is no native payment to the relayer', async () => {
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX2' },
      ops: [
        { type: 'payment', asset_type: 'native', to: 'GSOMEONE', amount: '1' },
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX2' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('not_a_deposit');
  });

  it('returns 400 not_a_deposit when source account mismatches', async () => {
    setup({
      tx: { successful: true, source_account: 'GOTHER', hash: 'TX3' },
      ops: [
        {
          type: 'payment',
          asset_type: 'native',
          to: relayer.publicKey(),
          amount: '1',
        },
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX3' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('not_a_deposit');
  });

  it('GET /credit/:account returns balance, 404 when unknown', async () => {
    ledger.credit(FUNDING, '3', 'TXA');
    setup({});
    const okReq = { params: { account: FUNDING } } as unknown as Request;
    const okRes = mockRes();
    handleCreditBalance(okReq, okRes);
    expect(okRes.statusCode).toBe(200);
    expect(okRes.body.balance).toBe('3.0000000');

    const missReq = { params: { account: 'GUNKNOWN' } } as unknown as Request;
    const missRes = mockRes();
    handleCreditBalance(missReq, missRes);
    expect(missRes.statusCode).toBe(404);
    expect(missRes.body.code).toBe('account_unknown');
  });
});
