#!/bin/bash

set -e

echo "========================================="
echo "   Stellar Stealth Addresses Demo"
echo "========================================="
echo

# Colors for output
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Ensure local Stellar network is running
echo -e "${CYAN}Step 1: Starting local Stellar network...${NC}"
docker compose up -d
sleep 5
echo -e "${GREEN}✓ Local network running${NC}"
echo

# Step 2: Build the TypeScript packages
echo -e "${CYAN}Step 2: Building packages...${NC}"
npm run build
echo -e "${GREEN}✓ Packages built${NC}"
echo

# Step 3: Build and deploy the registry contract
echo -e "${CYAN}Step 3: Building and deploying registry contract...${NC}"
cd contracts/registry
stellar contract build
cd ../..

# Generate deployer account
DEPLOYER_SECRET=$(stellar keys generate --network local deployer --fund | grep "Secret Key" | cut -d' ' -f3)
DEPLOYER_PUBLIC=$(stellar keys address deployer)
echo "  Deployer: $DEPLOYER_PUBLIC"

# Deploy contract
CONTRACT_ID=$(stellar contract deploy \
  --wasm contracts/registry/target/wasm32-unknown-unknown/release/stealth_registry.wasm \
  --source deployer \
  --network local)
echo "  Contract: $CONTRACT_ID"

# Save contract ID to config
mkdir -p packages/cli/.stealth
echo "$CONTRACT_ID" > packages/cli/.stealth/local-contract

echo -e "${GREEN}✓ Contract deployed${NC}"
echo

# Step 4: Start the relayer
echo -e "${CYAN}Step 4: Starting relayer service...${NC}"

# Generate relayer account
RELAYER_SECRET=$(stellar keys generate --network local relayer --fund | grep "Secret Key" | cut -d' ' -f3)
RELAYER_PUBLIC=$(stellar keys address relayer)
echo "  Relayer: $RELAYER_PUBLIC"

# Start relayer in background
cd packages/relayer
RELAYER_SECRET=$RELAYER_SECRET npm run start &
RELAYER_PID=$!
cd ../..
sleep 3
echo -e "${GREEN}✓ Relayer running on port 3000${NC}"
echo

# Step 5: Generate Alice's keys (sender)
echo -e "${CYAN}Step 5: Setting up Alice (sender)...${NC}"

# Generate Alice's regular account
ALICE_SECRET=$(stellar keys generate --network local alice --fund | grep "Secret Key" | cut -d' ' -f3)
ALICE_PUBLIC=$(stellar keys address alice)
echo "  Alice's address: $ALICE_PUBLIC"
echo -e "${GREEN}✓ Alice funded with 10,000 XLM${NC}"
echo

# Step 6: Generate Bob's stealth keys (receiver)
echo -e "${CYAN}Step 6: Setting up Bob's stealth keys...${NC}"

# Create temp keystore for Bob
export STEALTH_KEYSTORE=/tmp/bob-stealth-keys.json
cd packages/cli
npm run cli -- keygen --keystore $STEALTH_KEYSTORE
BOB_META_ADDR=$(npm run --silent cli -- keygen --keystore $STEALTH_KEYSTORE | grep -A1 "Meta-address" | tail -n1)
cd ../..
echo "  Bob's meta-address:"
echo -e "${YELLOW}  $BOB_META_ADDR${NC}"
echo -e "${GREEN}✓ Bob's stealth keys generated${NC}"
echo

# Step 7: Alice sends to Bob's stealth address
echo -e "${CYAN}Step 7: Alice sending 100 XLM to Bob's stealth address...${NC}"
cd packages/cli
npm run cli -- send "$BOB_META_ADDR" 100 \
  --from $ALICE_SECRET \
  --network local \
  --relay http://localhost:3000
cd ../..
echo -e "${GREEN}✓ Payment sent and announced${NC}"
echo

# Step 8: Bob scans for stealth addresses
echo -e "${CYAN}Step 8: Bob scanning for stealth addresses...${NC}"
cd packages/cli
STEALTH_ADDR=$(npm run --silent cli -- scan --network local | grep "^G" | head -n1 | awk '{print $1}')
cd ../..
echo "  Found stealth address: $STEALTH_ADDR"
echo -e "${GREEN}✓ Stealth address discovered${NC}"
echo

# Step 9: Check Bob's stealth balance
echo -e "${CYAN}Step 9: Checking Bob's stealth balance...${NC}"
cd packages/cli
npm run cli -- balance --network local
cd ../..
echo -e "${GREEN}✓ Balance confirmed${NC}"
echo

# Step 10: Bob withdraws to his main account
echo -e "${CYAN}Step 10: Bob withdrawing funds from stealth address...${NC}"

# Generate Bob's main account
BOB_SECRET=$(stellar keys generate --network local bob --fund | grep "Secret Key" | cut -d' ' -f3)
BOB_PUBLIC=$(stellar keys address bob)
echo "  Bob's main address: $BOB_PUBLIC"

# Get Bob's initial balance
BOB_INITIAL=$(stellar account balance bob --network local | grep "native" | awk '{print $2}')
echo "  Bob's initial balance: $BOB_INITIAL XLM"

# Withdraw from stealth
cd packages/cli
npm run cli -- withdraw "$STEALTH_ADDR" "$BOB_PUBLIC" \
  --network local \
  --relay http://localhost:3000
cd ../..

# Check Bob's new balance
sleep 2
BOB_FINAL=$(stellar account balance bob --network local | grep "native" | awk '{print $2}')
echo "  Bob's final balance: $BOB_FINAL XLM"
echo -e "${GREEN}✓ Funds withdrawn successfully${NC}"
echo

# Step 11: Final verification
echo -e "${CYAN}Step 11: Final verification...${NC}"
cd packages/cli
echo "  Scanning again (should show 0 balance):"
npm run cli -- balance --network local
cd ../..
echo -e "${GREEN}✓ Privacy loop complete!${NC}"
echo

# Cleanup
echo -e "${CYAN}Cleaning up...${NC}"
kill $RELAYER_PID 2>/dev/null || true
rm -f $STEALTH_KEYSTORE
echo -e "${GREEN}✓ Demo completed successfully${NC}"
echo

echo "========================================="
echo "   Demo Complete!"
echo "========================================="
echo "This demo demonstrated:"
echo "  1. Key generation for stealth addresses"
echo "  2. Sending funds to a stealth address"
echo "  3. Scanning for received payments"
echo "  4. Checking stealth balances"
echo "  5. Withdrawing from stealth addresses"
echo "  6. Complete privacy preservation"
echo