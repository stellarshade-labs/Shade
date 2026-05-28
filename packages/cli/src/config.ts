export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string | null;
  networkPassphrase: string;
}

export const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  local: {
    name: 'local',
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    horizonUrl: 'http://localhost:8000',
    friendbotUrl: 'http://localhost:8000/friendbot',
    networkPassphrase: 'Standalone Network ; February 2017'
  },
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015'
  }
};

export function getNetworkConfig(network: string): NetworkConfig {
  const config = NETWORK_CONFIGS[network];
  if (!config) {
    throw new Error(`Unknown network: ${network}. Valid options are: ${Object.keys(NETWORK_CONFIGS).join(', ')}`);
  }
  return config;
}