import * as fs from 'fs';
import * as path from 'path';
import { getProfile, upsertProfile } from '../db/profiles';
import { logger } from '../utils/logger';

const TEMPLATES_DIR = path.join(__dirname, 'templates');

/**
 * Seed the global humor profile from the template file — only if it isn't
 * already in the database (DB is the source of truth, same as receipt-agent).
 */
export async function seedProfilesFromTemplates(): Promise<void> {
  logger.info('Seeding humor profiles from templates...');

  const globalFile = path.join(TEMPLATES_DIR, 'global.md');
  if (fs.existsSync(globalFile)) {
    const existing = await getProfile('global');
    if (!existing) {
      const content = fs.readFileSync(globalFile, 'utf-8');
      await upsertProfile('global', 'global', content);
      logger.info('Seeded global humor profile');
    }
  }

  logger.info('Profile seeding complete');
}
