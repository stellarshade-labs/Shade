import { xdr } from '@stellar/stellar-sdk';

/**
 * Extract the on-chain `fee_charged` (stroops) from a Horizon submit response.
 *
 * The typed submit response carries no `fee_charged` field, but it does carry
 * `result_xdr`, and decoding that is authoritative and offline. The XDR
 * `TransactionResult.feeCharged` sits at the top level for BOTH regular and
 * fee-bump results (a fee bump nests the inner result under
 * `txFeeBumpInnerSuccess/Failed`, but the outer `feeCharged` is the total the
 * network charged for the whole envelope). A plain `fee_charged` field is
 * accepted as a fallback for responses that carry one.
 *
 * Never throws: reconciliation runs AFTER a successful submit, where a parse
 * failure must degrade to "settle the full reserved fee", not fail the
 * request. Returns null when no non-negative value can be extracted.
 */
export function feeChargedStroops(response: unknown): bigint | null {
  if (typeof response !== 'object' || response === null) return null;
  const r = response as { result_xdr?: unknown; fee_charged?: unknown };

  if (typeof r.result_xdr === 'string' && r.result_xdr.length > 0) {
    try {
      const fee = xdr.TransactionResult.fromXDR(r.result_xdr, 'base64')
        .feeCharged()
        .toBigInt();
      if (fee >= 0n) return fee;
    } catch {
      // Fall through to the fee_charged probe.
    }
  }

  if (typeof r.fee_charged === 'string' && /^\d+$/.test(r.fee_charged)) {
    return BigInt(r.fee_charged);
  }
  if (
    typeof r.fee_charged === 'number' &&
    Number.isSafeInteger(r.fee_charged) &&
    r.fee_charged >= 0
  ) {
    return BigInt(r.fee_charged);
  }
  return null;
}
