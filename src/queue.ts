import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { createChildLogger } from './logger';
import {
  QueuedTransaction,
  SponsorRequest,
  TransactionStatus,
  Priority,
} from './types';

const log = createChildLogger('queue');

const QUEUE_KEY = `${config.redisKeyPrefix}tx:queue`;
const PROCESSING_KEY = `${config.redisKeyPrefix}tx:processing`;
const TX_PREFIX = `${config.redisKeyPrefix}tx:data:`;
const DEDUP_PREFIX = `${config.redisKeyPrefix}tx:dedup:`;

/**
 * Redis-backed transaction queue with priority ordering and deduplication.
 * Uses sorted sets for priority queuing and hashes for transaction data.
 */
export class TransactionQueue {
  private redis: Redis;

  constructor() {
    this.redis = new Redis(config.redisUrl, {
      keyPrefix: '',
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
    });

    this.redis.on('connect', () => log.info('Redis connected'));
    this.redis.on('error', (err) => log.error({ err }, 'Redis error'));
  }

  /** Add a sponsored transaction to the queue */
  async enqueue(
    request: SponsorRequest,
    apiKeyId: string,
    priority: Priority = Priority.NORMAL,
    webhookUrl?: string,
  ): Promise<string> {
    // Deduplication: check if this exact request is already queued
    const dedupKey = this.dedupKey(request);
    const existing = await this.redis.get(dedupKey);
    if (existing) {
      log.warn({ existingId: existing }, 'Duplicate transaction detected');
      return existing;
    }

    const tx: QueuedTransaction = {
      id: uuidv4(),
      request,
      priority,
      createdAt: Date.now(),
      attempts: 0,
      status: TransactionStatus.QUEUED,
      apiKeyId,
      webhookUrl,
    };

    const pipeline = this.redis.pipeline();

    // Store transaction data
    pipeline.set(`${TX_PREFIX}${tx.id}`, JSON.stringify(tx));

    // Add to priority queue (higher priority = higher score)
    const score = priority * 1e15 + (1e15 - tx.createdAt);
    pipeline.zadd(QUEUE_KEY, score, tx.id);

    // Set dedup key (expires after deadline)
    const ttl = Math.max(request.deadline - Math.floor(Date.now() / 1000), 60);
    pipeline.set(dedupKey, tx.id, 'EX', ttl);

    await pipeline.exec();

    log.info({ txId: tx.id, priority, from: request.from, to: request.to }, 'Transaction queued');
    return tx.id;
  }

  /** Pop the highest-priority transaction from the queue */
  async dequeue(): Promise<QueuedTransaction | null> {
    // Atomically move from queue to processing set
    const members = await this.redis.zpopmax(QUEUE_KEY, 1);
    if (!members || members.length === 0) {
      return null;
    }

    const txId = members[0];
    const data = await this.redis.get(`${TX_PREFIX}${txId}`);
    if (!data) {
      log.warn({ txId }, 'Transaction data not found for queued ID');
      return null;
    }

    const tx: QueuedTransaction = JSON.parse(data);
    tx.status = TransactionStatus.PENDING;
    tx.attempts++;
    tx.lastAttemptAt = Date.now();

    // Move to processing set
    await this.redis.sadd(PROCESSING_KEY, txId);
    await this.redis.set(`${TX_PREFIX}${txId}`, JSON.stringify(tx));

    return tx;
  }

  /** Mark a transaction as complete (remove from processing) */
  async complete(txId: string, status: TransactionStatus, txHash?: string): Promise<void> {
    const data = await this.redis.get(`${TX_PREFIX}${txId}`);
    if (!data) return;

    const tx: QueuedTransaction = JSON.parse(data);
    tx.status = status;
    if (txHash) tx.txHash = txHash;

    await this.redis.set(`${TX_PREFIX}${txId}`, JSON.stringify(tx));
    await this.redis.srem(PROCESSING_KEY, txId);

    log.info({ txId, status, txHash }, 'Transaction completed');
  }

  /** Re-queue a failed transaction for retry */
  async requeue(txId: string): Promise<boolean> {
    const data = await this.redis.get(`${TX_PREFIX}${txId}`);
    if (!data) return false;

    const tx: QueuedTransaction = JSON.parse(data);

    if (tx.attempts >= 3) {
      log.warn({ txId, attempts: tx.attempts }, 'Max attempts reached, dropping transaction');
      await this.complete(txId, TransactionStatus.DROPPED);
      return false;
    }

    tx.status = TransactionStatus.QUEUED;
    const score = tx.priority * 1e15 + (1e15 - tx.createdAt);

    const pipeline = this.redis.pipeline();
    pipeline.set(`${TX_PREFIX}${txId}`, JSON.stringify(tx));
    pipeline.zadd(QUEUE_KEY, score, txId);
    pipeline.srem(PROCESSING_KEY, txId);
    await pipeline.exec();

    log.info({ txId, attempt: tx.attempts }, 'Transaction requeued');
    return true;
  }

  /** Get a transaction by ID */
  async get(txId: string): Promise<QueuedTransaction | null> {
    const data = await this.redis.get(`${TX_PREFIX}${txId}`);
    return data ? JSON.parse(data) : null;
  }

  /** Get current queue depth */
  async queueSize(): Promise<number> {
    return this.redis.zcard(QUEUE_KEY);
  }

  /** Get number of transactions being processed */
  async processingSize(): Promise<number> {
    return this.redis.scard(PROCESSING_KEY);
  }

  /** Health check */
  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /** Graceful shutdown */
  async close(): Promise<void> {
    log.info('Closing Redis connection');
    await this.redis.quit();
  }

  /** Generate deduplication key from request fields */
  private dedupKey(req: SponsorRequest): string {
    return `${DEDUP_PREFIX}${req.from}:${req.to}:${req.nonce}`;
  }
}
