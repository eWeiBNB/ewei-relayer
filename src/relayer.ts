import { ethers, Contract } from 'ethers';
import { TransactionQueue } from './queue';
import { WalletManager } from './wallet';
import { GasOracle } from './gas';
import { TransactionValidator } from './validator';
import { Monitor, txSubmitted, txConfirmed, txFailed, txDuration } from './monitor';
import { config } from './config';
import { createChildLogger } from './logger';
import { query } from './db';
import {
  QueuedTransaction,
  TransactionStatus,
  SubmissionResult,
} from './types';

const log = createChildLogger('relayer');

// Forwarder ABI for executing meta-transactions
const FORWARDER_ABI = [
  'function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, uint256 deadline, bytes data) req, bytes signature) payable returns (bool, bytes)',
  'event Executed(address indexed from, address indexed to, bool success, bytes result)',
];

const POLL_INTERVAL_MS = 1000;
const CONFIRMATION_BLOCKS = 3;
const MAX_CONCURRENT_TXS = 5;

/**
 * Core relayer: picks up sponsored transactions from the queue,
 * submits them to BNB Smart Chain via the Forwarder contract,
 * and tracks confirmations.
 */
export class Relayer {
  private queue: TransactionQueue;
  private wallet: WalletManager;
  private gasOracle: GasOracle;
  private validator: TransactionValidator;
  private monitor: Monitor;
  private forwarder: Contract;
  private running: boolean = false;
  private activeTxs: number = 0;

  constructor() {
    this.wallet = new WalletManager();
    this.queue = new TransactionQueue();
    this.gasOracle = new GasOracle(this.wallet.getProvider());
    this.validator = new TransactionValidator(this.wallet.getProvider());
    this.monitor = new Monitor(this.wallet, this.queue, this.gasOracle);
    this.forwarder = new Contract(
      config.forwarderAddress,
      FORWARDER_ABI,
      this.wallet.signer,
    );
  }

  /** Start the relayer node */
  async start(): Promise<void> {
    log.info('Starting eWei relayer node...');

    await this.wallet.initialize();

    const balance = await this.wallet.getBalance();
    log.info(
      {
        address: this.wallet.address,
        balance: ethers.formatEther(balance),
      },
      'Relayer wallet ready',
    );

    // Warn if balance is low
    if (!(await this.wallet.isBalanceHealthy())) {
      log.warn('Wallet balance is below minimum threshold. Fund the relayer wallet.');
    }

    this.gasOracle.start();
    await this.monitor.start();

    this.running = true;
    this.pollLoop();

    log.info('eWei relayer node started successfully');
  }

  /** Stop the relayer gracefully */
  async stop(): Promise<void> {
    log.info('Stopping relayer node...');
    this.running = false;
    this.gasOracle.stop();
    this.monitor.stop();
    await this.queue.close();
    log.info('Relayer node stopped');
  }

  /** Get components for the API layer */
  getComponents() {
    return {
      queue: this.queue,
      validator: this.validator,
      getHealth: () => this.monitor.getHealth(),
    };
  }

  /** Main polling loop: pull transactions from queue and submit */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        // Don't exceed concurrent tx limit
        if (this.activeTxs >= MAX_CONCURRENT_TXS) {
          await this.sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Check if gas is too expensive
        if (await this.gasOracle.isGasTooExpensive()) {
          log.warn('Gas too expensive, pausing relay');
          await this.sleep(5000);
          continue;
        }

        const tx = await this.queue.dequeue();
        if (!tx) {
          await this.sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Check deadline before submitting
        const now = Math.floor(Date.now() / 1000);
        if (tx.request.deadline <= now) {
          log.warn({ txId: tx.id }, 'Transaction expired before submission');
          await this.queue.complete(tx.id, TransactionStatus.DROPPED);
          txFailed.inc({ reason: 'expired' });
          continue;
        }

        // Submit in background
        this.activeTxs++;
        this.submitAndTrack(tx)
          .catch((err) => log.error({ err, txId: tx.id }, 'Unhandled submission error'))
          .finally(() => {
            this.activeTxs--;
          });
      } catch (err) {
        log.error({ err }, 'Poll loop error');
        await this.sleep(POLL_INTERVAL_MS);
      }
    }
  }

  /** Submit a transaction and track its confirmation */
  private async submitAndTrack(tx: QueuedTransaction): Promise<void> {
    const startTime = Date.now();
    let nonce: number | undefined;

    try {
      // Acquire nonce
      nonce = await this.wallet.acquireNonce();

      // Get gas price
      const gasPriceValue = await this.gasOracle.getRecommendedGasPrice();

      log.info(
        {
          txId: tx.id,
          from: tx.request.from,
          to: tx.request.to,
          nonce,
          gasPrice: ethers.formatUnits(gasPriceValue, 'gwei'),
        },
        'Submitting transaction',
      );

      // Build and send the meta-transaction via Forwarder
      const response = await this.forwarder.execute(
        {
          from: tx.request.from,
          to: tx.request.to,
          value: tx.request.value,
          gas: tx.request.gasLimit,
          nonce: tx.request.nonce,
          deadline: tx.request.deadline,
          data: tx.request.data,
        },
        tx.request.signature,
        {
          nonce,
          gasPrice: gasPriceValue,
          gasLimit: BigInt(tx.request.gasLimit.toString()) + 100_000n, // overhead for forwarder
        },
      );

      txSubmitted.inc({ status: 'submitted' });

      // Persist to database
      await query(
        `INSERT INTO transactions (id, api_key_id, status, priority, sender, target, calldata, value, gas_limit, deadline, forwarder_nonce, signature, policy_id, tx_hash, relayer_nonce, gas_price, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())`,
        [
          tx.id,
          tx.apiKeyId,
          TransactionStatus.SUBMITTED,
          tx.priority,
          tx.request.from,
          tx.request.to,
          tx.request.data,
          tx.request.value.toString(),
          tx.request.gasLimit.toString(),
          tx.request.deadline,
          tx.request.nonce.toString(),
          tx.request.signature,
          tx.request.policyId,
          response.hash,
          nonce,
          gasPriceValue.toString(),
        ],
      );

      await this.queue.complete(tx.id, TransactionStatus.SUBMITTED, response.hash);
      this.wallet.confirmNonce(nonce);

      // Wait for confirmations
      log.info({ txId: tx.id, txHash: response.hash }, 'Waiting for confirmation');
      const receipt = await response.wait(CONFIRMATION_BLOCKS);

      if (receipt && receipt.status === 1) {
        txConfirmed.inc();
        txDuration.observe((Date.now() - startTime) / 1000);

        await query(
          'UPDATE transactions SET status = $1, block_number = $2, gas_used = $3, confirmed_at = NOW() WHERE id = $4',
          [TransactionStatus.CONFIRMED, receipt.blockNumber, receipt.gasUsed.toString(), tx.id],
        );

        log.info(
          {
            txId: tx.id,
            txHash: response.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          },
          'Transaction confirmed',
        );
      } else {
        txFailed.inc({ reason: 'reverted' });
        await query(
          'UPDATE transactions SET status = $1, block_number = $2, gas_used = $3, confirmed_at = NOW() WHERE id = $4',
          [TransactionStatus.REVERTED, receipt?.blockNumber, receipt?.gasUsed.toString(), tx.id],
        );
        log.warn({ txId: tx.id, txHash: response.hash }, 'Transaction reverted');
      }

      // Fire webhook if configured
      if (tx.webhookUrl) {
        this.fireWebhook(tx, receipt?.status === 1 ? 'tx.confirmed' : 'tx.reverted', response.hash);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, txId: tx.id }, 'Transaction submission failed');

      if (nonce !== undefined) {
        this.wallet.releaseNonce(nonce);
      }

      txFailed.inc({ reason: 'submission_error' });

      // Update DB
      await query(
        'UPDATE transactions SET status = $1, last_error = $2, attempts = $3 WHERE id = $4',
        [TransactionStatus.FAILED, message, tx.attempts, tx.id],
      ).catch(() => {});

      // Retry if possible
      const requeued = await this.queue.requeue(tx.id);
      if (!requeued) {
        await this.queue.complete(tx.id, TransactionStatus.FAILED);
      }
    }
  }

  /** Fire webhook notification (best-effort) */
  private async fireWebhook(
    tx: QueuedTransaction,
    event: string,
    txHash: string,
  ): Promise<void> {
    if (!tx.webhookUrl) return;

    try {
      const response = await fetch(tx.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          txId: tx.id,
          txHash,
          from: tx.request.from,
          to: tx.request.to,
          timestamp: Date.now(),
        }),
        signal: AbortSignal.timeout(config.webhookTimeoutMs),
      });

      if (response.ok) {
        await query('UPDATE transactions SET webhook_sent = TRUE WHERE id = $1', [tx.id]);
      }
    } catch (err) {
      log.warn({ err, txId: tx.id, webhookUrl: tx.webhookUrl }, 'Webhook delivery failed');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
