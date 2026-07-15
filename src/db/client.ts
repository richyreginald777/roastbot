import { Pool } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

export async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

export async function testConnection(): Promise<void> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('PostgreSQL connection verified');
  } catch (err: any) {
    // AggregateError (e.g. ECONNREFUSED on both ::1 and 127.0.0.1) has an
    // empty .message — unwrap the underlying errors so the log is useful.
    const detail =
      err instanceof AggregateError
        ? err.errors.map((e: any) => e.message || String(e)).join('; ')
        : err.message;
    logger.error('PostgreSQL connection failed', {
      error: detail,
      host: config.db.host,
      port: config.db.port,
      database: config.db.name,
      hint: 'Is Postgres running on this host:port, and does the database exist?',
    });
    throw err;
  }
}

export { pool };
