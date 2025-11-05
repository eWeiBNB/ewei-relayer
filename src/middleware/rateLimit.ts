import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { config } from '../config';
import { AuthenticatedRequest } from './auth';
import { createChildLogger } from '../logger';

const log = createChildLogger('rate-limit');

/**
 * Per-API-key rate limiter.
 * Uses the API key ID as the rate limit key, falling back to IP.
 * Per-key limits can override the global default.
 */
export const rateLimitMiddleware = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: (req: Request): number => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.apiKey?.rateLimit) {
      return authReq.apiKey.rateLimit;
    }
    return config.rateLimitMaxRequests;
  },
  keyGenerator: (req: Request): string => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.apiKey?.id) {
      return `apikey:${authReq.apiKey.id}`;
    }
    return req.ip || 'unknown';
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response): void => {
    log.warn({ ip: _req.ip }, 'Rate limit exceeded');
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil(config.rateLimitWindowMs / 1000),
    });
  },
});
