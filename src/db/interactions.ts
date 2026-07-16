import { query } from './client';

export type TriggerType = 'mention' | 'channel' | 'thread';

export async function logInteraction(params: {
  channel: string;
  threadTs?: string;
  userId: string;
  triggerType: TriggerType;
  userMessage: string;
  botResponse?: string;
  responded: boolean;
  inputTokens: number;
  outputTokens: number;
  modelUsed?: string;
  costUsd?: number;
}): Promise<void> {
  await query(
    `INSERT INTO roastbot_interactions
       (slack_channel, slack_thread_ts, slack_user_id, trigger_type,
        user_message, bot_response, responded, gemini_input_tokens, gemini_output_tokens,
        model_used, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      params.channel,
      params.threadTs || null,
      params.userId,
      params.triggerType,
      params.userMessage,
      params.botResponse || null,
      params.responded,
      params.inputTokens,
      params.outputTokens,
      params.modelUsed || null,
      params.costUsd ?? 0,
    ],
  );
}

export async function getStats(): Promise<{
  total: number;
  responded: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}> {
  const result = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE responded)::int AS responded,
            COALESCE(SUM(gemini_input_tokens), 0)::int AS tokens_in,
            COALESCE(SUM(gemini_output_tokens), 0)::int AS tokens_out,
            COALESCE(SUM(cost_usd), 0)::float AS cost_usd
     FROM roastbot_interactions`,
  );
  const row = result.rows[0];
  return {
    total: row.total,
    responded: row.responded,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
  };
}
