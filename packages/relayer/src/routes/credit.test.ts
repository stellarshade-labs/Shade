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
  /** Multi-page operations fixture: each entry is one Horizon page of records. */
  opsPages?: any[][];
}) {
  const pages: any[][] = opts.opsPages ?? [opts.ops ?? []];
  // Mirrors Horizon's CollectionPage: `records` plus a `next()` that resolves
  // the following page (empty records past the end, like the real SDK).
  const makePage = (i: number): any => ({
    records: pages[i] ?? [],
    next: async () => makePage(i + 1),
  });
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
      forTransaction: (_hash: string) => {
        const builder: any = {
          limit: (_n: number) => builder,
          call: async () => makePage(0),
        };
        return builder;
      },
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

  it('does not credit a payment op sourced by a different account', async () => {
    // tx source is FUNDING, but the native payment op is sourced (from) by a
    // different account — it must NOT be attributed to FUNDING.
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX_DIFFSRC' },
      ops: [
        {
          type: 'payment',
          asset_type: 'native',
          from: 'GOTHERSOURCEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          to: relayer.publicKey(),
          amount: '5',
        },
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX_DIFFSRC' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('not_a_deposit');
    expect(ledger.getBalance(FUNDING)).toBeNull();
  });

  it('sums multiple native payments from the funding account', async () => {
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX_MULTI' },
      ops: [
        {
          type: 'payment',
          asset_type: 'native',
          to: relayer.publicKey(),
          amount: '2.5',
        },
        {
          type: 'payment',
          asset_type: 'native',
          from: FUNDING,
          to: relayer.publicKey(),
          amount: '1.5',
        },
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX_MULTI' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.balance).toBe('4.0000000');
  });

  it('credits a payment op that sits beyond the first operations page', async () => {
    // Page 1 is completely full (200 records) of non-payment ops, so the
    // handler must follow next() to find the deposit on page 2. The old
    // single-page read would have returned not_a_deposit here.
    const fillers = Array.from({ length: 200 }, () => ({ type: 'manage_data' }));
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX_PAGE2' },
      opsPages: [
        fillers,
        [
          {
            type: 'payment',
            asset_type: 'native',
            to: relayer.publicKey(),
            amount: '5.0000000',
          },
        ],
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX_PAGE2' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.balance).toBe('5.0000000');
    expect(ledger.getBalance(FUNDING)).toBe('5.0000000');
  });

  it('sums qualifying payments spread across multiple operations pages', async () => {
    // 199 fillers + a 2 XLM payment fill page 1 exactly; a further 3 XLM
    // payment lands on page 2. Both must be accumulated.
    const fillers = Array.from({ length: 199 }, () => ({ type: 'manage_data' }));
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX_SPREAD' },
      opsPages: [
        [
          ...fillers,
          {
            type: 'payment',
            asset_type: 'native',
            to: relayer.publicKey(),
            amount: '2',
          },
        ],
        [
          {
            type: 'payment',
            asset_type: 'native',
            from: FUNDING,
            to: relayer.publicKey(),
            amount: '3',
          },
        ],
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX_SPREAD' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.balance).toBe('5.0000000');
  });

  it('stops paginating on an empty trailing page (bounded loop)', async () => {
    // A full page followed by an explicit empty page: the loop must terminate
    // and still credit the qualifying op from page 1.
    const fillers = Array.from({ length: 199 }, () => ({ type: 'manage_data' }));
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX_EMPTYNEXT' },
      opsPages: [
        [
          ...fillers,
          {
            type: 'payment',
            asset_type: 'native',
            to: relayer.publicKey(),
            amount: '1',
          },
        ],
        [],
      ],
    });
    const req = { body: { fundingAccount: FUNDING, txHash: 'TX_EMPTYNEXT' } } as Request;
    const res = mockRes();
    await handleCreditClaim(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.balance).toBe('1.0000000');
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

  it('concurrent duplicate claims credit exactly once and the loser gets 409 (no hang)', async () => {
    // Both requests start before either has written consumedTxs, so both pass the
    // early hasConsumed() gate and reach ledger.credit(); the loser must throw
    // tx_already_claimed and be translated to a 409 rather than an uncaught
    // rejection that hangs the socket.
    setup({
      tx: { successful: true, source_account: FUNDING, hash: 'TX_RACE' },
      ops: [
        {
          type: 'payment',
          asset_type: 'native',
          to: relayer.publicKey(),
          amount: '3.0000000',
        },
      ],
    });

    const mkReq = () =>
      ({ body: { fundingAccount: FUNDING, txHash: 'TX_RACE' } } as Request);
    const resA = mockRes();
    const resB = mockRes();

    await Promise.all([
      handleCreditClaim(mkReq(), resA),
      handleCreditClaim(mkReq(), resB),
    ]);

    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = resA.statusCode === 409 ? resA : resB;
    expect(loser.body.code).toBe('tx_already_claimed');
    // Credited exactly once — not doubled.
    expect(ledger.getBalance(FUNDING)).toBe('3.0000000');
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
