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

const RATE_LIMIT_BENCH_MS = 60_000; // 429s: skip the pair for a minute
const ERROR_BENCH_MS = 30_000;      // other errors: shorter bench

const clients: GoogleGenAI[] = config.gemini.apiKeys.map(
  (apiKey) => new GoogleGenAI({ apiKey }),
);

const benchedUntil = new Map<string, number>();

function isRateLimitError(err: any): boolean {
  const msg = `${err?.message ?? ''} ${err?.status ?? ''} ${err?.code ?? ''}`;
  return /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(msg);
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
        benchedUntil.set(benchKey, Date.now() + (rateLimited ? RATE_LIMIT_BENCH_MS : ERROR_BENCH_MS));
        logger.warn(`Model ${model} (key #${keyIdx + 1}) failed — trying next key/model`, {
          rateLimited,
          error: String(err?.message ?? err),
        });
      }
    }
  }

  throw lastErr ?? new Error('All model/key combinations are benched or failed');
}
