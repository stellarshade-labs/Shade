import { Request, Response } from 'express';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { maxRelayFeeXlm } from './relay.js';
import { SPONSORED_RESERVE_ESTIMATE } from './sponsorClaim.js';

/** Startup-time dependencies the /health report is built from. */
export interface HealthDeps {
  server: Horizon.Server;
  keypair: Keypair;
  network: string;
  requireCredit: boolean;
  store: string;
  sharedState: string;
}

/**
 * GET /health — liveness plus the operational facts discovery clients need.
 * Extracted from index.ts (which starts listening at import time) so the
 * response shape is testable over HTTP.
 */
export function createHealthHandler(deps: HealthDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    let balance = '0';
    try {
      const account = await deps.server.loadAccount(deps.keypair.publicKey());
      balance = account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    } catch {
      // Account may be unfunded; report zero.
    }
    res.json({
      status: 'ok',
      network: deps.network,
      relayerAddress: deps.keypair.publicKey(),
      balance,
      requireCredit: deps.requireCredit,
      // Advertised so clients know the fee ceiling to sign in the /relay
      // challenge (authAmount) without predicting the exact built fee.
      maxRelayFeeXlm: maxRelayFeeXlm(),
      // XLM fronted per sponsored claim (base reserve + trustline), so clients
      // can predict the hold /sponsor-claim/prepare places against their credit.
      sponsoredReserveEstimate: SPONSORED_RESERVE_ESTIMATE,
      // Backend transparency (also lets discovery clients prefer a durable,
      // multi-instance relayer): 'postgres'|'json' and 'redis'|'memory'.
      store: deps.store,
      sharedState: deps.sharedState,
    });
  };
}
