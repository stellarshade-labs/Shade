import { simulateReadOnly } from '@shade/sdk';
import { Address, nativeToScVal } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';

/**
 * Read a stealth key's pool balance for a token via read-only simulation.
 *
 * The single CLI implementation — scan, balance, and withdraw all share it —
 * wrapping the SDK's `simulateReadOnly` helper (CLI-DUP: previously three
 * copy-pasted simulation blocks).
 */
export async function getContractBalance(
  contractId: string,
  stealthPk: Uint8Array,
  tokenAddress: string,
  server: rpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const result = await simulateReadOnly(
    contractId,
    'get_balance',
    [nativeToScVal(Buffer.from(stealthPk)), new Address(tokenAddress).toScVal()],
    server,
    networkPassphrase,
  );
  return result === null || result === undefined
    ? 0n
    : BigInt(result as string | number | bigint);
}

/** Read the current withdraw nonce for a stealth key (pool method). */
export async function getNonce(
  contractId: string,
  stealthPk: Uint8Array,
  server: rpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const result = await simulateReadOnly(
    contractId,
    'get_nonce',
    [nativeToScVal(Buffer.from(stealthPk))],
    server,
    networkPassphrase,
  );
  return result === null || result === undefined
    ? 0n
    : BigInt(result as string | number | bigint);
}
