import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const CONFIG_PATH = path.join(__dirname, '../../config/responses.json');

interface SecurityConfig {
  authorizedUserIds: string[];
  unauthorizedResponses: string[];
}

function loadConfig(): SecurityConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err: any) {
    logger.error('Failed to load security config — denying all', { error: err.message });
    return { authorizedUserIds: [], unauthorizedResponses: ['Access denied.'] };
  }
}

export function isAuthorized(slackUserId: string): boolean {
  const cfg = loadConfig();
  return cfg.authorizedUserIds.includes(slackUserId);
}

export function getRandomUnauthorizedResponse(): string {
  const cfg = loadConfig();
  const responses = cfg.unauthorizedResponses;
  return responses[Math.floor(Math.random() * responses.length)];
}
