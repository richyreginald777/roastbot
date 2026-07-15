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
    apiKey: required('GEMINI_API_KEY'),
    model: optional('ROASTBOT_GEMINI_MODEL', 'gemini-3-flash-preview'),
    imageModel: optional('ROASTBOT_GEMINI_IMAGE_MODEL', 'gemini-3.1-flash-lite-image'),
  },
  db: {
    host: optional('ROASTBOT_DB_HOST', 'localhost'),
    port: parseInt(optional('ROASTBOT_DB_PORT', '5430'), 10),
    user: optional('ROASTBOT_DB_USER', 'postgres'),
    password: required('ROASTBOT_DB_PASSWORD'),
    name: optional('ROASTBOT_DB_NAME', 'roastbot'),
  },
  bot: {
    cooldownMinutes: parseInt(optional('ROASTBOT_COOLDOWN_MINUTES', '10'), 10),
    channelHistoryLimit: parseInt(optional('ROASTBOT_CHANNEL_HISTORY_LIMIT', '15'), 10),
    memeProbability: parseFloat(optional('ROASTBOT_MEME_PROBABILITY', '0.3')),
    memeCooldownMinutes: parseInt(optional('ROASTBOT_MEME_COOLDOWN_MINUTES', '30'), 10),
    logLevel: optional('LOG_LEVEL', 'info'),
  },
};
