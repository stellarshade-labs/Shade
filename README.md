# Stellar Stealth Accounts SDK

**Privacy-preserving payments on Stellar using DKSAP (Dual-Key Stealth Address Protocol)**

The first implementation of stealth addresses on Stellar. Supports multi-token deposits (XLM, USDC, any SAC token), atomic deposit+announce (spam-proof), and ed25519 signature-based withdrawals with optional relayer fee-bumping for enhanced privacy.

## Architecture

```
                        +-----------------------+
                        |    packages/crypto    |
                        |      (SDK core)       |
                        |                       |
                        | - DKSAP key derivation|
                        | - Stealth address gen |
                        | - ECDH shared secrets |
                        | - View tag scanning   |
                        | - HD keys (BIP-39)    |
                        | - Pure TS, no Stellar |
                        +-----------+-----------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
          +-------v--------+                 +--------v-------+
          |  packages/cli  |                 | packages/relayer|
          |  (Reference)   |                 |  (Fee-bump)    |
          |                |                 |                |
          | keygen / send  |                 | POST /relay    |
          | scan / balance |                 | Fee-bumps      |
          | withdraw       |                 | withdrawal txs |
          +-------+--------+                 +--------+-------+
                  |                                   |
                  +-----------------+-----------------+
                                    |
                  +-----------------v-----------------+
                  |      contracts/registry           |
                  |      (Soroban Pool Contract)      |
                  |                                   |
                  | deposit() - atomic deposit+announce|
                  | withdraw() - ed25519 sig verified  |
                  | get_balance() / get_nonce()        |
                  | get_announcements()                |
                  +-----------------------------------+
```

**Key design decisions:**
- **Why a pool contract?** Stellar requires a 1 XLM minimum balance reserve (MBR) for every account. Naive stealth address implementations create one account per payment, locking 1 XLM each. On chains like Solana or Ethereum this isn't a problem — accounts are free or negligible cost. On Stellar the MBR makes per-payment accounts impractical, so we hold funds in a Soroban contract with per-key accounting instead. Cost drops from 1 XLM to ~0.01 XLM (Soroban invocation fee).
- Contract tracks balances per stealth key (not a mixer — each key has its own isolated balance)
- Deposit and announcement are atomic (no spam)
- Withdrawals use ed25519 signature auth (stealth keys aren't Stellar accounts)
- Replay protection via strictly-increasing nonces per stealth key
- Relayer covers the small withdrawal tx fee so the recipient doesn't reveal which funded account they control
- Multi-token: any SAC-wrapped asset (native XLM, USDC, custom tokens)

## Quick Start

```bash
# Prerequisites: Node.js 20+, Docker, Stellar CLI, Rust toolchain
npm install

# Start local Stellar network
docker compose up -d

# Build everything
npm run build
cd contracts && stellar contract build && cd ..

# Run the full end-to-end demo
bash demo.sh
```

The demo will:
1. Deploy the stealth pool contract + native XLM SAC
2. Start the privacy relayer service
3. Generate stealth meta-addresses for Bob
4. Alice deposits 100 XLM into the stealth pool
5. Alice deposits 200 USDC into the stealth pool (multi-token)
6. Bob scans and detects both deposits with his view key
7. Bob withdraws XLM directly (fee-payer pays Soroban fee)
8. Bob withdraws USDC via relayer (fee-bump for privacy)
9. Verifies no on-chain link between Bob and stealth addresses

## CLI Commands

```bash
# Generate stealth keys
stealth keygen                              # Random keys
stealth keygen --mnemonic                   # From new BIP-39 mnemonic
stealth keygen --recover                    # Recover from 12 words
stealth keygen --show                       # Display meta-address

# Deposit tokens into stealth pool
stealth send <meta-address> <amount> --from <secret>
stealth send <meta-address> 100 --from SXXX --network local
stealth send <meta-address> 200 --from SXXX --asset USDC:GISSUER

# Scan for received deposits
stealth scan --network local

# Check pool balances
stealth balance --network local

# Withdraw from pool
stealth withdraw <stealth-addr> <destination> --fee-payer <secret>
stealth withdraw <stealth-addr> <destination> --fee-payer SXXX --relay http://localhost:3000
stealth withdraw <stealth-addr> <destination> --fee-payer SXXX --asset USDC:GISSUER
```

## Soroban Pool Contract

| Function | Description |
|----------|-------------|
| `deposit(sender, token, amount, stealth_pk, ephemeral_pk, view_tag)` | Atomic deposit + announcement |
| `withdraw(stealth_pk, token, amount, destination, nonce, signature)` | Ed25519-verified withdrawal |
| `get_balance(stealth_pk, token)` | Read pool balance |
| `get_nonce(stealth_pk)` | Read replay-protection nonce |
| `get_announcements(start, limit)` | Paginated announcement list |
| `get_announcements_by_tag(tag, start, limit)` | Filter by view tag |
| `get_announcement_count()` | Total announcement count |

**Withdraw message format** (must match between Rust and TypeScript):
```
SHA256(stealth_pk(32) || token_strkey(56) || amount_be(16) || dest_strkey(56) || nonce_be(8))
```

## Relayer

The relayer pays the small Soroban invocation fee (~0.01 XLM) on withdrawal transactions via fee-bumping. This is purely for **privacy** — without it, the recipient would need to use a funded account to pay the tx fee, linking their identity to the withdrawal. The relayer sees the XDR but learns nothing about the recipient's other accounts.

```bash
# Start relayer
RELAYER_SECRET=SXXX npx tsx packages/relayer/src/index.ts

# Endpoints
GET  /health          # Service status
POST /relay           # Submit XDR for fee-bump + broadcast
```

## DKSAP Protocol

- **Meta-address:** `(K_spend, K_view)` - two ed25519 public keys, shared publicly
- **Send:** pick random `r`, compute `R = r*G`, shared secret `S = r*K_view`, derive `P_stealth = K_spend + SHA256(S)*G`
- **View tag:** `SHA256(S)[0]` - first byte for fast scanning (~25x speedup)
- **Scan:** compute `S = k_view*R`, check view tag, verify stealth address
- **Recover:** `p_stealth = k_spend + SHA256(S) mod L`

## Development

```bash
npm run build                    # Build all TS packages
npm run test                     # Run all TS tests (147 tests)
cd contracts && cargo test       # Run Rust contract tests (10 tests)
docker compose up -d             # Start local Stellar network
bash demo.sh                     # Full end-to-end demo
```

## Known Limitations

- **Announcement storage:** Single `Vec` in contract hits ~500 entries before Soroban 64KB limit. Fine for demo, needs pagination/archival for production.
- **Local network only:** All development and testing uses Docker local network. Never tested on testnet/mainnet.
- **No BIP-32/44:** HD derivation uses domain-separated SHA-256, not standard BIP-32 paths (those use secp256k1).

## Security

- Spend private keys never leave the client
- View keys enable scan-only access (safe to delegate)
- Stealth private keys exist only in memory during withdraw
- Keystore encrypted with AES-256-GCM
- All randomness from `crypto.getRandomValues()`

## License

MIT
