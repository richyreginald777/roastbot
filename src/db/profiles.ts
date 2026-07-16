import { query } from './client';
import { logger } from '../utils/logger';

export interface ProfileRecord {
  id: string;
  profile_key: string;
  profile_type: string;
  content: string;
  version: number;
  updated_at: Date;
}

// --- In-memory read cache -----------------------------------------------------
// Profiles are read on EVERY message but change rarely (learner updates,
// manual rollbacks). A short TTL cache eliminates the 2 DB round-trips per
// message. Writes in this process invalidate immediately; the TTL bounds
// staleness if the DB is modified externally.
const PROFILE_CACHE_TTL_MS = parseInt(process.env.ROASTBOT_PROFILE_CACHE_TTL_MS ?? '60000', 10);
const profileCache = new Map<string, { record: ProfileRecord | null; at: number }>();

function cacheGet(key: string): { record: ProfileRecord | null } | undefined {
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_CACHE_TTL_MS) return hit;
  return undefined;
}

function cacheSet(key: string, record: ProfileRecord | null): void {
  profileCache.set(key, { record, at: Date.now() });
}

export async function getProfile(key: string): Promise<ProfileRecord | null> {
  const cached = cacheGet(key);
  if (cached) return cached.record;

  const result = await query('SELECT * FROM roastbot_profiles WHERE profile_key = $1', [key]);
  const record = result.rows[0] || null;
  cacheSet(key, record);
  return record;
}

export async function getAllProfiles(): Promise<ProfileRecord[]> {
  const result = await query('SELECT * FROM roastbot_profiles ORDER BY profile_key');
  return result.rows;
}

export interface ProfileUpdateCost {
  modelUsed: string;
  costUsd: number;
}

export async function upsertProfile(
  key: string,
  type: string,
  content: string,
  cost?: ProfileUpdateCost,
): Promise<ProfileRecord> {
  const existing = await getProfile(key);

  if (existing) {
    // Archive current version before updating. Cost columns record what the
    // learner call that produced the NEW version cost.
    await query(
      `INSERT INTO roastbot_profile_history (profile_key, content, version, model_used, cost_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        existing.profile_key,
        existing.content,
        existing.version,
        cost?.modelUsed || null,
        cost?.costUsd ?? 0,
      ],
    );

    const result = await query(
      `UPDATE roastbot_profiles
       SET content = $1, version = version + 1, updated_at = NOW()
       WHERE profile_key = $2
       RETURNING *`,
      [content, key],
    );

    logger.info(`Profile updated: ${key} → v${result.rows[0].version}`);
    cacheSet(key, result.rows[0]);
    return result.rows[0];
  }

  const result = await query(
    `INSERT INTO roastbot_profiles (profile_key, profile_type, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [key, type, content],
  );

  logger.info(`Profile created: ${key} v1`);
  cacheSet(key, result.rows[0]);
  return result.rows[0];
}

export async function rollbackProfile(key: string): Promise<ProfileRecord | null> {
  const history = await query(
    `SELECT * FROM roastbot_profile_history
     WHERE profile_key = $1
     ORDER BY version DESC
     LIMIT 1`,
    [key],
  );

  if (history.rows.length === 0) {
    logger.warn(`No history found for profile: ${key}`);
    return null;
  }

  const archived = history.rows[0];

  // Archive current before rollback
  const current = await getProfile(key);
  if (current) {
    await query(
      `INSERT INTO roastbot_profile_history (profile_key, content, version)
       VALUES ($1, $2, $3)`,
      [current.profile_key, current.content, current.version],
    );
  }

  const result = await query(
    `UPDATE roastbot_profiles
     SET content = $1, version = version + 1, updated_at = NOW()
     WHERE profile_key = $2
     RETURNING *`,
    [archived.content, key],
  );

  logger.info(`Profile rolled back: ${key} → v${result.rows[0].version} (restored from v${archived.version})`);
  cacheSet(key, result.rows[0]);
  return result.rows[0];
}
