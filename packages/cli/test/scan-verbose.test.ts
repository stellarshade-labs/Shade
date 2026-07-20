import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateMetaAddress, encodeMetaAddress } from '@shade/crypto';
import type { StealthKeys } from 'stellar-shade';
import { scanAccountMethod } from '../src/commands/scan.js';

// In-memory replacement for ~/.stealth cursor/payment persistence, so the
// test never touches the real home directory (mirrors balance-cursor.test.ts).
vi.mock('../src/utils/config.js', () => ({
  getContractAddress: () => 'CCONTRACT_UNUSED_IN_THIS_TEST',
  saveContractAddress: () => {},
  loadHorizonCursor: () => undefined,
  saveHorizonCursor: () => {},
  clearHorizonCursor: () => {},
  loadHorizonPayments: () => [],
  saveHorizonPayments: () => {},
  clearHorizonPayments: () => {},
  findHorizonPayment: () => undefined,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shade scan --verbose account diagnostics', () => {
  it('an indexer-less scan reports its single unbounded segment (full via horizon)', async () => {
    const raw = generateMetaAddress();
    const keys: StealthKeys = {
      metaAddress: encodeMetaAddress(raw.metaAddress),
      spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
    };

    // One empty Horizon transactions page: the walk ends immediately with
    // zero candidates, but the segment line must still be reported. Stubbed
    // BEFORE the scan because HorizonClient captures fetch at construction.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { records: [] } }),
    }));

    const lines: string[] = [];
    await scanAccountMethod('testnet', keys, false, undefined, (msg) =>
      lines.push(msg),
    );

    expect(lines).toContain(
      '  account: segment full via horizon: 0 candidate(s), 0 match(es)',
    );
    // No indexer configured: neither the configured notice, a skip notice,
    // nor a lag notice may appear.
    expect(lines.join('\n')).not.toMatch(/indexer/);
  });

  const INDEXER = 'http://idx.test';

  function testKeys(): StealthKeys {
    const raw = generateMetaAddress();
    return {
      metaAddress: encodeMetaAddress(raw.metaAddress),
      spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
      spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
      viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
      viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
    };
  }

  function healthBody(over: Record<string, unknown> = {}): unknown {
    return {
      status: 'ok',
      network: 'testnet',
      store: 'memory',
      cursor: '300',
      startCursor: '100',
      lastCloseTime: '2026-07-17T00:00:00Z',
      lagSeconds: 2,
      announcements: 0,
      gaps: [],
      ingest: {},
      ...over,
    };
  }

  /**
   * Global-fetch stub routing the indexer host and Horizon. `health` is
   * consulted per call (so a test can flip the answer between the guard and
   * the post-segment re-check); Horizon serves empty asc pages and an
   * optional desc head token.
   */
  function stubFetch(opts: {
    health: (call: number) => unknown | 'reject';
    announcements?: (call: number) => { records: unknown[]; cursor: string } | 'reject';
    horizonHeadToken?: string;
  }): void {
    let healthCalls = 0;
    let annCalls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.startsWith(INDEXER)) {
        if (url.includes('/health')) {
          healthCalls++;
          const body = opts.health(healthCalls);
          if (body === 'reject') throw new Error('ENOTFOUND idx.test');
          return { ok: true, status: 200, json: async () => body };
        }
        if (url.includes('/announcements')) {
          annCalls++;
          const body = opts.announcements?.(annCalls) ?? { records: [], cursor: '300' };
          if (body === 'reject') throw new Error('socket hang up');
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.includes('order=desc')) {
        const records = opts.horizonHeadToken
          ? [{ paging_token: opts.horizonHeadToken, hash: 'HEAD', memo_type: 'none', successful: true }]
          : [];
        return { ok: true, status: 200, json: async () => ({ _embedded: { records } }) };
      }
      return { ok: true, status: 200, json: async () => ({ _embedded: { records: [] } }) };
    });
  }

  it('reports the skip reason when the health guard rejects, and the unknown fallback when the first page faults', async () => {
    // Guard rejection: /health says degraded.
    stubFetch({ health: () => healthBody({ status: 'degraded' }) });
    const rejected: string[] = [];
    await scanAccountMethod('testnet', testKeys(), false, INDEXER, (m) =>
      rejected.push(m),
    );
    expect(rejected).toContain(`  account: indexer configured: ${INDEXER}`);
    expect(rejected).toContain(
      '  account: indexer skipped (unhealthy) — using the pure Horizon walk',
    );

    // Guard passed but the FIRST /announcements call faulted: no skip reason
    // exists, the notice must fall back to 'unknown'.
    stubFetch({ health: () => healthBody(), announcements: () => 'reject' });
    const faulted: string[] = [];
    await scanAccountMethod('testnet', testKeys(), false, INDEXER, (m) =>
      faulted.push(m),
    );
    expect(faulted).toContain(
      '  account: indexer skipped (unknown) — using the pure Horizon walk',
    );
  });

  it('notices an indexer lagging more than a minute behind', async () => {
    stubFetch({ health: () => healthBody({ lagSeconds: 120 }) });
    const lines: string[] = [];
    await scanAccountMethod('testnet', testKeys(), false, INDEXER, (m) =>
      lines.push(m),
    );
    expect(lines).toContain(
      '  account: indexer is 120s behind the network head — the Horizon tail covers the difference',
    );
  });

  it('notices a post-segment health flip: the segment was discarded and Horizon re-walked', async () => {
    stubFetch({
      health: (call) =>
        call === 1 ? healthBody() : healthBody({ status: 'degraded' }),
    });
    const lines: string[] = [];
    await scanAccountMethod('testnet', testKeys(), false, INDEXER, (m) =>
      lines.push(m),
    );
    expect(lines).toContain(
      '  account: indexer turned unhealthy during the scan — its segment was discarded and Horizon re-walked the span',
    );
  });

  it('notices when an indexer-reported position was clamped to the Horizon head', async () => {
    stubFetch({
      health: () => healthBody({ cursor: '9000000000000000000' }),
      announcements: () => ({ records: [], cursor: '9000000000000000000' }),
      horizonHeadToken: '200',
    });
    const lines: string[] = [];
    await scanAccountMethod('testnet', testKeys(), false, INDEXER, (m) =>
      lines.push(m),
    );
    expect(lines).toContain(
      "  account: indexer-reported position exceeded the chain head — cursor clamped to Horizon's head",
    );
  });
});
