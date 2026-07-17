import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from '@noble/hashes/utils';
import {
  generateMetaAddress,
  encodeMetaAddress,
  deriveStealthAddressWithSecret,
} from '@shade/crypto';
import {
  Networks,
  Keypair,
  Account,
  Address,
  Asset,
  StrKey,
  Transaction,
  SorobanDataBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { PoolAdapter } from '../src/methods/pool.js';
import { challengeMessage } from '../src/relayer.js';
import type { StealthKeys, Payment } from '../src/types.js';

const NET = Networks.TESTNET;
const DEST = Keypair.random().publicKey();
const BALANCE_STROOPS = 50_000_000n; // 5 XLM in the pool

function makeContractId(): string {
  const kp = Keypair.random();
  return StrKey.encodeContract(Buffer.from(hash(Buffer.from(kp.rawPublicKey()))));
}

/** Real stealth keys + a genuine pool announcement derived from them. */
function makeFixture(): {
  keys: StealthKeys;
  stealth: ReturnType<typeof deriveStealthAddressWithSecret>;
} {
  const raw = generateMetaAddress();
  const keys: StealthKeys = {
    metaAddress: encodeMetaAddress(raw.metaAddress),
    spendPubKey: Buffer.from(raw.metaAddress.spendPubKey).toString('hex'),
    spendPrivKey: Buffer.from(raw.spendPrivKey).toString('hex'),
    viewPubKey: Buffer.from(raw.metaAddress.viewPubKey).toString('hex'),
    viewPrivKey: Buffer.from(raw.viewPrivKey).toString('hex'),
  };
  const stealth = deriveStealthAddressWithSecret(
    raw.metaAddress.spendPubKey,
    raw.metaAddress.viewPubKey,
    new Uint8Array(randomBytes(32)),
  );
  return { keys, stealth };
}

/** The contract method a simulation tx invokes (all pool reads/writes). */
function invokedFn(tx: Transaction): string {
  const op = tx.operations[0] as unknown as {
    func?: { invokeContract(): { functionName(): { toString(): string } } };
  };
  return op.func ? op.func.invokeContract().functionName().toString() : 'unknown';
}

/**
 * A stub `rpc.Server` serving REAL ScVal fixtures for the pool read path
 * (count / announcements / balance / nonce), a SUCCESS simulation for the
 * withdraw itself (so the real `assembleTransaction` runs), and a recording
 * `sendTransaction` for the direct submission branch.
 */
function makeServer(opts: {
  stealth: { stealthPubKey: Uint8Array; ephemeralPubKey: Uint8Array; viewTag: number };
  tokenAddress: string;
  directSends: string[];
  /** When set, records every getTransaction(hash) poll (confirm path). */
  getTxCalls?: string[];
}): rpc.Server {
  const announcement = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: nativeToScVal(BALANCE_STROOPS, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('ephemeral_pk'),
      val: xdr.ScVal.scvBytes(Buffer.from(opts.stealth.ephemeralPubKey)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('stealth_pk'),
      val: xdr.ScVal.scvBytes(Buffer.from(opts.stealth.stealthPubKey)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('token'),
      val: new Address(opts.tokenAddress).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('view_tag'),
      val: nativeToScVal(opts.stealth.viewTag, { type: 'u32' }),
    }),
  ]);

  const simSuccess = (retval: xdr.ScVal) => ({
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '100',
    result: { retval, auth: [] },
    events: [],
    latestLedger: 1,
  });

  return {
    async getAccount(address: string): Promise<Account> {
      return new Account(address, '100');
    },
    async simulateTransaction(tx: Transaction): Promise<unknown> {
      switch (invokedFn(tx)) {
        case 'get_announcement_count':
          return simSuccess(nativeToScVal(1, { type: 'u64' }));
        case 'get_announcements':
          return simSuccess(xdr.ScVal.scvVec([announcement]));
        case 'get_balance':
          return simSuccess(nativeToScVal(BALANCE_STROOPS, { type: 'i128' }));
        case 'get_nonce':
          return simSuccess(nativeToScVal(0, { type: 'u64' }));
        case 'withdraw':
          return simSuccess(xdr.ScVal.scvVoid());
        default:
          throw new Error(`unexpected simulate: ${invokedFn(tx)}`);
      }
    },
    async sendTransaction(tx: Transaction): Promise<{ status: string; hash: string }> {
      opts.directSends.push(tx.toEnvelope().toXDR('base64'));
      return { status: 'SUCCESS', hash: 'DIRECT_HASH' };
    },
    async getTransaction(hash: string): Promise<{ status: string }> {
      opts.getTxCalls?.push(hash);
      return { status: 'SUCCESS' };
    },
  } as unknown as rpc.Server;
}

/** Stub the global fetch (used by RelayerClient) and record every call. */
function stubRelayerFetch(): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      calls.push({ url, body });
      if (url.endsWith('/relay')) {
        return { ok: true, status: 200, json: async () => ({ txHash: 'RELAYED_HASH' }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    },
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('pool relayed withdraw goes through RelayerClient (SDK-POOLRELAY-AUTH)', () => {
  it('claim() posts the signed XDR to <relay>/relay with fundingAccount threaded', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends });
    const adapter = new PoolAdapter(makeContractId(), NET, server);
    const relayCalls = stubRelayerFetch();

    const payment: Payment = {
      stealthAddress: stealth.stealthAddress,
      ephemeralPubKey: Buffer.from(stealth.ephemeralPubKey).toString('hex'),
      token: tokenAddress,
      amount: 5,
      amountStroops: BALANCE_STROOPS.toString(),
      method: 'pool',
    };
    const FUNDING = Keypair.random().publicKey();

    const receipt = await adapter.claim(payment, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
      relay: 'http://relayer.test',
      fundingAccount: FUNDING,
    });

    expect(receipt.txHash).toBe('RELAYED_HASH');
    expect(receipt.amount).toBe(5);
    expect(receipt.method).toBe('pool');

    // Exactly one relayer call, in the RelayerClient's JSON `/relay` format,
    // with the credit-gating fundingAccount threaded through (the old
    // hand-rolled path posted a bare {xdr} that a gated relayer 402s).
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.url).toBe('http://relayer.test/relay');
    expect(relayCalls[0]!.body.fundingAccount).toBe(FUNDING);
    expect(typeof relayCalls[0]!.body.xdr).toBe('string');

    // The relayed XDR is the signed withdraw invocation, not something else.
    const sent = new Transaction(relayCalls[0]!.body.xdr as string, NET);
    expect(sent.operations).toHaveLength(1);
    expect(invokedFn(sent)).toBe('withdraw');
    expect(sent.signatures.length).toBeGreaterThan(0);

    // Nothing went to the RPC directly.
    expect(directSends).toHaveLength(0);
  });

  it('fundingSigner threads signed challenge auth into /relay (credit-gated relayers)', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends });
    const adapter = new PoolAdapter(makeContractId(), NET, server);

    // Stub serving BOTH the challenge fetch and the relay post.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: { method?: string; body?: string }) => {
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.endsWith('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'ok', requireCredit: true, maxRelayFeeXlm: 0.1 }),
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
    const receipt = await adapter.withdraw(stealth.stealthAddress, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
      relay: 'http://relayer.test',
      fundingAccount: fundingKp.publicKey(),
      fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
    });
    expect(receipt.txHash).toBe('RELAYED_HASH');

    // A challenge was fetched for the funding account, then /relay got the
    // full proof-of-control triple. Without the signer, a credit-gated
    // relayer rejects the bare {xdr, fundingAccount} with 402 missing_auth.
    const challengeCall = calls.find((c) => c.url.includes('/credit/challenge'));
    expect(challengeCall?.url).toContain(encodeURIComponent(fundingKp.publicKey()));
    const relayCall = calls.find((c) => c.url.endsWith('/relay'));
    expect(relayCall).toBeDefined();
    expect(relayCall!.body.fundingAccount).toBe(fundingKp.publicKey());
    expect(relayCall!.body.nonce).toBe('NONCE123');
    expect(typeof relayCall!.body.signature).toBe('string');
    // The authorized fee ceiling comes from the relayer's advertised cap
    // (/health maxRelayFeeXlm) and is echoed in the body for the relayer to
    // verify the signature over.
    expect(relayCall!.body.authAmount).toBe('0.1000000');

    // The signature verifies over the canonical challenge message, bound to
    // the exact inner tx that was relayed (REL-01 tx-binding) and the ceiling.
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
  });

  it('claim() forwards fundingSigner into the withdraw relay auth (ClaimOpts threading)', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends });
    const adapter = new PoolAdapter(makeContractId(), NET, server);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: { method?: string; body?: string }) => {
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.endsWith('/health')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ status: 'ok', requireCredit: true, maxRelayFeeXlm: 0.1 }),
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
    const payment: Payment = {
      stealthAddress: stealth.stealthAddress,
      ephemeralPubKey: Buffer.from(stealth.ephemeralPubKey).toString('hex'),
      token: tokenAddress,
      amount: 5,
      amountStroops: BALANCE_STROOPS.toString(),
      method: 'pool',
    };
    // Through claim() — the ClaimOpts entry point — not withdraw() directly:
    // locks the fundingSigner/confirm forwarding that used to be dropped.
    const receipt = await adapter.claim(payment, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
      relay: 'http://relayer.test',
      fundingAccount: fundingKp.publicKey(),
      fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
    });
    expect(receipt.txHash).toBe('RELAYED_HASH');

    const relayCall = calls.find((c) => c.url.endsWith('/relay'));
    expect(relayCall).toBeDefined();
    expect(relayCall!.body.fundingAccount).toBe(fundingKp.publicKey());
    expect(relayCall!.body.nonce).toBe('NONCE123');
    expect(typeof relayCall!.body.signature).toBe('string');
    expect(relayCall!.body.authAmount).toBe('0.1000000');
  });

  it('accepts a bare .../relay URL without doubling the path (back-compat)', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends });
    const adapter = new PoolAdapter(makeContractId(), NET, server);
    const relayCalls = stubRelayerFetch();

    const receipt = await adapter.withdraw(stealth.stealthAddress, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
      relay: 'http://relayer.test/relay',
    });

    expect(receipt.txHash).toBe('RELAYED_HASH');
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.url).toBe('http://relayer.test/relay');
    // No fundingAccount supplied -> none serialized (free relayer path intact).
    expect('fundingAccount' in relayCalls[0]!.body).toBe(false);
  });

  it('confirm: true polls the relayer-returned hash on the RPC before returning (SDK-TXHASH-TRUST)', async () => {
    vi.useFakeTimers();
    try {
      const { keys, stealth } = makeFixture();
      const tokenAddress = Asset.native().contractId(NET);
      const directSends: string[] = [];
      const getTxCalls: string[] = [];
      const server = makeServer({ stealth, tokenAddress, directSends, getTxCalls });
      const adapter = new PoolAdapter(makeContractId(), NET, server);
      const relayCalls = stubRelayerFetch();

      const pending = adapter.withdraw(stealth.stealthAddress, DEST, {
        keys,
        feePayer: Keypair.random().secret(),
        relay: 'http://relayer.test',
        confirm: true,
      });
      // The confirm poll sleeps 1s before each getTransaction probe.
      await vi.advanceTimersByTimeAsync(1_000);
      const receipt = await pending;

      expect(receipt.txHash).toBe('RELAYED_HASH');
      expect(relayCalls).toHaveLength(1);
      // The RELAYER'S hash was verified against the RPC — not trusted blindly.
      expect(getTxCalls).toEqual(['RELAYED_HASH']);
      expect(directSends).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirm off (default): the relayer response is returned without any RPC poll', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const getTxCalls: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends, getTxCalls });
    const adapter = new PoolAdapter(makeContractId(), NET, server);
    stubRelayerFetch();

    const receipt = await adapter.withdraw(stealth.stealthAddress, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
      relay: 'http://relayer.test',
    });

    expect(receipt.txHash).toBe('RELAYED_HASH');
    // Exactly today's behavior: no confirmation polling unless asked for.
    expect(getTxCalls).toHaveLength(0);
  });

  it('routes a relay LIST through the live relayer when the first is dead (A3 acceptance)', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends });
    const adapter = new PoolAdapter(makeContractId(), NET, server);

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
    const receipt = await adapter.withdraw(stealth.stealthAddress, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
      relay: ['http://dead.invalid', 'http://relayer.test'],
      fundingAccount: fundingKp.publicKey(),
      fundingSigner: async (message) => fundingKp.sign(Buffer.from(message)),
    });
    expect(receipt.txHash).toBe('RELAYED_HASH');

    // The submit routed to the live relayer with the full auth triple; the
    // dead candidate never received the transaction.
    const relayCalls = calls.filter((c) => c.url.endsWith('/relay'));
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.url).toBe('http://relayer.test/relay');
    expect(relayCalls[0]!.body.nonce).toBe('NONCE123');
    expect(typeof relayCalls[0]!.body.signature).toBe('string');
    expect(directSends).toHaveLength(0);
  });

  it('non-relay direct path is unchanged: submits to the RPC, never fetches', async () => {
    const { keys, stealth } = makeFixture();
    const tokenAddress = Asset.native().contractId(NET);
    const directSends: string[] = [];
    const server = makeServer({ stealth, tokenAddress, directSends });
    const adapter = new PoolAdapter(makeContractId(), NET, server);
    const relayCalls = stubRelayerFetch();

    const receipt = await adapter.withdraw(stealth.stealthAddress, DEST, {
      keys,
      feePayer: Keypair.random().secret(),
    });

    expect(receipt.txHash).toBe('DIRECT_HASH');
    expect(receipt.amount).toBe(5);
    expect(directSends).toHaveLength(1);
    expect(relayCalls).toHaveLength(0);
  });
});
