import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { config } from '../config';
import { query } from '../db';
import { createChildLogger } from '../logger';
import { ApiKey } from '../types';

const log = createChildLogger('auth');

/**
 * API key authentication middleware.
 * Accepts keys via Authorization header: `Bearer ewei_...`
 */
export function authMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const apiKey = authHeader.slice(7).trim();

    if (!apiKey || apiKey.length < 20) {
      res.status(401).json({ error: 'Invalid API key format' });
      return;
    }

    try {
      const keyData = await validateApiKey(apiKey);

      if (!keyData) {
        log.warn({ keyPrefix: apiKey.slice(0, 8) }, 'Invalid API key attempted');
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      if (!keyData.active) {
        res.status(403).json({ error: 'API key is disabled' });
        return;
      }

      // Attach key data to request for downstream use
      (req as AuthenticatedRequest).apiKey = keyData;

      // Update last_used_at (fire-and-forget)
      query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyData.id]).catch(() => {});

      next();
    } catch (err) {
      log.error({ err }, 'Auth middleware error');
      res.status(500).json({ error: 'Authentication error' });
    }
  };
}

/** Validate an API key against DB or static config */
async function validateApiKey(key: string): Promise<ApiKey | null> {
  // Check static keys first
  if (!config.apiKeysFromDb && config.apiKeys.includes(key)) {
    return {
      id: 'static',
      key,
      name: 'Static API Key',
      sponsorAddress: '0x0000000000000000000000000000000000000000',
      rateLimit: config.rateLimitMaxRequests,
      active: true,
      createdAt: new Date(),
    };
  }

  // Database-backed key validation
  const keyHash = hashKey(key);
  const results = await query<ApiKey>(
    'SELECT id, key_hash, key_prefix, name, sponsor_address, rate_limit, active, created_at, last_used_at FROM api_keys WHERE key_hash = $1',
    [keyHash],
  );

  if (results.length === 0) {
    return null;
  }

  const row = results[0];
  return {
    id: row.id,
    key: key,
    name: row.name,
    sponsorAddress: row.sponsorAddress,
    rateLimit: row.rateLimit,
    active: row.active,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface AuthenticatedRequest extends Request {
  apiKey: ApiKey;
}
