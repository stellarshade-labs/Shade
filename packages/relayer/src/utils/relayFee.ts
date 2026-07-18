import { Transaction, xdr } from '@stellar/stellar-sdk';

export interface BumpFeePlan {
  /** Per-operation base fee to pass to buildFeeBumpTransaction (stroops). */
  bumpBase: bigint;
  /** Total outer fee the build will produce: bumpBase × (nOps+1) + resourceFee. */
  outerFee: bigint;
}

/**
 * Mirror of the stellar-sdk buildFeeBumpTransaction fee math, computed BEFORE
 * building so the outer-fee cap can be enforced first. The SDK requires the
 * bump base fee to be >= the inner tx's per-op inclusion fee
 * ((innerFee − sorobanResourceFee) / nOps, an exact rational) and >= 100, and
 * throws otherwise — which used to surface a high inner fee as an uncaught 500
 * before the cap check could run. The built outer fee is
 * base × (nOps + 1) + resourceFee.
 *
 * ceilDiv gives the smallest integer satisfying the SDK's rational comparison,
 * so building with the returned bumpBase never throws for fee reasons and
 * produces exactly outerFee (proven executably in relayFee.test.ts).
 *
 * Returns null when the inner tx cannot be parsed (zero ops, no numeric fee):
 * the caller falls back to the plain doubled base fee and lets the guarded
 * build surface the defect.
 */
export function planBumpFee(
  innerTx: Transaction,
  clampedBaseFee: number,
): BumpFeePlan | null {
  try {
    const nOps = BigInt(innerTx.operations.length);
    if (nOps <= 0n) return null;

    let resourceFee = 0n;
    try {
      const env = innerTx.toEnvelope();
      if (env.switch().value === xdr.EnvelopeType.envelopeTypeTx().value) {
        resourceFee = env.v1().tx().ext().value()?.resourceFee().toBigInt() ?? 0n;
      }
    } catch {
      // No parseable v1 envelope (legacy v0 or a test double): no resource fee,
      // same as the SDK's switch falling through.
      resourceFee = 0n;
    }

    const innerFee = BigInt(innerTx.fee);
    const inclusion = innerFee > resourceFee ? innerFee - resourceFee : 0n;
    const perOp = (inclusion + nOps - 1n) / nOps;

    let bumpBase = BigInt(Math.floor(clampedBaseFee)) * 2n;
    if (perOp > bumpBase) bumpBase = perOp;
    if (bumpBase < 100n) bumpBase = 100n; // The SDK's minimum BASE_FEE.

    return { bumpBase, outerFee: bumpBase * (nOps + 1n) + resourceFee };
  } catch {
    return null;
  }
}
