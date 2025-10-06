import dotenv from 'dotenv';
import { RelayerConfig } from './types';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export function loadConfig(): RelayerConfig {
  return {
    port: parseInt(optional('PORT', '3100'), 10),
    logLevel: optional('LOG_LEVEL', 'info'),

    bscRpcUrl: required('BSC_RPC_URL'),
    bscRpcUrlFallback: optional('BSC_RPC_URL_FALLBACK', ''),
    chainId: parseInt(optional('BSC_CHAIN_ID', '56'), 10),

    relayerPrivateKey: required('RELAYER_PRIVATE_KEY'),
    minBalanceThreshold: optional('MIN_BALANCE_THRESHOLD', '0.05'),
    maxGasPriceGwei: parseInt(optional('MAX_GAS_PRICE_GWEI', '10'), 10),

    forwarderAddress: required('EWEI_FORWARDER_ADDRESS'),
    policyRegistryAddress: required('EWEI_POLICY_REGISTRY_ADDRESS'),
    stakingAddress: optional('EWEI_STAKING_ADDRESS', ''),

    databaseUrl: required('DATABASE_URL'),
    dbPoolMin: parseInt(optional('DB_POOL_MIN', '2'), 10),
    dbPoolMax: parseInt(optional('DB_POOL_MAX', '10'), 10),

    redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),
    redisKeyPrefix: optional('REDIS_KEY_PREFIX', 'ewei:relayer:'),

    apiKeys: optional('API_KEYS', '')
      .split(',')
      .filter(Boolean),
    apiKeysFromDb: optional('API_KEYS_FROM_DB', 'true') === 'true',

    rateLimitWindowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    rateLimitMaxRequests: parseInt(optional('RATE_LIMIT_MAX_REQUESTS', '100'), 10),

    metricsEnabled: optional('METRICS_ENABLED', 'true') === 'true',
    metricsPort: parseInt(optional('METRICS_PORT', '9090'), 10),
    healthCheckIntervalMs: parseInt(optional('HEALTH_CHECK_INTERVAL_MS', '30000'), 10),

    webhookTimeoutMs: parseInt(optional('WEBHOOK_TIMEOUT_MS', '5000'), 10),
    webhookMaxRetries: parseInt(optional('WEBHOOK_MAX_RETRIES', '3'), 10),

    gasOracleUpdateIntervalMs: parseInt(optional('GAS_ORACLE_UPDATE_INTERVAL_MS', '12000'), 10),
    gasPriceBumpPercent: parseInt(optional('GAS_PRICE_BUMP_PERCENT', '10'), 10),
    gasSpikeThresholdGwei: parseInt(optional('GAS_SPIKE_THRESHOLD_GWEI', '8'), 10),
  };
}

export const config = loadConfig();
