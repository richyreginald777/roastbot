import { testConnection } from './db/client';
import { runMigrations } from './db/migrations';
import { seedProfilesFromTemplates } from './context/loader';
import { createSlackApp } from './slack/app';
import { registerHandlers } from './slack/handlers';
import { threadManager } from './state/thread-manager';
import { startHealthServer, startKeepAlive, markSlackReady } from './server';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  logger.info('RoastBot starting up...');

  // 0. Bind the HTTP port FIRST — Render's port scan must succeed even if
  // the DB or Slack take a while (or fail) during startup
  startHealthServer();

  // 1. Verify PostgreSQL connection
  await testConnection();

  // 2. Run migrations (idempotent — safe on every startup)
  await runMigrations();

  // 3. Seed the global humor profile (only if not already in DB)
  await seedProfilesFromTemplates();

  // 4. Create Slack app (Socket Mode)
  const app = createSlackApp();

  // 5. Register event handlers
  registerHandlers(app);

  // 6. Start listening
  await app.start();
  markSlackReady();
  logger.info('🔥 RoastBot is running! Listening for mentions and channel messages…');

  // 7. Keep the Render free instance awake (no-op outside Render)
  startKeepAlive();

  // Periodic cleanup of stale in-memory state (every hour)
  setInterval(() => {
    threadManager.cleanup();
  }, 60 * 60 * 1000);
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
