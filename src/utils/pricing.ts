import { logger } from './logger';

// Standard-tier pay-as-you-go rates from the official pricing page
// (ai.google.dev/gemini-api/docs/pricing, verified July 2026).
//
// - Text models: USD per 1M input / output tokens (output includes thinking).
// - Image models: USD per 1M input tokens + a flat per-image output price at
//   1K resolution (the only size this bot generates).

interface TextPricing {
  inputPer1M: number;
  outputPer1M: number;
}

interface ImagePricing {
  inputPer1M: number;
  perImage1K: number;
}

const TEXT_PRICING: Record<string, TextPricing> = {
  'gemini-3.5-flash': { inputPer1M: 1.5, outputPer1M: 9.0 },
  'gemini-3-flash-preview': { inputPer1M: 0.5, outputPer1M: 3.0 },
  'gemini-3.1-flash-lite': { inputPer1M: 0.25, outputPer1M: 1.5 },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

const IMAGE_PRICING: Record<string, ImagePricing> = {
  'gemini-3.1-flash-lite-image': { inputPer1M: 0.25, perImage1K: 0.0336 },
  'gemini-3.1-flash-image': { inputPer1M: 0.5, perImage1K: 0.067 },
  'gemini-2.5-flash-image': { inputPer1M: 0.3, perImage1K: 0.039 },
};

/** Standard-rate cost of a text call. Unknown models cost 0 (and warn). */
export function textCallCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = TEXT_PRICING[model];
  if (!p) {
    logger.warn('No pricing entry for text model — costing as 0', { model });
    return 0;
  }
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}

/** Standard-rate cost of an image call: input tokens + one 1K image. */
export function imageCallCost(model: string, inputTokens: number): number {
  const p = IMAGE_PRICING[model];
  if (!p) {
    logger.warn('No pricing entry for image model — costing as 0', { model });
    return 0;
  }
  return (inputTokens / 1_000_000) * p.inputPer1M + p.perImage1K;
}
