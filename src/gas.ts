import { ethers, JsonRpcProvider, Block } from 'ethers';
import { GasEstimate } from './types';
import { config } from './config';
import { createChildLogger } from './logger';

const log = createChildLogger('gas');

const GWEI = 1_000_000_000n;
const HISTORY_SIZE = 20;

/**
 * Gas price oracle for BNB Smart Chain.
 * Tracks recent gas prices, detects spikes, and provides estimates
 * at multiple confidence levels.
 */
export class GasOracle {
  private provider: JsonRpcProvider;
  private priceHistory: bigint[] = [];
  private currentEstimate: GasEstimate | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly maxGasPrice: bigint;
  private readonly spikeThreshold: bigint;
  private readonly bumpPercent: number;

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
    this.maxGasPrice = BigInt(config.maxGasPriceGwei) * GWEI;
    this.spikeThreshold = BigInt(config.gasSpikeThresholdGwei) * GWEI;
    this.bumpPercent = config.gasPriceBumpPercent;
  }

  /** Start periodic gas price updates */
  start(): void {
    log.info(
      { intervalMs: config.gasOracleUpdateIntervalMs },
      'Gas oracle started',
    );

    // Initial fetch
    this.update().catch((err) => log.error({ err }, 'Initial gas price fetch failed'));

    this.intervalHandle = setInterval(
      () => this.update().catch((err) => log.error({ err }, 'Gas price update failed')),
      config.gasOracleUpdateIntervalMs,
    );
  }

  /** Stop periodic updates */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('Gas oracle stopped');
    }
  }

  /** Fetch latest gas prices and update estimates */
  async update(): Promise<void> {
    const block = await this.provider.getBlock('latest');
    if (!block) {
      log.warn('Could not fetch latest block');
      return;
    }

    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 3n * GWEI;

    this.priceHistory.push(gasPrice);
    if (this.priceHistory.length > HISTORY_SIZE) {
      this.priceHistory.shift();
    }

    const baseFee = block.baseFeePerGas ?? 0n;
    const sorted = [...this.priceHistory].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const median = sorted[Math.floor(sorted.length / 2)];

    const isSpiking = gasPrice > this.spikeThreshold;

    this.currentEstimate = {
      safeLow: this.clamp(median),
      standard: this.clamp(gasPrice),
      fast: this.clamp(this.bump(gasPrice)),
      baseFee,
      isSpiking,
      updatedAt: Date.now(),
    };

    log.debug(
      {
        gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
        baseFee: ethers.formatUnits(baseFee, 'gwei'),
        isSpiking,
        blockNumber: block.number,
      },
      'Gas price updated',
    );
  }

  /** Get current gas estimate, or fetch if stale */
  async getEstimate(): Promise<GasEstimate> {
    if (!this.currentEstimate || Date.now() - this.currentEstimate.updatedAt > 30_000) {
      await this.update();
    }
    return this.currentEstimate!;
  }

  /** Get the recommended gas price for a new transaction */
  async getRecommendedGasPrice(): Promise<bigint> {
    const estimate = await this.getEstimate();

    if (estimate.isSpiking) {
      log.warn(
        { gasPrice: ethers.formatUnits(estimate.standard, 'gwei') },
        'Gas spike detected, using safe low price',
      );
      return estimate.safeLow;
    }

    return estimate.standard;
  }

  /** Get bumped gas price for replacement/speedup transactions */
  async getReplacementGasPrice(originalGasPrice: bigint): Promise<bigint> {
    const bumped = this.bump(originalGasPrice);
    const current = await this.getRecommendedGasPrice();
    // Use whichever is higher: bumped original or current recommended
    return bumped > current ? bumped : current;
  }

  /** Whether current gas prices exceed our maximum */
  async isGasTooExpensive(): Promise<boolean> {
    const estimate = await this.getEstimate();
    return estimate.standard > this.maxGasPrice;
  }

  /** Bump a gas price by the configured percentage */
  private bump(price: bigint): bigint {
    return price + (price * BigInt(this.bumpPercent)) / 100n;
  }

  /** Clamp gas price to the configured maximum */
  private clamp(price: bigint): bigint {
    return price > this.maxGasPrice ? this.maxGasPrice : price;
  }
}
