import { Request, Response } from 'express';
import {
  Keypair,
  TransactionBuilder,
  Transaction,
  type FeeBumpTransaction
} from '@stellar/stellar-sdk';
import { getContext } from '../context.js';
import type { CreditLedger, Reservation } from '../ledger.js';
import { fromStroops, toStroops } from '../ledger.js';
import { validateStellarAddress } from '../utils/validation.js';
import { feeChargedStroops } from '../utils/feeCharged.js';
import { planBumpFee } from '../utils/relayFee.js';
import type { ChallengeStore } from '../utils/auth.js';

let relayerKeypair: Keypair | null = null;
let relayLedger: CreditLedger | null = null;
let relayRequireCredit = false;
let relayChallenges: ChallengeStore | null = null;

/** Max operations allowed in an inner tx submitted to /relay. */
function maxRelayOps(): number {
  const n = Number(process.env.MAX_RELAY_OPS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** Ceiling (stroops) clamped onto the fetched base fee before building. */
function maxBaseFee(): number {
  const n = Number(process.env.MAX_BASE_FEE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000;
}

/** Absolute cap (XLM) on the built outer fee-bump fee. */
export function maxRelayFeeXlm(): number {
  const n = Number(process.env.MAX_RELAY_FEE_XLM);
  return Number.isFinite(n) && n > 0 ? n : 0.1;
}

/** Max future window (seconds) an inner tx maxTime may be from now. */
function maxRelayTimeboundsSeconds(): number {
  const n = Number(process.env.MAX_RELAY_TIMEBOUNDS_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
}

export function initRelayRoute(
  keypair: Keypair,
  opts?: {
    ledger?: CreditLedger;
    requireCredit?: boolean;
    challenges?: ChallengeStore;
  },
) {
  relayerKeypair = keypair;
  relayLedger = opts?.ledger ?? null;
  relayRequireCredit = opts?.requireCredit ?? false;
  relayChallenges = opts?.challenges ?? null;
}

export async function handleRelay(req: Request, res: Response) {
  try {
    if (!relayerKeypair) {
      return res.status(500).json({ error: 'Relayer not initialized' });
    }

    const { xdr, fundingAccount, nonce, signature, authAmount } = req.body;

    if (!xdr || typeof xdr !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid XDR' });
    }

    // Network passphrase + Horizon server come from the shared relayer
    // context (table-driven; initialized once at startup).
    const { networkPassphrase, server } = getContext();

    let innerTx: Transaction;
    try {
      innerTx = new Transaction(xdr, networkPassphrase);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid transaction XDR' });
    }

    // Abuse guards applied on EVERY path (including the free/default path,
    // where nothing is charged and only the rate limiter stands between an
    // unauthenticated caller and the relayer hot wallet). Mirror the caps in
    // sponsorClaim: bound op-count, base fee, outer fee, timebounds, and memo.
    const ops = innerTx.operations ?? [];
    if (ops.length === 0) {
      // The SDK's per-op fee math divides by the op count (a zero-op inner tx
      // used to throw inside the build and surface as a 500); core rejects
      // op-less transactions anyway.
      return res.status(400).json({
        error: 'Inner tx has no operations',
        code: 'invalid_tx',
      });
    }
    if (ops.length > maxRelayOps()) {
      return res.status(400).json({
        error: `Too many operations (max ${maxRelayOps()})`,
        code: 'too_many_ops',
      });
    }

    // Require present, non-expired, bounded timebounds so the relayer cannot be
    // handed a tx that lingers or replays far in the future. Already-expired
    // bounds are rejected too (<=: core requires the including ledger's
    // closeTime <= maxTime, so a tx expiring "now" cannot land) — otherwise a
    // dead tx would burn a reserve/refund cycle, get a hot-wallet signature,
    // and surface Horizon's codeless tx_too_late 400 instead of this error.
    const nowSec = Math.floor(Date.now() / 1000);
    const maxTime = Number(innerTx.timeBounds?.maxTime ?? 0);
    if (!maxTime || maxTime <= nowSec || maxTime > nowSec + maxRelayTimeboundsSeconds()) {
      return res.status(400).json({
        error: 'Inner tx must set bounded, unexpired, near-future timebounds',
        code: 'invalid_timebounds',
      });
    }

    // Forbid memos: a relayed withdrawal has no legitimate memo and one could
    // leak/link metadata or tag an exchange deposit.
    if (innerTx.memo && innerTx.memo.type !== 'none') {
      return res.status(400).json({ error: 'Memo not allowed', code: 'memo_not_allowed' });
    }

    console.log(`[Relay] Wrapping transaction in fee bump...`);

    await server.loadAccount(relayerKeypair.publicKey());
    // Clamp the fetched base fee so a poisoned/spiking base-fee reading cannot
    // inflate what the relayer signs.
    const baseFee = Math.min(await server.fetchBaseFee(), maxBaseFee());

    // Plan the bump fee BEFORE building: the SDK requires the bump base fee to
    // cover the inner tx's per-op inclusion fee, so a high inner fee used to
    // throw inside buildFeeBumpTransaction (an uncaught 500) before the cap
    // check below could ever run. Sizing the bump base to the inner demand and
    // capping the resulting outer fee first serves high-but-cappable inner
    // fees and gives over-cap ones an honest fee_exceeds_cap.
    const plan = planBumpFee(innerTx, baseFee);
    const capStroops = toStroops(maxRelayFeeXlm().toFixed(7));
    if (plan && plan.outerFee > capStroops) {
      return res.status(400).json({
        error: `Fee exceeds cap (${maxRelayFeeXlm()} XLM)`,
        code: 'fee_exceeds_cap',
      });
    }
    const bumpFee = (plan ? plan.bumpBase : BigInt(baseFee) * 2n).toString();

    // Build the fee-bump so we can debit the actual total outer fee
    // (per-op fee * (innerOps + 1)) rather than the per-op input, which
    // otherwise undercharges 2-6x on multi-op inner transactions.
    let feeBumpTx: FeeBumpTransaction;
    try {
      feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        relayerKeypair,
        bumpFee,
        innerTx,
        networkPassphrase
      );
    } catch (buildErr) {
      // Structurally unbuildable inner tx — never fee-driven (the plan above
      // already sized the bump base to the inner demand and capped it).
      console.warn(
        '[Relay] buildFeeBumpTransaction rejected inner tx:',
        buildErr instanceof Error ? buildErr.message : buildErr,
      );
      return res.status(400).json({
        error: 'Could not build a fee bump for this inner transaction',
        code: 'invalid_tx',
      });
    }

    // Optional credit gating: reserve the actual built total fee BEFORE submit.
    const feeXlm = fromStroops(BigInt(feeBumpTx.fee));

    // Absolute outer-fee ceiling, re-checked on the BUILT fee: even when the
    // pre-build plan could not parse the inner tx, a well-formed multi-op tx
    // cannot make the relayer sign an outer fee above the configured cap.
    if (toStroops(feeXlm) > capStroops) {
      return res.status(400).json({
        error: `Fee exceeds cap (${maxRelayFeeXlm()} XLM)`,
        code: 'fee_exceeds_cap',
      });
    }
    let reservation: Reservation | null = null;
    if (relayRequireCredit && relayLedger) {
      // Fail-closed: a credit-gated relayer MUST have a challenge store to prove
      // control of the fundingAccount. Without one we cannot authenticate the
      // caller, so we refuse rather than debit an attacker-named account with no
      // signature check.
      if (!relayChallenges) {
        return res.status(500).json({
          error: 'Relayer misconfigured: credit gating requires a challenge store',
          code: 'server_error',
        });
      }
      if (!validateStellarAddress(fundingAccount)) {
        return res
          .status(402)
          .json({ error: 'Funding account required', code: 'insufficient_credit' });
      }
      // Proof-of-control: the fundingAccount must sign a fresh challenge nonce
      // binding this endpoint + account + an authorized fee CEILING AND the
      // specific inner transaction (network-scoped hash). The client cannot
      // predict the exact outer fee (it depends on this relayer's clamped
      // base-fee fetch at build time), so the signature covers a
      // client-declared ceiling (`authAmount`, echoed in the body): it
      // authorizes "debit up to authAmount XLM for THIS inner tx". The actual
      // fee must come in under the ceiling, and only the actual fee is
      // reserved. Binding the inner-tx hash stops an intercepted
      // {nonce, signature} from being paired with a different attacker-signed
      // inner XDR.
      if (typeof authAmount !== 'string' || !/^\d+(\.\d{1,7})?$/.test(authAmount)) {
        return res.status(401).json({ error: 'Unauthorized', code: 'missing_auth' });
      }
      const innerTxHash = innerTx.hash().toString('hex');
      const authErr = await relayChallenges.verify(
        'relay',
        { fundingAccount, nonce, signature },
        authAmount,
        innerTxHash,
      );
      if (authErr) {
        return res.status(401).json({ error: 'Unauthorized', code: authErr });
      }
      if (Number(feeXlm) > Number(authAmount)) {
        return res.status(402).json({
          error: `Fee ${feeXlm} exceeds the authorized ceiling ${authAmount}`,
          code: 'fee_exceeds_authorization',
        });
      }
      try {
        reservation = await relayLedger.reserve(
          fundingAccount,
          feeXlm,
          `relay:${feeBumpTx.hash().toString('hex')}`,
        );
      } catch {
        return res
          .status(402)
          .json({ error: 'Insufficient credit', code: 'insufficient_credit' });
      }
    }

    feeBumpTx.sign(relayerKeypair);

    console.log(`[Relay] Submitting fee-bumped transaction...`);

    let response;
    try {
      response = await server.submitTransaction(feeBumpTx);
    } catch (submitErr) {
      if (reservation && relayLedger) await relayLedger.refund(reservation);
      throw submitErr;
    }
    // The tx LANDED: nothing below may turn the success into an error
    // response. Settle at the on-chain fee_charged (decoded offline from the
    // submit result) so the funder is charged what the network actually took,
    // not the built maximum — the difference (base-fee headroom + Soroban
    // resource-fee refunds) is credited back in the same atomic step.
    if (reservation && relayLedger) {
      try {
        const charged = feeChargedStroops(response);
        if (charged === null) {
          console.warn('[Relay] fee_charged unavailable; settling the full reserved fee');
          await relayLedger.settle(reservation);
        } else {
          await relayLedger.settle(reservation, fromStroops(charged));
        }
      } catch (settleErr) {
        // Reservation stays OUTSTANDING; the recovery sweep refunds it later —
        // under-charging is the acceptable direction once the tx landed.
        console.error('[Relay] settle failed after successful submit:', settleErr);
      }
    }

    console.log(`[Relay] Transaction submitted: ${response.hash}`);

    return res.json({
      txHash: response.hash,
      success: true
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Relay] Error:', message);

    const codes = (
      error as { response?: { data?: { extras?: { result_codes?: unknown } } } }
    )?.response?.data?.extras?.result_codes;
    if (codes) {
      return res.status(400).json({
        error: 'Transaction failed',
        codes,
      });
    }

    return res.status(500).json({
      error: message || 'Internal server error',
    });
  }
}