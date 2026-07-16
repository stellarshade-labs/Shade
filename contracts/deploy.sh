#!/bin/bash

set -e

# Colors for output
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Default values
NETWORK="local"
SOURCE_ACCOUNT="deployer"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        --source)
            SOURCE_ACCOUNT="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --network <network>  Network to deploy to (default: local)"
            echo "  --source <account>   Source account for deployment (default: deployer)"
            echo "  --help              Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

echo
echo "========================================="
echo "   Stellar Stealth Registry Deployment"
echo "========================================="
echo
echo -e "${CYAN}Network: ${YELLOW}$NETWORK${NC}"
echo -e "${CYAN}Source account: ${YELLOW}$SOURCE_ACCOUNT${NC}"
echo

# Check prerequisites
command -v stellar >/dev/null 2>&1 || {
    echo -e "${RED}✗ Error: Stellar CLI is not installed${NC}" >&2
    echo "Install with: brew install stellar-cli"
    exit 1
}

# Build the contract from the cargo WORKSPACE root (contracts/), so the wasm lands
# in the workspace target dir (contracts/target/), matching demo.sh. Building from
# contracts/registry would still emit to contracts/target (workspace target), leaving
# the relative target/ path below pointing at a nonexistent registry/target.
cd "$(dirname "$0")"

if [[ ! -f "registry/Cargo.toml" ]]; then
    echo -e "${RED}✗ Error: Registry contract not found${NC}" >&2
    exit 1
fi

stellar contract build

if [[ ! -f "target/wasm32v1-none/release/stealth_registry.wasm" ]]; then
    echo -e "${RED}✗ Error: Contract build failed${NC}" >&2
    exit 1
fi

echo -e "${GREEN}✓ Contract built successfully${NC}"

# Generate the deployer key if missing, then fund it via friendbot. Funding is
# idempotent and covers BOTH fresh and pre-existing keys: a key can outlive a reset
# local network or the quarterly testnet reset, in which case `keys generate --fund`
# (a no-op when the key already exists) would leave the account unfunded and the
# upload fails with "Account not found". Mainnet has no friendbot — fund out-of-band.
if [[ "$NETWORK" == "local" || "$NETWORK" == "testnet" ]]; then
    echo -e "${CYAN}Ensuring deployer account exists and is funded...${NC}"
    stellar keys generate --network "$NETWORK" "$SOURCE_ACCOUNT" >/dev/null 2>&1 || true
    stellar keys fund "$SOURCE_ACCOUNT" --network "$NETWORK" >/dev/null 2>&1 || true
fi

# Get account info
SOURCE_PUBLIC=$(stellar keys address "$SOURCE_ACCOUNT" 2>/dev/null || echo "")
if [[ -z "$SOURCE_PUBLIC" ]]; then
    echo -e "${RED}✗ Error: Could not get address for account '$SOURCE_ACCOUNT'${NC}" >&2
    echo "Make sure the account exists: stellar keys generate $SOURCE_ACCOUNT"
    exit 1
fi

echo -e "${CYAN}Deploying from: ${YELLOW}${SOURCE_PUBLIC:0:10}...${NC}"

# Deploy the contract
echo -e "${CYAN}Deploying contract to $NETWORK...${NC}"
CONTRACT_ID=$(stellar contract deploy \
    --wasm target/wasm32v1-none/release/stealth_registry.wasm \
    --source "$SOURCE_ACCOUNT" \
    --network "$NETWORK")

if [[ -z "$CONTRACT_ID" ]]; then
    echo -e "${RED}✗ Error: Contract deployment failed${NC}" >&2
    exit 1
fi

echo -e "${GREEN}✓ Contract deployed successfully${NC}"
echo

# Save the contract ID where the CLI actually reads it: ~/.stealth/<network>-contract.
# getContractAddress() checks this path FIRST for both local and testnet; the old
# packages/cli/.stealth/<network>-contract path was only a local-only fallback, so a
# testnet id written there was never found and the CLI threw "no contract configured".
CONFIG_DIR="$HOME/.stealth"
mkdir -p "$CONFIG_DIR"
echo "$CONTRACT_ID" > "$CONFIG_DIR/${NETWORK}-contract"
echo -e "${GREEN}✓ Contract ID saved to $CONFIG_DIR/${NETWORK}-contract${NC}"

# Contract doesn't have an initialize function - removed unnecessary call

echo
echo "========================================="
echo "           Deployment Complete!"
echo "========================================="
echo
echo -e "${CYAN}Contract ID:${NC}"
echo -e "${GREEN}$CONTRACT_ID${NC}"
echo
echo -e "${CYAN}Network: ${YELLOW}$NETWORK${NC}"
echo -e "${CYAN}Deployer: ${YELLOW}$SOURCE_PUBLIC${NC}"
echo
echo "The contract ID has been saved to:"
echo "  $CONFIG_DIR/${NETWORK}-contract"
echo
echo "You can now use the CLI with this contract:"
echo "  npm run cli -- send --network $NETWORK ..."
echo