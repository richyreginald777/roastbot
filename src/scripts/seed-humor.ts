/**
 * One-shot seeder: writes the humor context (distilled from Richy's Gemini
 * conversation about Tanglish jokes and Tamil comedians) into the roastbot
 * database through the bot's own versioned profile layer.
 *
 * Safe to re-run: each run archives the previous version to
 * roastbot_profile_history (rollback with `@RoastBot rollback profile <key>`).
 *
 * Usage: npm run seed:humor
 */
import * as fs from 'fs';
import * as path from 'path';
import { testConnection, pool } from '../db/client';
import { runMigrations } from '../db/migrations';
import { upsertProfile } from '../db/profiles';
import { logger } from '../utils/logger';

const TEMPLATES_DIR = path.join(__dirname, '../context/templates');
const RICHY_USER_ID = 'U07S2KRTS8Z';

async function main(): Promise<void> {
  await testConnection();
  await runMigrations();

  const globalContent = fs.readFileSync(path.join(TEMPLATES_DIR, 'global.md'), 'utf-8');
  const richyContent = fs.readFileSync(path.join(TEMPLATES_DIR, 'user-richy.md'), 'utf-8');

  const g = await upsertProfile('global', 'global', globalContent);
  logger.info(`global → v${g.version}`);

  const u = await upsertProfile(`user:${RICHY_USER_ID}`, 'user', richyContent);
  logger.info(`user:${RICHY_USER_ID} → v${u.version}`);

  await pool.end();
  logger.info('Humor context seeded. RoastBot is now dangerously well-informed.');
}

main().catch((err) => {
  logger.error('Seeding failed', { error: err.message });
  process.exit(1);
});
