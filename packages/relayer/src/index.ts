import express from 'express';
import { Keypair, Horizon, Networks } from '@stellar/stellar-sdk';
import { initRelayRoute, handleRelay } from './routes/relay.js';
import { initSponsorRoute, handleSponsor } from './routes/sponsor.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const RELAYER_SECRET = process.env.RELAYER_SECRET;
const NETWORK = process.env.NETWORK || 'local';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function initRelayer() {
  try {
    let keypair: Keypair;

    if (RELAYER_SECRET) {
      keypair = Keypair.fromSecret(RELAYER_SECRET);
      console.log(`[Relayer] Using configured keypair: ${keypair.publicKey()}`);
    } else {
      keypair = Keypair.random();
      console.log(`[Relayer] Generated new keypair: ${keypair.publicKey()}`);
      console.log(`[Relayer] Secret: ${keypair.secret()}`);
      console.log(`[Relayer] Set RELAYER_SECRET env var to persist this keypair`);
    }

    const horizonUrl = NETWORK === 'local'
      ? 'http://localhost:8000'
      : 'https://horizon-testnet.stellar.org';

    const server = new Horizon.Server(horizonUrl);

    try {
      const account = await server.loadAccount(keypair.publicKey());
      const xlmBalance = account.balances.find(b => b.asset_type === 'native');
      console.log(`[Relayer] Balance: ${xlmBalance?.balance || '0'} XLM`);
    } catch (error: any) {
      if (error?.response?.status === 404) {
        console.log(`[Relayer] Account not funded. Please fund: ${keypair.publicKey()}`);
        if (NETWORK === 'local') {
          console.log(`[Relayer] Run: curl "http://localhost:8000/friendbot?addr=${keypair.publicKey()}"`);
        }
      }
    }

    initRelayRoute(keypair);
    initSponsorRoute(keypair);

    app.get('/health', (req, res) => {
      res.json({ status: 'ok', network: NETWORK });
    });

    app.post('/relay', handleRelay);
    app.post('/sponsor', handleSponsor);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Relayer] Server listening on port ${PORT}`);
      console.log(`[Relayer] Network: ${NETWORK}`);
      console.log(`[Relayer] Endpoints:`);
      console.log(`  POST /sponsor - Sponsor stealth account creation`);
      console.log(`  POST /relay   - Fee-bump transaction submission`);
      console.log(`  GET  /health  - Health check`);
    });

  } catch (error) {
    console.error('[Relayer] Initialization error:', error);
    process.exit(1);
  }
}

initRelayer();