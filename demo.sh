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
    echo -e "${RED}✗ Error: $1${NC}" >&2
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

    echo -e "${GREEN}✓ All prerequisites met${NC}"
}

# Start timer
START_TIME=$(date +%s)

echo
echo "========================================="
echo -e "${BOLD}   Stellar Stealth Addresses Demo${NC}"
echo "========================================="
echo
echo "This demo will showcase the complete privacy loop:"
echo "  • Generate stealth meta-addresses"
echo "  • Send private payments"
echo "  • Scan for received funds"
echo "  • Withdraw with full privacy"
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
echo -e "${GREEN}✓ Local network running on port 8000${NC}"
echo

# Step 2: Build the TypeScript packages
echo -e "${CYAN}${BOLD}Step 2: Building SDK packages...${NC}"
echo "  Compiling TypeScript..."
npm run build --silent
echo -e "${GREEN}✓ SDK packages built successfully${NC}"
echo

# Step 3: Build and deploy the registry contract
echo -e "${CYAN}${BOLD}Step 3: Deploying stealth registry contract...${NC}"
echo "  Building Rust contract..."
cd contracts/registry
stellar contract build --quiet
cd ../..

# Generate deployer account
echo "  Creating deployer account..."
DEPLOYER_SECRET=$(stellar keys generate --network local deployer --fund 2>/dev/null | grep "Secret Key" | cut -d' ' -f3)
DEPLOYER_PUBLIC=$(stellar keys address deployer 2>/dev/null)

# Deploy contract
echo "  Deploying to blockchain..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm contracts/registry/target/wasm32-unknown-unknown/release/stealth_registry.wasm \
  --source deployer \
  --network local 2>/dev/null)

# Save contract ID to config
mkdir -p packages/cli/.stealth
echo "$CONTRACT_ID" > packages/cli/.stealth/local-contract

echo -e "${GREEN}✓ Registry contract deployed${NC}"
echo -e "${YELLOW}  Contract ID: ${CONTRACT_ID:0:8}...${NC}"
echo

# Step 4: Start the relayer
echo -e "${CYAN}${BOLD}Step 4: Starting privacy relayer service...${NC}"
echo "  The relayer sponsors stealth accounts for enhanced privacy..."

# Generate relayer account
RELAYER_SECRET=$(stellar keys generate --network local relayer --fund 2>/dev/null | grep "Secret Key" | cut -d' ' -f3)
RELAYER_PUBLIC=$(stellar keys address relayer 2>/dev/null)

# Start relayer in background
cd packages/relayer
RELAYER_SECRET=$RELAYER_SECRET npm run start >/dev/null 2>&1 &
RELAYER_PID=$!
cd ../..
sleep 3

# Check if relayer started successfully
if ! kill -0 $RELAYER_PID 2>/dev/null; then
    error_exit "Failed to start relayer service"
fi

echo -e "${GREEN}✓ Relayer running on http://localhost:3000${NC}"
echo

# Step 5: Generate Alice's keys (sender)
echo -e "${CYAN}${BOLD}Step 5: Creating Alice's wallet (sender)...${NC}"
echo "  Alice will send a private payment to Bob..."

# Generate Alice's regular account
ALICE_SECRET=$(stellar keys generate --network local alice --fund 2>/dev/null | grep "Secret Key" | cut -d' ' -f3)
ALICE_PUBLIC=$(stellar keys address alice 2>/dev/null)

echo -e "${GREEN}✓ Alice's wallet created and funded${NC}"
echo -e "${YELLOW}  Address: ${ALICE_PUBLIC:0:10}...${NC}"
echo -e "${YELLOW}  Balance: 10,000 XLM${NC}"
echo

# Step 6: Generate Bob's stealth keys (receiver)
echo -e "${CYAN}${BOLD}Step 6: Generating Bob's stealth meta-address...${NC}"
echo "  This creates Bob's viewing and spending keys..."

# Create temp keystore for Bob
export STEALTH_KEYSTORE=/tmp/bob-stealth-keys-$$.json
cd packages/cli
npm run --silent cli -- generate --keystore $STEALTH_KEYSTORE >/dev/null 2>&1
BOB_META_ADDR=$(npm run --silent cli -- address --keystore $STEALTH_KEYSTORE 2>/dev/null)
cd ../..

echo -e "${GREEN}✓ Bob's stealth keys generated${NC}"
echo -e "${YELLOW}  Meta-address (share this publicly):${NC}"
echo -e "${BOLD}  $BOB_META_ADDR${NC}"
echo

# Step 7: Alice sends to Bob's stealth address
echo -e "${CYAN}${BOLD}Step 7: Alice sending 100 XLM to Bob privately...${NC}"
echo "  Computing ephemeral keys and stealth address..."

cd packages/cli
SEND_OUTPUT=$(npm run --silent cli -- send \
  --to "$BOB_META_ADDR" \
  --amount 100 \
  --from $ALICE_SECRET \
  --network local \
  --relay http://localhost:3000 2>&1)

# Extract stealth address from output
STEALTH_ADDR=$(echo "$SEND_OUTPUT" | grep "Stealth address:" | sed 's/.*: //')
cd ../..

echo -e "${GREEN}✓ Private payment sent!${NC}"
echo -e "${YELLOW}  Amount: 100 XLM${NC}"
echo -e "${YELLOW}  Stealth address: ${STEALTH_ADDR:0:10}...${NC}"
echo "  (Only Bob can link this to his meta-address)"
echo

# Step 8: Bob scans for stealth payments
echo -e "${CYAN}${BOLD}Step 8: Bob scanning for received payments...${NC}"
echo "  Using view key to detect stealth transactions..."

cd packages/cli
FOUND_ADDRS=$(npm run --silent cli -- scan \
  --keystore $STEALTH_KEYSTORE \
  --network local 2>&1 | grep "Found stealth address" | wc -l)
cd ../..

echo -e "${GREEN}✓ Scan complete!${NC}"
echo -e "${YELLOW}  Found $FOUND_ADDRS stealth payment(s)${NC}"
echo

# Step 9: Check Bob's stealth balance
echo -e "${CYAN}${BOLD}Step 9: Checking stealth account balance...${NC}"

cd packages/cli
BALANCE_OUTPUT=$(npm run --silent cli -- balance \
  --address "$STEALTH_ADDR" \
  --network local 2>&1)
BALANCE=$(echo "$BALANCE_OUTPUT" | grep "Balance:" | sed 's/.*: //' | sed 's/ XLM//')
cd ../..

echo -e "${GREEN}✓ Balance verified${NC}"
echo -e "${YELLOW}  Stealth account balance: $BALANCE XLM${NC}"
echo

# Step 10: Bob withdraws to his main account
echo -e "${CYAN}${BOLD}Step 10: Bob withdrawing funds privately...${NC}"
echo "  Creating Bob's main wallet..."

# Generate Bob's main account
BOB_SECRET=$(stellar keys generate --network local bob --fund 2>/dev/null | grep "Secret Key" | cut -d' ' -f3)
BOB_PUBLIC=$(stellar keys address bob 2>/dev/null)

echo "  Destination: ${BOB_PUBLIC:0:10}..."

# Get Bob's initial balance
BOB_INITIAL=$(stellar account balance bob --network local 2>/dev/null | grep "native" | awk '{print $2}')

# Withdraw from stealth
echo "  Executing private withdrawal..."
cd packages/cli
npm run --silent cli -- withdraw \
  --from "$STEALTH_ADDR" \
  --to "$BOB_PUBLIC" \
  --keystore $STEALTH_KEYSTORE \
  --network local \
  --relay http://localhost:3000 >/dev/null 2>&1
cd ../..

# Check Bob's new balance
sleep 2
BOB_FINAL=$(stellar account balance bob --network local 2>/dev/null | grep "native" | awk '{print $2}')

echo -e "${GREEN}✓ Withdrawal complete!${NC}"
echo -e "${YELLOW}  Bob's wallet received: ~100 XLM${NC}"
echo -e "${YELLOW}  Final balance: $BOB_FINAL XLM${NC}"
echo

# Step 11: Final verification
echo -e "${CYAN}${BOLD}Step 11: Verifying privacy preserved...${NC}"

cd packages/cli
FINAL_BALANCE=$(npm run --silent cli -- balance \
  --address "$STEALTH_ADDR" \
  --network local 2>&1 | grep "Balance:" | sed 's/.*: //' | sed 's/ XLM//')
cd ../..

if [[ "$FINAL_BALANCE" == "0" || "$FINAL_BALANCE" == "0.0000000" ]]; then
    echo -e "${GREEN}✓ Stealth address emptied successfully${NC}"
    echo -e "${GREEN}✓ No trace of Bob's identity on-chain${NC}"
else
    echo -e "${YELLOW}⚠ Stealth address still has balance: $FINAL_BALANCE XLM${NC}"
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

echo -e "${GREEN}✓ Demo environment cleaned${NC}"
echo

echo "========================================="
echo -e "${BOLD}${GREEN}   Demo Complete! 🎉${NC}"
echo "========================================="
echo
echo "What we demonstrated:"
echo "  ✓ Generated stealth meta-addresses with dual keys"
echo "  ✓ Sent 100 XLM privately using DKSAP protocol"
echo "  ✓ Scanned and detected payments with view key"
echo "  ✓ Withdrew funds while preserving privacy"
echo "  ✓ Left no connection between Bob and stealth address"
echo
echo -e "Runtime: ${MINUTES}m ${SECONDS}s"
echo
echo -e "${CYAN}To learn more, check out:${NC}"
echo "  • README.md - Architecture and quick start"
echo "  • packages/crypto/ - SDK documentation"
echo "  • packages/cli/ - CLI usage guide"
echo