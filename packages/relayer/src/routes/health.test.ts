import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHealthHandler } from './health.js';
import { SPONSORED_RESERVE_ESTIMATE } from './sponsorClaim.js';

function mockServer(balances: Array<{ asset_type: string; balance: string }>) {
  return {
    loadAccount: vi.fn(async () => ({ balances })),
  } as any;
}

function appWith(handler: ReturnType<typeof createHealthHandler>) {
  const app = express();
  app.get('/health', handler);
  return app;
}

describe('GET /health', () => {
  let keypair: Keypair;
  let savedFeeCap: string | undefined;

  beforeEach(() => {
    keypair = Keypair.random();
    // Pin the fee-cap default so the assertion below is environment-independent.
    savedFeeCap = process.env.MAX_RELAY_FEE_XLM;
    delete process.env.MAX_RELAY_FEE_XLM;
  });

  afterEach(() => {
    if (savedFeeCap === undefined) delete process.env.MAX_RELAY_FEE_XLM;
    else process.env.MAX_RELAY_FEE_XLM = savedFeeCap;
    vi.clearAllMocks();
  });

  it('reports the full advertised shape, including the sponsored-reserve estimate', async () => {
    const server = mockServer([
      { asset_type: 'credit_alphanum4', balance: '5.0000000' },
      { asset_type: 'native', balance: '123.4567890' },
    ]);
    const app = appWith(
      createHealthHandler({
        server,
        keypair,
        network: 'testnet',
        requireCredit: true,
        store: 'json',
        sharedState: 'memory',
      }),
    );

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      network: 'testnet',
      relayerAddress: keypair.publicKey(),
      balance: '123.4567890',
      requireCredit: true,
      maxRelayFeeXlm: 0.1,
      sponsoredReserveEstimate: '1.0000000',
      store: 'json',
      sharedState: 'memory',
    });
  });

  it('advertises the same estimate sponsor-claim holds against credit', async () => {
    const app = appWith(
      createHealthHandler({
        server: mockServer([{ asset_type: 'native', balance: '50.0000000' }]),
        keypair,
        network: 'testnet',
        requireCredit: false,
        store: 'postgres',
        sharedState: 'redis',
      }),
    );

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.sponsoredReserveEstimate).toBe('1.0000000');
    expect(res.body.sponsoredReserveEstimate).toBe(SPONSORED_RESERVE_ESTIMATE);
  });

  it('reports balance "0" when the relayer account is unfunded (Horizon 404)', async () => {
    const server = {
      loadAccount: vi.fn(async () => {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }),
    } as any;
    const app = appWith(
      createHealthHandler({
        server,
        keypair,
        network: 'testnet',
        requireCredit: true,
        store: 'json',
        sharedState: 'memory',
      }),
    );

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.balance).toBe('0');
    expect(res.body.sponsoredReserveEstimate).toBe('1.0000000');
  });
});
