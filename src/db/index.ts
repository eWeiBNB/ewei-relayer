import { Pool, PoolConfig } from 'pg';
import { config } from '../config';
import { createChildLogger } from '../logger';

const log = createChildLogger('db');

const poolConfig: PoolConfig = {
  connectionString: config.databaseUrl,
  min: config.dbPoolMin,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

export const pool = new Pool(poolConfig);

pool.on('connect', () => {
  log.debug('New database connection established');
});

pool.on('error', (err) => {
  log.error({ err }, 'Unexpected database pool error');
});

/** Run a single query */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  log.debug({ query: text.slice(0, 80), duration, rows: result.rowCount }, 'Query executed');
  return result.rows as T[];
}

/** Run multiple queries in a transaction */
export async function transaction<T>(
  fn: (client: ReturnType<typeof pool.connect> extends Promise<infer C> ? C : never) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Check if database is reachable */
export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Graceful shutdown */
export async function close(): Promise<void> {
  log.info('Closing database pool');
  await pool.end();
}
