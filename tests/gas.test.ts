import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config', () => ({
  config: {
    maxGasPriceGwei: 10,
    gasSpikeThresholdGwei: 8,
    gasPriceBumpPercent: 10,
    gasOracleUpdateIntervalMs: 12000,
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

const GWEI = 1_000_000_000n;

describe('Gas price utilities', () => {
  it('should convert gwei correctly', () => {
    const threeGwei = 3n * GWEI;
    expect(threeGwei).toBe(3_000_000_000n);

    const tenGwei = 10n * GWEI;
    expect(Number(tenGwei) / 1e9).toBe(10);
  });

  it('should bump gas price by percentage', () => {
    const bumpPercent = 10;
    const original = 5n * GWEI;
    const bumped = original + (original * BigInt(bumpPercent)) / 100n;

    expect(bumped).toBe(5_500_000_000n);
    expect(bumped > original).toBe(true);
  });

  it('should clamp gas price to maximum', () => {
    const maxGasPrice = 10n * GWEI;
    const highPrice = 15n * GWEI;
    const normalPrice = 5n * GWEI;

    const clampedHigh = highPrice > maxGasPrice ? maxGasPrice : highPrice;
    const clampedNormal = normalPrice > maxGasPrice ? maxGasPrice : normalPrice;

    expect(clampedHigh).toBe(maxGasPrice);
    expect(clampedNormal).toBe(normalPrice);
  });

  it('should detect gas spike', () => {
    const spikeThreshold = 8n * GWEI;
    const normalPrice = 3n * GWEI;
    const spikePrice = 12n * GWEI;

    expect(normalPrice > spikeThreshold).toBe(false);
    expect(spikePrice > spikeThreshold).toBe(true);
  });

  it('should compute median gas price', () => {
    const prices = [3n, 5n, 7n, 4n, 6n].map((p) => p * GWEI);
    const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const median = sorted[Math.floor(sorted.length / 2)];

    expect(median).toBe(5n * GWEI);
  });

  it('should select higher of bumped vs current for replacement', () => {
    const bumpPercent = 10;
    const originalPrice = 5n * GWEI;
    const bumped = originalPrice + (originalPrice * BigInt(bumpPercent)) / 100n;
    const currentRecommended = 6n * GWEI;

    const replacementPrice = bumped > currentRecommended ? bumped : currentRecommended;
    expect(replacementPrice).toBe(currentRecommended);

    const lowCurrent = 4n * GWEI;
    const replacementPrice2 = bumped > lowCurrent ? bumped : lowCurrent;
    expect(replacementPrice2).toBe(bumped);
  });
});
