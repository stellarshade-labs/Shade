import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { assertSupportedNetwork, horizonUrlFor } from './context.js';
import { HorizonClient } from './horizon.js';
import { createIngester } from './ingest.js';
import { createAnnouncementStore } from './store/factory.js';
import {
  createAnnouncementsHandler,
  createHealthHandler,
} from './routes/announcements.js';
import { logger } from './utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// CORS: the candidate feed is PUBLIC data (hash-memo txs anyone can read off
// Horizon), so the '*' default is fine here — no permissiveness warning.
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  maxAge: 86400 // 24 hours
};
app.use(cors(corsOptions));

app.use(express.json());

app.use(logger.middleware());

const NETWORK = process.env.NETWORK || 'testnet';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3100;
const INGEST_START = process.env.INGEST_START || 'now';
const INGEST_INTERVAL_MS = (() => {
  const raw = process.env.INGEST_INTERVAL_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3000;
})();

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

async function initIndexer() {
  try {
    // Reject unknown networks before anything else — 'local' was removed and
    // supported networks live in the INDEXER_NETWORKS table.
    assertSupportedNetwork(NETWORK);

    const horizonUrl = horizonUrlFor(NETWORK);

    // Fail fast when DATABASE_URL is set but unreachable (throws → exit 1).
    // NEVER a silent memory fallback for a configured deploy.
    const { store, kind } = await createAnnouncementStore();

    const horizon = new HorizonClient(horizonUrl);
    const ingester = createIngester({
      horizon,
      store,
      intervalMs: INGEST_INTERVAL_MS,
      log: logger,
    });
    // Throws on an invalid INGEST_START (caught below → exit 1).
    await ingester.start(INGEST_START);

    app.get(
      '/health',
      asyncHandler(
        createHealthHandler({
          network: NETWORK,
          storeKind: kind,
          store,
          ingestStatus: () => ingester.status(),
        }),
      ),
    );
    app.get('/announcements', asyncHandler(createAnnouncementsHandler(store)));

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
      logger.info('Indexer started', {
        port: PORT,
        network: NETWORK,
        horizonUrl,
        store: kind,
        ingestStart: INGEST_START,
        intervalMs: INGEST_INTERVAL_MS,
      });
      console.log(`[Indexer] Server listening on port ${PORT}`);
      console.log(`[Indexer] Network: ${NETWORK} (${horizonUrl})`);
      console.log(`[Indexer] Store: ${kind}`);
      console.log(`[Indexer] Endpoints:`);
      console.log(`  GET /announcements - Hash-memo announcement candidate feed`);
      console.log(`  GET /health        - Health check + ingest progress`);
    });

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    function gracefulShutdown(signal: NodeJS.Signals) {
      logger.info(`Received ${signal}, starting graceful shutdown`);
      console.log(`\n[Indexer] Received ${signal}, shutting down gracefully...`);

      // Stop polling first so no tick writes race the store teardown.
      ingester.stop();

      httpServer.close(async () => {
        await store.close().catch(() => {});
        logger.info('Server closed');
        console.log('[Indexer] Server closed');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        console.error('[Indexer] Forced shutdown after 10s timeout');
        process.exit(1);
      }, 10000);
    }

  } catch (error: any) {
    logger.error('Initialization error', { error: error.message, stack: error.stack });
    console.error('[Indexer] Initialization error:', error);
    process.exit(1);
  }
}

initIndexer();
