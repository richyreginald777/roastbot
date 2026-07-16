// Load .env from the project root (if present) before reading any variables.
// Shell environment variables still take precedence — dotenv never overrides
// values that are already set.
import * as dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  slack: {
    botToken: required('ROASTBOT_SLACK_BOT_TOKEN'),
    appToken: required('ROASTBOT_SLACK_APP_TOKEN'),
    botUserId: required('ROASTBOT_BOT_USER_ID'),
  },
  gemini: {
    // All available API keys — rotated on rate limits. NOTE: Gemini quotas
    // are per Google Cloud PROJECT, not per key; rotation only helps if the
    // keys belong to different projects.
    apiKeys: [
      required('GEMINI_API_KEY'),
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
    ].filter(Boolean) as string[],
    // Fallback chains: first model is preferred; on rate limit / error the
    // next in line is tried. Flash + Lite models only — no Pro.
    textModels: optional(
      'ROASTBOT_GEMINI_TEXT_MODELS',
      'gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite',
    ).split(',').map((s) => s.trim()).filter(Boolean),
    imageModels: optional(
      'ROASTBOT_GEMINI_IMAGE_MODELS',
      'gemini-3.1-flash-lite-image,gemini-3.1-flash-image,gemini-2.5-flash-image',
    ).split(',').map((s) => s.trim()).filter(Boolean),
  },
  db: {
    // DATABASE_URL (Supabase/managed-Postgres convention) takes precedence
    // over discrete vars. When set, host/port/user/password/name are ignored.
    connectionString: process.env.DATABASE_URL || '',
    // SSL on for any remote connection string (Supabase requires it);
    // off for localhost. Override either way with ROASTBOT_DB_SSL=true/false.
    ssl: process.env.ROASTBOT_DB_SSL
      ? process.env.ROASTBOT_DB_SSL === 'true'
      : Boolean(process.env.DATABASE_URL) && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || ''),
    host: optional('ROASTBOT_DB_HOST', 'localhost'),
    port: parseInt(optional('ROASTBOT_DB_PORT', '5430'), 10),
    user: optional('ROASTBOT_DB_USER', 'postgres'),
    password: process.env.DATABASE_URL ? optional('ROASTBOT_DB_PASSWORD', '') : required('ROASTBOT_DB_PASSWORD'),
    name: optional('ROASTBOT_DB_NAME', 'roastbot'),
  },
  bot: {
    // Master switch for meme generation — false = text roasts only
    memerEnabled: optional('ENABLE_MEMER', 'true') === 'true',
    cooldownMinutes: parseInt(optional('ROASTBOT_COOLDOWN_MINUTES', '10'), 10),
    channelHistoryLimit: parseInt(optional('ROASTBOT_CHANNEL_HISTORY_LIMIT', '15'), 10),
    memeProbability: parseFloat(optional('ROASTBOT_MEME_PROBABILITY', '0.3')),
    memeCooldownMinutes: parseInt(optional('ROASTBOT_MEME_COOLDOWN_MINUTES', '30'), 10),
    logLevel: optional('LOG_LEVEL', 'info'),
  },
};
