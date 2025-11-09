import express, { Request, Response, Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import { authMiddleware, AuthenticatedRequest } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { TransactionQueue } from './queue';
import { TransactionValidator } from './validator';
import { Priority, TransactionStatus } from './types';
import { createChildLogger } from './logger';
import { query } from './db';

const log = createChildLogger('api');

// Request validation schemas
const sponsorRequestSchema = z.object({
  from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  data: z.string().startsWith('0x'),
  value: z.string().default('0'),
  gasLimit: z.string(),
  deadline: z.number().int().positive(),
  nonce: z.string(),
  signature: z.string().startsWith('0x'),
  policyId: z.string(),
  priority: z.nativeEnum(Priority).optional(),
  webhookUrl: z.string().url().optional(),
});

/**
 * Creates the Express application with all routes and middleware.
 */
export function createApp(
  txQueue: TransactionQueue,
  validator: TransactionValidator,
  getHealth: () => Promise<Record<string, unknown>>,
): express.Application {
  const app = express();

  // Global middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Health endpoint (no auth)
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      const health = await getHealth();
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (err) {
      res.status(503).json({ status: 'unhealthy', error: 'Health check failed' });
    }
  });

  // Metrics endpoint (no auth)
  app.get('/metrics', async (_req: Request, res: Response) => {
    // Prometheus metrics are served from a separate port via prom-client
    res.status(200).json({ message: 'Metrics available on metrics port' });
  });

  // Authenticated routes
  const apiRouter = Router();
  apiRouter.use(authMiddleware());
  apiRouter.use(rateLimitMiddleware);

  // Submit a sponsored transaction
  apiRouter.post('/v1/relay', async (req: Request, res: Response) => {
    try {
      const parsed = sponsorRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid request',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const sponsorReq = parsed.data;
      const authReq = req as AuthenticatedRequest;

      // Validate the transaction
      const validation = await validator.validate(sponsorReq);
      if (!validation.valid) {
        res.status(422).json({
          error: 'Transaction validation failed',
          details: validation.errors,
        });
        return;
      }

      // Enqueue
      const txId = await txQueue.enqueue(
        sponsorReq,
        authReq.apiKey.id,
        sponsorReq.priority ?? Priority.NORMAL,
        sponsorReq.webhookUrl,
      );

      log.info(
        { txId, from: sponsorReq.from, to: sponsorReq.to, apiKey: authReq.apiKey.id },
        'Sponsor request accepted',
      );

      res.status(202).json({
        id: txId,
        status: TransactionStatus.QUEUED,
        message: 'Transaction queued for relay',
      });
    } catch (err) {
      log.error({ err }, 'Relay endpoint error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get transaction status
  apiRouter.get('/v1/relay/:txId', async (req: Request, res: Response) => {
    try {
      const { txId } = req.params;

      // Check Redis first (recent txs)
      const queued = await txQueue.get(txId);
      if (queued) {
        res.json({
          id: queued.id,
          status: queued.status,
          txHash: queued.txHash,
          attempts: queued.attempts,
          createdAt: queued.createdAt,
        });
        return;
      }

      // Fall back to database
      const rows = await query<Record<string, unknown>>(
        'SELECT id, status, tx_hash, block_number, gas_used, created_at, confirmed_at FROM transactions WHERE id = $1',
        [txId],
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      res.json(rows[0]);
    } catch (err) {
      log.error({ err }, 'Status endpoint error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get queue stats
  apiRouter.get('/v1/stats', async (_req: Request, res: Response) => {
    try {
      const [queueSize, processingSize] = await Promise.all([
        txQueue.queueSize(),
        txQueue.processingSize(),
      ]);

      const dailyStats = await query(
        'SELECT * FROM daily_stats WHERE date >= CURRENT_DATE - INTERVAL \'7 days\' ORDER BY date DESC',
      );

      res.json({
        queue: { pending: queueSize, processing: processingSize },
        daily: dailyStats,
      });
    } catch (err) {
      log.error({ err }, 'Stats endpoint error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.use('/api', apiRouter);

  return app;
}
