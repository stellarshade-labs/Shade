import { describe, it, expect } from 'vitest';
import {
  Networks,
  Keypair,
  Address,
  Asset,
  StrKey,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
  type Transaction,
} from '@stellar/stellar-sdk';
import { fetchAnnouncements } from '../src/commands/scan.js';

const NET = Networks.TESTNET;

function makeContractId(): string {
  const kp = Keypair.random();
  return StrKey.encodeContract(Buffer.from(hash(Buffer.from(kp.rawPublicKey()))));
}

/** Read the invoked contract function name + args from a simulation tx. */
function invoked(tx: Transaction): { fn: string; args: xdr.ScVal[] } {
  const op = tx.operations[0] as { func: xdr.HostFunction };
  const inv = op.func.invokeContract();
  return {
    fn: inv.functionName().toString(),
    args: inv.args(),
  };
}

/**
 * A stub `rpc.Server` backed by an in-memory array of `total` announcements.
 * `get_announcement_count` returns the total; `get_announcements(start, limit)`
 * returns the requested slice as an ScVal vec, exactly like the pool contract.
 */
function makePagedServer(total: number): rpc.Server {
  const token = Asset.native().contractId(NET);
  // Distinct stealth pk per index so a specific one can be located by address.
  const pkFor = (i: number): Uint8Array => {
    const kp = Keypair.random();
    void i;
    return kp.rawPublicKey();
  };
  const stealthPks: Uint8Array[] = Array.from({ length: total }, (_, i) => pkFor(i));

  const annScVal = (i: number): xdr.ScVal =>
    nativeToScVal({
      stealth_pk: Buffer.from(stealthPks[i]!),
      ephemeral_pk: Buffer.from(new Uint8Array(32)),
      view_tag: nativeToScVal(0, { type: 'u32' }),
      token: new Address(token),
      amount: nativeToScVal(1, { type: 'i128' }),
      sequence: nativeToScVal(0, { type: 'u64' }),
    });

  const server = {
    async simulateTransaction(tx: Transaction): Promise<unknown> {
      const { fn, args } = invoked(tx);
      if (fn === 'get_announcement_count') {
        return {
          transactionData: {},
          result: { retval: nativeToScVal(total, { type: 'u64' }) },
        };
      }
      if (fn === 'get_announcements') {
        const start = Number(scValToNative(args[0]!));
        const limit = Number(scValToNative(args[1]!));
        const slice: xdr.ScVal[] = [];
        for (let i = start; i < Math.min(start + limit, total); i++) {
          slice.push(annScVal(i));
        }
        return { transactionData: {}, result: { retval: xdr.ScVal.scvVec(slice) } };
      }
      throw new Error(`unexpected fn: ${fn}`);
    },
  } as unknown as rpc.Server;

  return server;
}

describe('CLI scan paging (PAGE-1)', () => {
  it('surfaces an announcement seeded at index >= 1000 (past a single page)', async () => {
    const total = 1500;
    const server = makePagedServer(total);
    const contractId = makeContractId();

    const result = await fetchAnnouncements(contractId, server, NET);

    // Every announcement is paged in, not just the first page.
    expect(result).toHaveLength(total);
    // Specifically, the one at index 1200 (well past 1000) is present.
    expect(result[1200]).toBeDefined();
    expect(result[1499]).toBeDefined();
  });
});
