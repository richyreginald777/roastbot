import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import { logger } from './logger';

// Model fallback × key rotation.
//
// For each model in the chain, every API key is tried before degrading to the
// next model — keeping the better model on a fresh key beats dropping to a
// worse model. Failed (model, key) pairs are benched briefly so a rate-limited
// combination isn't re-probed on every message.
//
// NOTE: Gemini quotas are per Google Cloud project, not per key — rotation
// only adds throughput when the keys come from different projects.

const RATE_LIMIT_BENCH_MS = 60_000; // 429s with no retry hint: skip for a minute
const ERROR_BENCH_MS = 30_000;      // other errors: shorter bench

const clients: GoogleGenAI[] = config.gemini.apiKeys.map(
  (apiKey) => new GoogleGenAI({ apiKey }),
);

const benchedUntil = new Map<string, number>();

function isRateLimitError(err: any): boolean {
  const msg = `${err?.message ?? ''} ${err?.status ?? ''} ${err?.code ?? ''}`;
  return /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(msg);
}

// Free-tier-aware bench duration. Gemini 429s carry machine-readable hints:
// - QuotaFailure quotaId like "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
//   → the DAILY quota is gone; retrying before it resets (midnight Pacific,
//   per the rate-limits docs) just wastes a probe per minute all day.
// - RetryInfo retryDelay ("48s") → per-minute quota; bench exactly that long.
function msUntilNextMidnightPacific(): number {
  const nowPt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(nowPt);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - nowPt.getTime();
}

function benchDurationMs(err: any, rateLimited: boolean): number {
  if (!rateLimited) return ERROR_BENCH_MS;

  const msg = String(err?.message ?? '');

  // Daily quota exhausted — bench until the midnight-PT reset (+2 min buffer)
  if (/PerDay/i.test(msg)) {
    return msUntilNextMidnightPacific() + 2 * 60_000;
  }

  // Per-minute quota — honour the server's suggested retry delay (+2 s buffer)
  const retryMatch = msg.match(/retryDelay\\?"\s*:\s*\\?"(\d+(?:\.\d+)?)s/) || msg.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (retryMatch) {
    return (parseFloat(retryMatch[1]) + 2) * 1000;
  }

  return RATE_LIMIT_BENCH_MS;
}

export async function withModelFallback<T>(
  models: string[],
  fn: (ai: GoogleGenAI, model: string) => Promise<T>,
): Promise<T> {
  let lastErr: any;

  for (const model of models) {
    for (let keyIdx = 0; keyIdx < clients.length; keyIdx++) {
      const benchKey = `${model}#key${keyIdx}`;
      if ((benchedUntil.get(benchKey) ?? 0) > Date.now()) continue;

      try {
        return await fn(clients[keyIdx], model);
      } catch (err: any) {
        lastErr = err;
        const rateLimited = isRateLimitError(err);
        const benchMs = benchDurationMs(err, rateLimited);
        benchedUntil.set(benchKey, Date.now() + benchMs);
        logger.warn(`Model ${model} (key #${keyIdx + 1}) failed — trying next key/model`, {
          rateLimited,
          benchedForMinutes: +(benchMs / 60_000).toFixed(1),
          error: String(err?.message ?? err),
        });
      }
    }
  }

  throw lastErr ?? new Error('All model/key combinations are benched or failed');
}
