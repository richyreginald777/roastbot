import { Pool } from 'pg';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const commonPoolOptions = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Render (and most managed Postgres) requires SSL on external connections;
  // rejectUnauthorized:false because managed providers use their own CA chains
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
};

const pool = config.db.connectionString
  ? new Pool({ connectionString: config.db.connectionString, ...commonPoolOptions })
  : new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      ...commonPoolOptions,
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
      via: config.db.connectionString ? 'DATABASE_URL' : `${config.db.host}:${config.db.port}/${config.db.name}`,
      ssl: config.db.ssl,
      hint: 'Is Postgres reachable, does the database exist, and is SSL configured correctly?',
    });
    throw err;
  }
}

export { pool };
