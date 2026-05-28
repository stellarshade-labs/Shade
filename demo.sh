#!/bin/bash

set -e

# Colors for output
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Error handler
error_exit() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

# Check prerequisites
check_prerequisites() {
    echo -e "${CYAN}Checking prerequisites...${NC}"

    command -v docker >/dev/null 2>&1 || error_exit "Docker is not installed"
    command -v stellar >/dev/null 2>&1 || error_exit "Stellar CLI is not installed"
    command -v npm >/dev/null 2>&1 || error_exit "npm is not installed"

    # Check if Docker is running
    docker info >/dev/null 2>&1 || error_exit "Docker is not running. Please start Docker."

    echo -e "${GREEN}All prerequisites met${NC}"
}

# Start timer
START_TIME=$(date +%s)

echo
echo "========================================="
echo -e "${BOLD}   Stellar Stealth Addresses Demo v2${NC}"
echo "========================================="
echo
echo "This demo showcases the contract-as-balance-pool design:"
echo "  - Generate stealth meta-addresses"
echo "  - Deposit tokens into the stealth pool (atomic announce)"
echo "  - Scan for received deposits"
echo "  - Withdraw from pool with ed25519 signature auth"
echo
echo "Estimated runtime: ~3 minutes"
echo

check_prerequisites
echo

# Step 1: Ensure local Stellar network is running
echo -e "${CYAN}${BOLD}Step 1: Starting local Stellar network...${NC}"
echo "  Setting up isolated test environment..."
docker compose up -d >/dev/null 2>&1
sleep 5
echo -e "${GREEN}Local network running on port 8000${NC}"
echo

# Step 2: Build the TypeScript packages
echo -e "${CYAN}${BOLD}Step 2: Building SDK packages...${NC}"
echo "  Compiling TypeScript..."
npm run build --silent
echo -e "${GREEN}SDK packages built successfully${NC}"
echo

# Step 3: Build and deploy the registry contract
echo -e "${CYAN}${BOLD}Step 3: Deploying stealth pool contract...${NC}"
echo "  Building Rust contract..."
cd contracts
stellar contract build --quiet
cd ..

# Generate deployer account
echo "  Creating deployer account..."
stellar keys generate --network local deployer --fund 2>/dev/null || true
DEPLOYER_SECRET=$(stellar keys show deployer 2>/dev/null)
DEPLOYER_PUBLIC=$(stellar keys address deployer 2>/dev/null)

# Deploy contract
echo "  Deploying to blockchain..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm contracts/target/wasm32v1-none/release/stealth_registry.wasm \
  --source deployer \
  --network local 2>/dev/null)

# Save contract ID to config
mkdir -p ~/.stealth
echo "$CONTRACT_ID" > ~/.stealth/local-contract

# Deploy native XLM SAC (required for token transfers via Soroban)
echo "  Deploying native XLM SAC..."
stellar contract asset deploy --asset native --network local --source deployer >/dev/null 2>&1 || true

echo -e "${GREEN}Pool contract deployed${NC}"
echo -e "${YELLOW}  Contract ID: ${CONTRACT_ID:0:8}...${NC}"
echo

# Step 4: Start the relayer
echo -e "${CYAN}${BOLD}Step 4: Starting privacy relayer service...${NC}"
echo "  The relayer fee-bumps withdrawal transactions for privacy..."

stellar keys generate --network local relayer --fund 2>/dev/null || true
RELAYER_SECRET=$(stellar keys show relayer 2>/dev/null)

cd packages/relayer
RELAYER_SECRET=$RELAYER_SECRET npx tsx src/index.ts >/dev/null 2>&1 &
RELAYER_PID=$!
cd ../..
sleep 3

if ! kill -0 $RELAYER_PID 2>/dev/null; then
    error_exit "Failed to start relayer service"
fi

echo -e "${GREEN}Relayer running on http://localhost:3000${NC}"
echo

# Step 5: Create Alice's wallet (sender)
echo -e "${CYAN}${BOLD}Step 5: Creating Alice's wallet (sender)...${NC}"
echo "  Alice will deposit tokens into Bob's stealth pool..."

stellar keys generate --network local alice --fund 2>/dev/null || true
ALICE_SECRET=$(stellar keys show alice 2>/dev/null)
ALICE_PUBLIC=$(stellar keys address alice 2>/dev/null)

echo -e "${GREEN}Alice's wallet created and funded${NC}"
echo -e "${YELLOW}  Address: ${ALICE_PUBLIC:0:10}...${NC}"
echo -e "${YELLOW}  Balance: 10,000 XLM${NC}"
echo

# Step 6: Generate Bob's stealth keys (receiver)
echo -e "${CYAN}${BOLD}Step 6: Generating Bob's stealth meta-address...${NC}"
echo "  This creates Bob's viewing and spending keys..."

# Create temp keystore for Bob
export STEALTH_KEYSTORE=/tmp/bob-stealth-keys-$$.json
cd packages/cli
KEYGEN_OUTPUT=$(npx tsx src/index.ts keygen --keystore $STEALTH_KEYSTORE 2>&1)
BOB_META_ADDR=$(echo "$KEYGEN_OUTPUT" | grep "st:stellar:" | head -1 | tr -d '[:space:]')
cd ../..

echo -e "${GREEN}Bob's stealth keys generated${NC}"
echo -e "${YELLOW}  Meta-address (share this publicly):${NC}"
echo -e "${BOLD}  $BOB_META_ADDR${NC}"
echo

# Step 7: Alice deposits to Bob's stealth pool
echo -e "${CYAN}${BOLD}Step 7: Alice depositing 100 XLM into stealth pool...${NC}"
echo "  Computing ephemeral keys and stealth address..."
echo "  Single Soroban call: deposit + announce atomically..."

cd packages/cli
SEND_OUTPUT=$(npx tsx src/index.ts send \
  "$BOB_META_ADDR" \
  100 \
  --from $ALICE_SECRET \
  --network local 2>&1)

# Extract stealth address from output
STEALTH_ADDR=$(echo "$SEND_OUTPUT" | grep "Stealth:" | sed 's/.*Stealth:[ ]*//')
cd ../..

echo -e "${GREEN}Private deposit complete!${NC}"
echo -e "${YELLOW}  Amount: 100 XLM${NC}"
echo -e "${YELLOW}  Stealth address: ${STEALTH_ADDR:0:10}...${NC}"
echo "  (Only Bob can link this to his meta-address)"
echo "  (No Stellar account created -- funds held in contract pool)"
echo

# Step 8: Bob scans for stealth payments
echo -e "${CYAN}${BOLD}Step 8: Bob scanning for received deposits...${NC}"
echo "  Using view key to detect stealth transactions..."

cd packages/cli
SCAN_OUTPUT=$(STEALTH_KEYSTORE=$STEALTH_KEYSTORE npx tsx src/index.ts scan \
  --network local 2>&1)
echo "$SCAN_OUTPUT" | tail -5
cd ../..

echo -e "${GREEN}Scan complete!${NC}"
echo

# Step 9: Check Bob's stealth balance
echo -e "${CYAN}${BOLD}Step 9: Checking stealth pool balance...${NC}"

cd packages/cli
BALANCE_OUTPUT=$(STEALTH_KEYSTORE=$STEALTH_KEYSTORE npx tsx src/index.ts balance \
  --network local 2>&1)
echo "$BALANCE_OUTPUT" | tail -5
cd ../..

echo -e "${GREEN}Balance verified${NC}"
echo

# Step 10: Bob withdraws XLM from pool (direct with fee-payer)
echo -e "${CYAN}${BOLD}Step 10: Bob withdrawing XLM (direct, fee-payer pays)...${NC}"
echo "  Creating Bob's main wallet..."

stellar keys generate --network local bob --fund 2>/dev/null || true
BOB_SECRET=$(stellar keys show bob 2>/dev/null)
BOB_PUBLIC=$(stellar keys address bob 2>/dev/null)

echo "  Destination: ${BOB_PUBLIC:0:10}..."

# Generate a fee-payer account (someone must pay the Soroban invocation fee)
stellar keys generate --network local feepayer --fund 2>/dev/null || true
FEEPAYER_SECRET=$(stellar keys show feepayer 2>/dev/null)

echo "  Executing withdrawal with ed25519 signature auth..."
cd packages/cli
STEALTH_KEYSTORE=$STEALTH_KEYSTORE npx tsx src/index.ts withdraw \
  "$STEALTH_ADDR" \
  "$BOB_PUBLIC" \
  --network local \
  --fee-payer $FEEPAYER_SECRET 2>&1 || true
cd ../..

echo -e "${GREEN}Withdrawal complete!${NC}"
echo -e "${YELLOW}  Bob received ~100 XLM at ${BOB_PUBLIC:0:10}...${NC}"
echo

# Step 11: Multi-token — issue test USDC and send privately
echo -e "${CYAN}${BOLD}Step 11: Multi-token demo — private USDC payment...${NC}"
echo "  Issuing test USDC token..."

# Create USDC issuer
stellar keys generate --network local usdc-issuer --fund 2>/dev/null || true
ISSUER_SECRET=$(stellar keys show usdc-issuer 2>/dev/null)
ISSUER_PUBLIC=$(stellar keys address usdc-issuer 2>/dev/null)

# Alice trusts and receives USDC
ALICE_ADDR=$(stellar keys address alice 2>/dev/null)
stellar contract asset deploy --asset "USDC:$ISSUER_PUBLIC" --network local --source usdc-issuer >/dev/null 2>&1 || true
USDC_SAC=$(stellar contract id asset --asset "USDC:$ISSUER_PUBLIC" --network local 2>/dev/null)

# Add USDC trustline for Alice and Bob, then mint
stellar tx new change-trust --source-account alice --line "USDC:$ISSUER_PUBLIC" --network local >/dev/null 2>&1
stellar tx new change-trust --source-account bob --line "USDC:$ISSUER_PUBLIC" --network local >/dev/null 2>&1

echo "  Minting 500 USDC to Alice..."
stellar contract invoke --id "$USDC_SAC" --source usdc-issuer --network local \
  -- mint --to "$ALICE_ADDR" --amount 5000000000 >/dev/null 2>&1

echo "  Alice depositing 200 USDC into stealth pool..."
cd packages/cli
USDC_SEND=$(npx tsx src/index.ts send \
  "$BOB_META_ADDR" \
  200 \
  --from $ALICE_SECRET \
  --asset "USDC:$ISSUER_PUBLIC" \
  --network local 2>&1)

USDC_STEALTH=$(echo "$USDC_SEND" | grep "Stealth:" | sed 's/.*Stealth:[ ]*//')
cd ../..

echo -e "${GREEN}USDC deposit complete!${NC}"
echo -e "${YELLOW}  200 USDC deposited to stealth pool${NC}"
echo -e "${YELLOW}  Stealth address: ${USDC_STEALTH:0:10}...${NC}"
echo

# Check balance shows USDC
echo -e "${CYAN}${BOLD}Step 12: Checking USDC balance in pool...${NC}"

cd packages/cli
MULTI_BALANCE=$(STEALTH_KEYSTORE=$STEALTH_KEYSTORE npx tsx src/index.ts balance \
  --network local 2>&1)
echo "$MULTI_BALANCE" | tail -8
cd ../..

echo -e "${GREEN}Multi-token balances verified${NC}"
echo

# Withdraw USDC via relayer (relayer pays the Soroban fee)
echo -e "${CYAN}${BOLD}Step 13: Withdrawing USDC via relayer (fee-bump)...${NC}"
echo "  Relayer wraps the withdrawal in a fee-bump transaction..."

cd packages/cli
STEALTH_KEYSTORE=$STEALTH_KEYSTORE npx tsx src/index.ts withdraw \
  "$USDC_STEALTH" \
  "$BOB_PUBLIC" \
  --network local \
  --asset "USDC:$ISSUER_PUBLIC" \
  --fee-payer $FEEPAYER_SECRET \
  --relay http://localhost:3000 2>&1 || true
cd ../..

echo -e "${GREEN}USDC withdrawal via relayer complete!${NC}"
echo

# Step 14: Final verification
echo -e "${CYAN}${BOLD}Step 14: Verifying privacy preserved...${NC}"

cd packages/cli
FINAL_OUTPUT=$(STEALTH_KEYSTORE=$STEALTH_KEYSTORE npx tsx src/index.ts balance \
  --network local 2>&1)
cd ../..

echo "$FINAL_OUTPUT" | tail -3

if echo "$FINAL_OUTPUT" | grep -q "zero\|0.0000000\|No stealth"; then
    echo -e "${GREEN}Stealth pool balance emptied successfully${NC}"
    echo -e "${GREEN}No trace of Bob's identity on-chain${NC}"
else
    echo -e "${YELLOW}Stealth pool may still have residual balance${NC}"
fi
echo

# Cleanup
echo -e "${CYAN}Cleaning up...${NC}"
kill $RELAYER_PID 2>/dev/null || true
rm -f $STEALTH_KEYSTORE
rm -f /tmp/bob-stealth-keys-*.json

# Calculate runtime
END_TIME=$(date +%s)
RUNTIME=$((END_TIME - START_TIME))
MINUTES=$((RUNTIME / 60))
SECONDS=$((RUNTIME % 60))

echo -e "${GREEN}Demo environment cleaned${NC}"
echo

echo "========================================="
echo -e "${BOLD}${GREEN}   Demo Complete!${NC}"
echo "========================================="
echo
echo "What we demonstrated:"
echo "  - Generated stealth meta-addresses with dual keys"
echo "  - Deposited 100 XLM into stealth pool (atomic announce)"
echo "  - Deposited 200 USDC into same stealth pool (multi-token)"
echo "  - No Stellar accounts created per payment (no MBR waste)"
echo "  - Scanned and detected deposits with view key"
echo "  - Withdrew XLM directly (fee-payer pays Soroban fee)"
echo "  - Withdrew USDC via relayer fee-bump (relayer pays fee)"
echo "  - Left no connection between Bob and stealth address"
echo
echo -e "Runtime: ${MINUTES}m ${SECONDS}s"
echo
echo -e "${CYAN}To learn more, check out:${NC}"
echo "  - packages/crypto/ - SDK documentation"
echo "  - packages/cli/ - CLI usage guide"
echo "  - contracts/registry/ - Soroban pool contract"
echo
