import { logger } from './logger';

// Simple model fallback: try each model in the chain; on error (rate limit or
// otherwise) bench that model briefly and try the next one. Rate-limited
// models get a longer bench so we don't burn a doomed request per message.

const RATE_LIMIT_BENCH_MS = 60_000; // 429s: skip the model for a minute
const ERROR_BENCH_MS = 30_000;      // other errors: shorter bench

const benchedUntil = new Map<string, number>();

function isRateLimitError(err: any): boolean {
  const msg = `${err?.message ?? ''} ${err?.status ?? ''} ${err?.code ?? ''}`;
  return /429|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(msg);
}

export async function withModelFallback<T>(
  models: string[],
  fn: (model: string) => Promise<T>,
): Promise<T> {
  let lastErr: any;

  for (const model of models) {
    if ((benchedUntil.get(model) ?? 0) > Date.now()) continue;

    try {
      const result = await fn(model);
      return result;
    } catch (err: any) {
      lastErr = err;
      const rateLimited = isRateLimitError(err);
      benchedUntil.set(model, Date.now() + (rateLimited ? RATE_LIMIT_BENCH_MS : ERROR_BENCH_MS));
      logger.warn(`Model ${model} failed — falling back to next in chain`, {
        rateLimited,
        error: String(err?.message ?? err),
      });
    }
  }

  throw lastErr ?? new Error('All models in the fallback chain are benched or failed');
}
