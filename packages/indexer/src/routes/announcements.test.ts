import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createAnnouncementsHandler,
  createHealthHandler,
} from './announcements.js';
import { MemoryAnnouncementStore } from '../store/memory.js';
import RateLimiter from '../utils/rateLimit.js';
import type { AnnouncementRecord } from '../store/types.js';
import type { IngesterStatus } from '../ingest.js';

const MEMO = Buffer.alloc(32, 9).toString('base64');

function record(token: string): AnnouncementRecord {
  return {
    pagingToken: token,
    hash: `hash-${token}`,
    memo: MEMO,
    closeTime: '2026-07-17T00:00:00.000Z',
    operations: [{ id: `op-${token}`, type: 'payment', to: 'GDEST' }],
  };
}

const idleStatus: IngesterStatus = {
  lastPollAt: null,
  lastError: null,
  caughtUp: false,
  resetSuspected: false,
  lastContinuityOkAt: null,
  continuityStale: false,
  stalled: false,
};

function makeApp(store: MemoryAnnouncementStore, status: IngesterStatus = idleStatus) {
  const app = express();
  app.get(
    '/health',
    createHealthHandler({
      network: 'testnet',
      storeKind: 'memory',
      store,
      ingestStatus: () => status,
    }),
  );
  app.get('/announcements', createAnnouncementsHandler(store));
  return app;
}

describe('GET /health', () => {
  it('reports the full shape on a fresh store', async () => {
    const res = await request(makeApp(new MemoryAnnouncementStore())).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      network: 'testnet',
      store: 'memory',
      cursor: null,
      startCursor: null,
      lastCloseTime: null,
      lagSeconds: null,
      announcements: 0,
      gaps: [],
      ingest: {
        lastPollAt: null,
        lastError: null,
        resetSuspected: false,
        lastContinuityOkAt: null,
        continuityStale: false,
        stalled: false,
      },
    });
  });

  it('surfaces ingest progress, counts, and lag', async () => {
    const store = new MemoryAnnouncementStore();
    await store.setStartCursor('1');
    const lastCloseTime = new Date(Date.now() - 5000).toISOString();
    await store.insertBatch([record('1'), record('2')], '2', lastCloseTime);

    const status: IngesterStatus = {
      lastPollAt: '2026-07-17T12:00:00.000Z',
      lastError: 'horizon 429',
      caughtUp: true,
      resetSuspected: false,
      lastContinuityOkAt: '2026-07-17T12:00:00.000Z',
      continuityStale: false,
      stalled: false,
    };
    const res = await request(makeApp(store, status)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.cursor).toBe('2');
    expect(res.body.startCursor).toBe('1');
    expect(res.body.lastCloseTime).toBe(lastCloseTime);
    expect(res.body.announcements).toBe(2);
    // ~5s behind; generous upper bound for a slow CI box.
    expect(res.body.lagSeconds).toBeGreaterThanOrEqual(4);
    expect(res.body.lagSeconds).toBeLessThanOrEqual(60);
    expect(res.body.ingest).toEqual({
      lastPollAt: '2026-07-17T12:00:00.000Z',
      lastError: 'horizon 429',
      resetSuspected: false,
      lastContinuityOkAt: '2026-07-17T12:00:00.000Z',
      continuityStale: false,
      stalled: false,
    });
  });

  it("degrades (never lies 'ok') when the store has a recorded gap", async () => {
    const store = new MemoryAnnouncementStore();
    await store.recordGap(11, 99, '2026-07-17T01:00:00.000Z');
    const res = await request(makeApp(store)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.gaps).toEqual([
      { fromLedger: 11, toLedger: 99, detectedAt: '2026-07-17T01:00:00.000Z' },
    ]);
  });

  it('degrades when a testnet reset is suspected', async () => {
    const status: IngesterStatus = { ...idleStatus, resetSuspected: true };
    const res = await request(makeApp(new MemoryAnnouncementStore(), status)).get(
      '/health',
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.gaps).toEqual([]);
    expect(res.body.ingest.resetSuspected).toBe(true);
  });

  it('degrades when the continuity check is not succeeding — gap/reset detection is effectively off', async () => {
    const status: IngesterStatus = { ...idleStatus, continuityStale: true };
    const res = await request(makeApp(new MemoryAnnouncementStore(), status)).get(
      '/health',
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ingest.continuityStale).toBe(true);
  });

  it("degrades when ingest is stalled — a frozen indexer must not report 'ok' forever", async () => {
    const status: IngesterStatus = { ...idleStatus, stalled: true };
    const res = await request(makeApp(new MemoryAnnouncementStore(), status)).get(
      '/health',
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ingest.stalled).toBe(true);
  });
});

describe('GET /announcements', () => {
  it("returns an empty feed with cursor '0' before any ingest", async () => {
    const res = await request(makeApp(new MemoryAnnouncementStore())).get(
      '/announcements',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], cursor: '0' });
  });

  it('serves Horizon-shaped records with operations verbatim', async () => {
    const store = new MemoryAnnouncementStore();
    await store.insertBatch([record('7')], '7', '2026-07-17T00:00:00.000Z');
    const res = await request(makeApp(store)).get('/announcements');
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([
      {
        hash: 'hash-7',
        paging_token: '7',
        memo: MEMO,
        memo_type: 'hash',
        successful: true,
        created_at: '2026-07-17T00:00:00.000Z',
        operations: [{ id: 'op-7', type: 'payment', to: 'GDEST' }],
      },
    ]);
    expect(res.body.cursor).toBe('7');
  });

  it('serves source_account when stored and omits it on pre-field rows', async () => {
    const store = new MemoryAnnouncementStore();
    await store.insertBatch(
      [record('1'), { ...record('2'), sourceAccount: 'GPAYERSOURCEACCOUNT' }],
      '2',
      '2026-07-17T00:00:00.000Z',
    );
    const res = await request(makeApp(store)).get('/announcements');
    expect(res.status).toBe(200);
    // res.json drops the undefined field → the old row matches the Horizon
    // record shape with source_account simply absent.
    expect(res.body.records[0]).not.toHaveProperty('source_account');
    expect(res.body.records[1].source_account).toBe('GPAYERSOURCEACCOUNT');
  });

  it('a composed route answers 429 + Retry-After once the limiter is exhausted', async () => {
    const app = express();
    const limiter = new RateLimiter(2, 2, 60_000);
    app.get(
      '/announcements',
      limiter.middleware(),
      createAnnouncementsHandler(new MemoryAnnouncementStore()),
    );

    await request(app).get('/announcements').expect(200);
    await request(app).get('/announcements').expect(200);

    const res = await request(app).get('/announcements');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toEqual({ error: 'Rate limit exceeded', retryAfter: 60 });
  });

  it("a FULL page returns the last row's paging_token as the cursor", async () => {
    const store = new MemoryAnnouncementStore();
    await store.insertBatch(
      [record('1'), record('2'), record('3')],
      '900',
      '2026-07-17T00:00:00.000Z',
    );
    const res = await request(makeApp(store)).get('/announcements?limit=2');
    expect(res.body.records.map((r: { paging_token: string }) => r.paging_token)).toEqual(['1', '2']);
    expect(res.body.cursor).toBe('2');
  });

  it("a drained page jumps the cursor to the indexer's ingest position", async () => {
    const store = new MemoryAnnouncementStore();
    await store.insertBatch(
      [record('1'), record('2'), record('3')],
      '900',
      '2026-07-17T00:00:00.000Z',
    );
    const res = await request(makeApp(store)).get('/announcements?cursor=2&limit=2');
    expect(res.body.records.map((r: { paging_token: string }) => r.paging_token)).toEqual(['3']);
    // Short page → max(request cursor '2', ingest cursor '900') = '900'.
    expect(res.body.cursor).toBe('900');
  });

  it('a request cursor past the ingest position is preserved (numeric max)', async () => {
    const store = new MemoryAnnouncementStore();
    await store.insertBatch([], '900', null);
    const res = await request(makeApp(store)).get('/announcements?cursor=1000');
    expect(res.body).toEqual({ records: [], cursor: '1000' });
  });

  it('rejects a non-decimal cursor with 400 invalid_cursor', async () => {
    const app = makeApp(new MemoryAnnouncementStore());
    for (const bad of ['abc', '12x', '-1', '1.5']) {
      const res = await request(app).get('/announcements').query({ cursor: bad });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.any(String),
        code: 'invalid_cursor',
      });
    }
    // A repeated cursor param is not a string → same rejection.
    const res = await request(app).get('/announcements?cursor=1&cursor=2');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_cursor');
  });

  it('clamps limit to [1,200] and defaults to 100', async () => {
    const store = new MemoryAnnouncementStore();
    const batch = Array.from({ length: 250 }, (_, i) => record(String(i + 1)));
    await store.insertBatch(batch, '250', '2026-07-17T00:00:00.000Z');
    const app = makeApp(store);

    const over = await request(app).get('/announcements?limit=500');
    expect(over.body.records).toHaveLength(200);
    expect(over.body.cursor).toBe('200');

    const zero = await request(app).get('/announcements?limit=0');
    expect(zero.body.records).toHaveLength(1);

    const negative = await request(app).get('/announcements?limit=-5');
    expect(negative.body.records).toHaveLength(1);

    const garbage = await request(app).get('/announcements?limit=abc');
    expect(garbage.body.records).toHaveLength(100);

    const unset = await request(app).get('/announcements');
    expect(unset.body.records).toHaveLength(100);
    expect(unset.body.cursor).toBe('100');
  });
});
