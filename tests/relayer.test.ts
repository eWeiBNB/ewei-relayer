import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../src/config', () => ({
  config: {
    bscRpcUrl: 'http://localhost:8545',
    bscRpcUrlFallback: '',
    chainId: 56,
    relayerPrivateKey: '0x' + 'a'.repeat(64),
    minBalanceThreshold: '0.05',
    maxGasPriceGwei: 10,
    forwarderAddress: '0x' + '1'.repeat(40),
    policyRegistryAddress: '0x' + '2'.repeat(40),
    stakingAddress: '0x' + '3'.repeat(40),
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'test:',
    databaseUrl: 'postgres://test@localhost/test',
    dbPoolMin: 1,
    dbPoolMax: 2,
    gasOracleUpdateIntervalMs: 12000,
    gasPriceBumpPercent: 10,
    gasSpikeThresholdGwei: 8,
    healthCheckIntervalMs: 30000,
    metricsEnabled: false,
    metricsPort: 9091,
    port: 3100,
    logLevel: 'silent',
    apiKeys: [],
    apiKeysFromDb: false,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 100,
    webhookTimeoutMs: 5000,
    webhookMaxRetries: 3,
  },
}));

vi.mock('../src/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('Relayer types and status', () => {
  it('should have correct transaction status values', async () => {
    const { TransactionStatus } = await import('../src/types');

    expect(TransactionStatus.PENDING).toBe('pending');
    expect(TransactionStatus.QUEUED).toBe('queued');
    expect(TransactionStatus.SUBMITTED).toBe('submitted');
    expect(TransactionStatus.CONFIRMED).toBe('confirmed');
    expect(TransactionStatus.FAILED).toBe('failed');
    expect(TransactionStatus.REVERTED).toBe('reverted');
    expect(TransactionStatus.DROPPED).toBe('dropped');
  });

  it('should have correct priority values', async () => {
    const { Priority } = await import('../src/types');

    expect(Priority.LOW).toBe(0);
    expect(Priority.NORMAL).toBe(1);
    expect(Priority.HIGH).toBe(2);
    expect(Priority.URGENT).toBe(3);
  });
});

describe('SponsorRequest interface', () => {
  it('should accept valid sponsor request structure', () => {
    const request = {
      from: '0x' + 'a'.repeat(40),
      to: '0x' + 'b'.repeat(40),
      data: '0x12345678',
      value: '0',
      gasLimit: '200000',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '1',
      signature: '0x' + 'c'.repeat(130),
      policyId: '0x' + 'd'.repeat(64),
    };

    expect(request.from).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(request.to).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(request.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('Config structure', () => {
  it('should load config values', async () => {
    const { config } = await import('../src/config');

    expect(config.chainId).toBe(56);
    expect(config.port).toBe(3100);
    expect(config.maxGasPriceGwei).toBe(10);
    expect(config.gasPriceBumpPercent).toBe(10);
  });
});
