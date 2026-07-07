import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Keypair, Horizon } from '@stellar/stellar-sdk';
import { initRelayRoute, handleRelay } from './routes/relay.js';
import { handleSponsor } from './routes/sponsor.js';
import {
  handleSponsorClaimPrepare,
  handleSponsorClaimSubmit,
} from './routes/sponsorClaim.js';
import { handleCreditClaim, handleCreditBalance } from './routes/credit.js';
import { handleCreditChallenge } from './routes/challenge.js';
import { CreditLedger } from './ledger.js';
import { initContext } from './context.js';
import RateLimiter from './utils/rateLimit.js';
import { logger } from './utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Behind Railway's (or any reverse-proxy's) edge, req.ip must reflect the real
// client, not the proxy. Trust exactly as many hops as the rate limiter does:
// TRUST_PROXY_HOPS (default 0 = trust nothing when not behind a proxy). Never
// hardcode `true` — that would trust every hop and re-open the X-Forwarded-For
// spoof that utils/rateLimit.ts closes.
const trustProxyHops = (() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw !== undefined && raw !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
    return 0;
  }
  return process.env.TRUST_PROXY === 'true' ? 1 : 0;
})();
app.set('trust proxy', trustProxyHops);

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  maxAge: 86400 // 24 hours
};
app.use(cors(corsOptions));

app.use(express.json());

const rateLimiter = new RateLimiter(10, 10, 60000);
app.use(rateLimiter.middleware());

app.use(logger.middleware());

const RELAYER_SECRET = process.env.RELAYER_SECRET;
const NETWORK = process.env.NETWORK || 'local';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

/**
 * Wrap a possibly-async route handler so a rejected promise is forwarded to the
 * Express error-handling middleware via `next(err)`. Without this, an async
 * handler that throws/rejects under Express 4 produces an unhandled rejection
 * and leaves the request socket hanging.
 */
function asyncHandler(
  fn: (req: Request, res: Response) => unknown | Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

async function initRelayer() {
  try {
    let keypair: Keypair;

    if (RELAYER_SECRET) {
      keypair = Keypair.fromSecret(RELAYER_SECRET);
      logger.info('Using configured keypair', { publicKey: keypair.publicKey() });
    } else {
      keypair = Keypair.random();
      logger.warn('Generated new keypair', {
        publicKey: keypair.publicKey(),
        message: 'Set RELAYER_SECRET env var to persist this keypair'
      });
    }

    const horizonUrl = NETWORK === 'local'
      ? 'http://localhost:8000'
      : 'https://horizon-testnet.stellar.org';

    const horizonServer = new Horizon.Server(horizonUrl, {
      allowHttp: NETWORK === 'local',
    });

    try {
      const account = await horizonServer.loadAccount(keypair.publicKey());
      const xlmBalance = account.balances.find(b => b.asset_type === 'native');
      const balance = parseFloat(xlmBalance?.balance || '0');

      if (balance < 100) {
        logger.warn('Low relayer balance', {
          balance,
          publicKey: keypair.publicKey(),
          message: 'Balance below 100 XLM - refill recommended'
        });
        console.log(`[Relayer] ⚠️ WARNING: Balance is ${balance} XLM (below recommended 100 XLM)`);
      } else {
        logger.info('Relayer balance check', { balance, publicKey: keypair.publicKey() });
        console.log(`[Relayer] Balance: ${balance} XLM`);
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        logger.error('Account not funded', { publicKey: keypair.publicKey() });
        console.log(`[Relayer] Account not funded. Please fund: ${keypair.publicKey()}`);
        if (NETWORK === 'local') {
          console.log(`[Relayer] Run: curl "http://localhost:8000/friendbot?addr=${keypair.publicKey()}"`);
        }
      }
    }

    const requireCredit = process.env.RELAYER_REQUIRE_CREDIT === '1';
    const ledger = new CreditLedger();

    const relayerCtx = initContext({
      keypair,
      network: NETWORK,
      horizonUrl,
      server: horizonServer,
      ledger,
      requireCredit,
    });
    initRelayRoute(keypair, {
      ledger,
      requireCredit,
      challenges: relayerCtx.challenges,
    });

    app.get('/health', async (_, res) => {
      let balance = '0';
      try {
        const account = await horizonServer.loadAccount(keypair.publicKey());
        balance = account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
      } catch {
        // Account may be unfunded; report zero.
      }
      res.json({
        status: 'ok',
        network: NETWORK,
        relayerAddress: keypair.publicKey(),
        balance,
        requireCredit,
      });
    });

    app.post('/relay', asyncHandler(handleRelay));
    app.post('/sponsor', asyncHandler(handleSponsor));
    app.post('/sponsor-claim/prepare', asyncHandler(handleSponsorClaimPrepare));
    app.post('/sponsor-claim/submit', asyncHandler(handleSponsorClaimSubmit));
    app.post('/credit/claim', asyncHandler(handleCreditClaim));
    app.get('/credit/challenge', asyncHandler(handleCreditChallenge));
    app.get('/credit/:account', asyncHandler(handleCreditBalance));

    // Global error handler: any unexpected async rejection (Express 4 does not
    // catch rejected promises from async handlers on its own) is funneled here
    // via asyncHandler() so the client gets a 500 JSON body instead of a hung
    // socket. Must be registered AFTER the routes.
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : 'internal error';
      logger.error('Unhandled route error', { error: message });
      if (res.headersSent) return;
      res.status(500).json({ error: 'Internal server error', code: 'server_error' });
    });

    const httpServer = app.listen(PORT, '0.0.0.0', () => {
      logger.info('Relayer started', { port: PORT, network: NETWORK });
      console.log(`[Relayer] Server listening on port ${PORT}`);
      console.log(`[Relayer] Network: ${NETWORK}`);
      console.log(`[Relayer] Require credit: ${requireCredit}`);
      console.log(`[Relayer] Rate limit: 10 requests/minute per IP`);
      console.log(`[Relayer] Endpoints:`);
      console.log(`  POST /relay                  - Fee-bump transaction submission`);
      console.log(`  POST /sponsor                - Create a stealth account`);
      console.log(`  POST /sponsor-claim/prepare  - Build a sponsored claim tx`);
      console.log(`  POST /sponsor-claim/submit   - Co-sign + submit a sponsored claim`);
      console.log(`  POST /credit/claim           - Credit an app account from a deposit`);
      console.log(`  GET  /credit/challenge       - Issue a proof-of-control nonce`);
      console.log(`  GET  /credit/:account        - Read an app account's credit`);
      console.log(`  GET  /health                 - Health check`);
    });

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    async function gracefulShutdown(signal: NodeJS.Signals) {
      logger.info(`Received ${signal}, starting graceful shutdown`);
      console.log(`\n[Relayer] Received ${signal}, shutting down gracefully...`);

      httpServer.close(() => {
        logger.info('Server closed');
        console.log('[Relayer] Server closed');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        console.error('[Relayer] Forced shutdown after 10s timeout');
        process.exit(1);
      }, 10000);
    }

  } catch (error: any) {
    logger.error('Initialization error', { error: error.message, stack: error.stack });
    console.error('[Relayer] Initialization error:', error);
    process.exit(1);
  }
}

initRelayer();