import { query } from './client';
import { logger } from '../utils/logger';

export async function runMigrations(): Promise<void> {
  logger.info('Running database migrations...');

  // Interactions — one row per message the bot saw and (maybe) responded to
  await query(`
    CREATE TABLE IF NOT EXISTS roastbot_interactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slack_channel VARCHAR(100) NOT NULL,
      slack_thread_ts VARCHAR(100),
      slack_user_id VARCHAR(100) NOT NULL,
      trigger_type VARCHAR(20) NOT NULL,        -- 'mention' | 'channel' | 'thread'
      user_message TEXT NOT NULL,
      bot_response TEXT,                        -- NULL when the bot chose to stay silent
      responded BOOLEAN NOT NULL DEFAULT FALSE,
      gemini_input_tokens INTEGER DEFAULT 0,
      gemini_output_tokens INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Humor profiles — living context documents (global + per-user), versioned
  await query(`
    CREATE TABLE IF NOT EXISTS roastbot_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_key VARCHAR(100) UNIQUE NOT NULL, -- 'global' or 'user:<slackUserId>'
      profile_type VARCHAR(50) NOT NULL,        -- 'global' | 'user'
      content TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Profile history — archived versions for rollback
  await query(`
    CREATE TABLE IF NOT EXISTS roastbot_profile_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_key VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL,
      archived_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_roastbot_interactions_channel
    ON roastbot_interactions(slack_channel, created_at);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_roastbot_interactions_user
    ON roastbot_interactions(slack_user_id, created_at);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_roastbot_profile_history_key
    ON roastbot_profile_history(profile_key, version DESC);
  `);

  logger.info('Database migrations completed');
}
