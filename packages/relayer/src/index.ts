import express from 'express';
import cors from 'cors';
import { Keypair, Horizon } from '@stellar/stellar-sdk';
import { initRelayRoute, handleRelay } from './routes/relay.js';
import RateLimiter from './utils/rateLimit.js';
import { logger } from './utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

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

    initRelayRoute(keypair);

    app.get('/health', (_, res) => {
      res.json({ status: 'ok', network: NETWORK });
    });

    app.post('/relay', handleRelay);

    const httpServer = app.listen(PORT, '0.0.0.0', () => {
      logger.info('Relayer started', { port: PORT, network: NETWORK });
      console.log(`[Relayer] Server listening on port ${PORT}`);
      console.log(`[Relayer] Network: ${NETWORK}`);
      console.log(`[Relayer] Rate limit: 10 requests/minute per IP`);
      console.log(`[Relayer] Endpoints:`);
      console.log(`  POST /relay   - Fee-bump transaction submission`);
      console.log(`  GET  /health  - Health check`);
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