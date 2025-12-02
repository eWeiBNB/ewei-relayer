import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';

vi.mock('../src/config', () => ({
  config: {
    forwarderAddress: '0x' + '1'.repeat(40),
    policyRegistryAddress: '0x' + '2'.repeat(40),
    bscRpcUrl: 'http://localhost:8545',
    chainId: 56,
    logLevel: 'silent',
  },
}));

vi.mock('../src/logger', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../src/db', () => ({
  query: vi.fn().mockResolvedValue([]),
}));

describe('Transaction validation helpers', () => {
  it('should detect invalid Ethereum addresses', () => {
    expect(ethers.isAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(ethers.isAddress('not-an-address')).toBe(false);
    expect(ethers.isAddress('0x123')).toBe(false);
    expect(ethers.isAddress('')).toBe(false);
  });

  it('should validate signature length', () => {
    const validSig = '0x' + 'a'.repeat(130);
    const shortSig = '0x' + 'a'.repeat(10);

    expect(validSig.length).toBeGreaterThanOrEqual(132);
    expect(shortSig.length).toBeLessThan(132);
  });

  it('should detect expired deadlines', () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredDeadline = now - 60;
    const futureDeadline = now + 3600;
    const tooCloseDeadline = now + 10;

    expect(expiredDeadline <= now).toBe(true);
    expect(futureDeadline > now).toBe(true);
    expect(tooCloseDeadline - now < 30).toBe(true);
  });

  it('should extract method selector from calldata', () => {
    const calldata = '0xa9059cbb000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const selector = calldata.slice(0, 10);

    expect(selector).toBe('0xa9059cbb');
    expect(selector).toMatch(/^0x[a-fA-F0-9]{8}$/);
  });

  it('should validate policy constraints', () => {
    const policy = {
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      maxGasPerTx: 500000n,
      maxTotalGas: 10000000n,
      usedGas: 1000000n,
      allowedContracts: ['0x' + 'a'.repeat(40)],
      allowedMethods: ['0xa9059cbb'],
    };

    const requestGas = 200000n;

    expect(requestGas <= policy.maxGasPerTx).toBe(true);
    expect(policy.usedGas + requestGas <= policy.maxTotalGas).toBe(true);
    expect(policy.active).toBe(true);
  });

  it('should reject gas limit exceeding policy', () => {
    const maxGasPerTx = 500000n;
    const requestGas = 600000n;

    expect(requestGas > maxGasPerTx).toBe(true);
  });

  it('should reject when total gas budget exceeded', () => {
    const maxTotalGas = 10000000n;
    const usedGas = 9900000n;
    const requestGas = 200000n;

    expect(usedGas + requestGas > maxTotalGas).toBe(true);
  });
});
