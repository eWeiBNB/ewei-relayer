import { BigNumberish } from 'ethers';

/** Status of a sponsored transaction throughout its lifecycle */
export enum TransactionStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  REVERTED = 'reverted',
  DROPPED = 'dropped',
}

/** Priority levels for transaction ordering */
export enum Priority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  URGENT = 3,
}

/** A sponsored meta-transaction request from the SDK */
export interface SponsorRequest {
  /** The original sender (who doesn't pay gas) */
  from: string;
  /** Target contract address */
  to: string;
  /** Encoded calldata */
  data: string;
  /** Value to forward (usually 0 for sponsored txs) */
  value: BigNumberish;
  /** Gas limit for the inner call */
  gasLimit: BigNumberish;
  /** Deadline timestamp (unix seconds) */
  deadline: number;
  /** Nonce from the Forwarder contract */
  nonce: BigNumberish;
  /** EIP-712 signature from the sender */
  signature: string;
  /** Policy ID governing sponsorship rules */
  policyId: string;
}

/** Internal representation of a queued transaction */
export interface QueuedTransaction {
  id: string;
  request: SponsorRequest;
  priority: Priority;
  createdAt: number;
  attempts: number;
  lastAttemptAt?: number;
  txHash?: string;
  status: TransactionStatus;
  apiKeyId: string;
  webhookUrl?: string;
}

/** Result of submitting a transaction to the chain */
export interface SubmissionResult {
  txHash: string;
  nonce: number;
  gasPrice: bigint;
  timestamp: number;
}

/** Gas price estimation with confidence levels */
export interface GasEstimate {
  /** Safe low - will confirm eventually */
  safeLow: bigint;
  /** Standard - confirms within a few blocks */
  standard: bigint;
  /** Fast - next block confirmation likely */
  fast: bigint;
  /** Base fee from latest block */
  baseFee: bigint;
  /** Whether gas prices are spiking */
  isSpiking: boolean;
  /** Timestamp of this estimate */
  updatedAt: number;
}

/** Policy configuration from the registry contract */
export interface SponsorPolicy {
  id: string;
  sponsor: string;
  maxGasPerTx: bigint;
  maxTotalGas: bigint;
  usedGas: bigint;
  allowedContracts: string[];
  allowedMethods: string[];
  active: boolean;
  expiresAt: number;
}

/** API key record stored in the database */
export interface ApiKey {
  id: string;
  key: string;
  name: string;
  sponsorAddress: string;
  rateLimit: number;
  active: boolean;
  createdAt: Date;
  lastUsedAt?: Date;
}

/** Webhook registration for transaction notifications */
export interface Webhook {
  id: string;
  apiKeyId: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  active: boolean;
}

export type WebhookEvent =
  | 'tx.submitted'
  | 'tx.confirmed'
  | 'tx.failed'
  | 'tx.reverted';

/** Health check response */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  wallet: {
    address: string;
    balance: string;
    nonce: number;
  };
  queue: {
    pending: number;
    processing: number;
  };
  redis: boolean;
  database: boolean;
  rpc: boolean;
  lastBlock: number;
  gasPrice: string;
}

/** Relayer node configuration */
export interface RelayerConfig {
  port: number;
  logLevel: string;
  bscRpcUrl: string;
  bscRpcUrlFallback: string;
  chainId: number;
  relayerPrivateKey: string;
  minBalanceThreshold: string;
  maxGasPriceGwei: number;
  forwarderAddress: string;
  policyRegistryAddress: string;
  stakingAddress: string;
  databaseUrl: string;
  dbPoolMin: number;
  dbPoolMax: number;
  redisUrl: string;
  redisKeyPrefix: string;
  apiKeys: string[];
  apiKeysFromDb: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  metricsEnabled: boolean;
  metricsPort: number;
  healthCheckIntervalMs: number;
  webhookTimeoutMs: number;
  webhookMaxRetries: number;
  gasOracleUpdateIntervalMs: number;
  gasPriceBumpPercent: number;
  gasSpikeThresholdGwei: number;
}
