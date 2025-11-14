import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { createServer, Server } from 'http';
import { config } from './config';
import { WalletManager } from './wallet';
import { TransactionQueue } from './queue';
import { GasOracle } from './gas';
import { healthCheck as dbHealthCheck } from './db';
import { createChildLogger } from './logger';
import { HealthStatus } from './types';

const log = createChildLogger('monitor');

const register = new Registry();
collectDefaultMetrics({ register });

// ── Prometheus Metrics ───────────────────────────────

export const txSubmitted = new Counter({
  name: 'ewei_relayer_tx_submitted_total',
  help: 'Total transactions submitted to chain',
  labelNames: ['status'],
  registers: [register],
});

export const txConfirmed = new Counter({
  name: 'ewei_relayer_tx_confirmed_total',
  help: 'Total transactions confirmed on chain',
  registers: [register],
});

export const txFailed = new Counter({
  name: 'ewei_relayer_tx_failed_total',
  help: 'Total transactions that failed',
  labelNames: ['reason'],
  registers: [register],
});

export const queueDepth = new Gauge({
  name: 'ewei_relayer_queue_depth',
  help: 'Current transaction queue depth',
  labelNames: ['state'],
  registers: [register],
});

export const walletBalance = new Gauge({
  name: 'ewei_relayer_wallet_balance_bnb',
  help: 'Relayer wallet balance in BNB',
  registers: [register],
});

export const gasPrice = new Gauge({
  name: 'ewei_relayer_gas_price_gwei',
  help: 'Current gas price in gwei',
  labelNames: ['level'],
  registers: [register],
});

export const txDuration = new Histogram({
  name: 'ewei_relayer_tx_duration_seconds',
  help: 'Time from queue to confirmation',
  buckets: [1, 3, 5, 10, 15, 30, 60, 120],
  registers: [register],
});

/**
 * Health monitor: tracks relayer health, collects metrics,
 * and serves Prometheus metrics endpoint.
 */
export class Monitor {
  private wallet: WalletManager;
  private queue: TransactionQueue;
  private gasOracle: GasOracle;
  private metricsServer: Server | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private startTime: number = Date.now();

  constructor(wallet: WalletManager, queue: TransactionQueue, gasOracle: GasOracle) {
    this.wallet = wallet;
    this.queue = queue;
    this.gasOracle = gasOracle;
  }

  /** Start health monitoring and metrics server */
  async start(): Promise<void> {
    // Start periodic health checks
    this.intervalHandle = setInterval(
      () => this.collectMetrics().catch((err) => log.error({ err }, 'Metrics collection failed')),
      config.healthCheckIntervalMs,
    );

    // Start Prometheus metrics server
    if (config.metricsEnabled) {
      this.metricsServer = createServer(async (req, res) => {
        if (req.url === '/metrics') {
          res.setHeader('Content-Type', register.contentType);
          res.end(await register.metrics());
        } else {
          res.statusCode = 404;
          res.end('Not found');
        }
      });

      this.metricsServer.listen(config.metricsPort, () => {
        log.info({ port: config.metricsPort }, 'Metrics server started');
      });
    }

    await this.collectMetrics();
    log.info('Health monitor started');
  }

  /** Stop monitoring */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.metricsServer) {
      this.metricsServer.close();
      this.metricsServer = null;
    }
  }

  /** Collect all metrics */
  private async collectMetrics(): Promise<void> {
    try {
      const [balance, pending, processing, gasEstimate] = await Promise.all([
        this.wallet.getBalance(),
        this.queue.queueSize(),
        this.queue.processingSize(),
        this.gasOracle.getEstimate(),
      ]);

      walletBalance.set(Number(balance) / 1e18);
      queueDepth.set({ state: 'pending' }, pending);
      queueDepth.set({ state: 'processing' }, processing);
      gasPrice.set({ level: 'standard' }, Number(gasEstimate.standard) / 1e9);
      gasPrice.set({ level: 'fast' }, Number(gasEstimate.fast) / 1e9);
    } catch (err) {
      log.error({ err }, 'Failed to collect metrics');
    }
  }

  /** Get full health status */
  async getHealth(): Promise<HealthStatus> {
    const [balance, blockNumber, redisOk, dbOk, pending, processing, gasEstimate] =
      await Promise.all([
        this.wallet.getBalance().catch(() => 0n),
        this.wallet.getBlockNumber().catch(() => 0),
        this.queue.healthCheck(),
        dbHealthCheck(),
        this.queue.queueSize().catch(() => -1),
        this.queue.processingSize().catch(() => -1),
        this.gasOracle.getEstimate().catch(() => null),
      ]);

    const allOk = redisOk && dbOk && blockNumber > 0;
    const balanceHealthy = balance >= BigInt(0.01 * 1e18);

    return {
      status: allOk && balanceHealthy ? 'healthy' : allOk ? 'degraded' : 'unhealthy',
      version: '1.2.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      wallet: {
        address: this.wallet.address,
        balance: (Number(balance) / 1e18).toFixed(4),
        nonce: this.wallet.pendingCount,
      },
      queue: {
        pending,
        processing,
      },
      redis: redisOk,
      database: dbOk,
      rpc: blockNumber > 0,
      lastBlock: blockNumber,
      gasPrice: gasEstimate
        ? (Number(gasEstimate.standard) / 1e9).toFixed(2) + ' gwei'
        : 'unknown',
    };
  }
}
