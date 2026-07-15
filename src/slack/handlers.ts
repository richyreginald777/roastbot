import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { isAuthorized, getRandomUnauthorizedResponse } from '../security/access';
import { threadManager } from '../state/thread-manager';
import { runRoaster } from '../agents/roaster';
import { learnFromExchange } from '../learning/learner';
import { logInteraction, getStats, TriggerType } from '../db/interactions';
import { getAllProfiles, getProfile, rollbackProfile } from '../db/profiles';

// --- User display-name cache ---------------------------------------------------

const nameCache = new Map<string, string>();

async function getUserName(client: WebClient, userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const name =
      res.user?.profile?.display_name || res.user?.real_name || res.user?.name || userId;
    nameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// --- Helpers --------------------------------------------------------------------

function stripMention(text: string): string {
  return text.replace(new RegExp(`<@${config.slack.botUserId}>`, 'g'), '').trim();
}

function makePoster(say: any, threadTs: string): (msg: string) => Promise<void> {
  // Wrap say() with exponential-backoff retry so transient HTTP timeouts
  // don't silently drop messages (same pattern as receipt-agent).
  return async (msg: string): Promise<void> => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await say({ text: msg, thread_ts: threadTs });
        return;
      } catch (err: any) {
        if (attempt === maxAttempts) {
          logger.warn('postToSlack failed after retries', { attempt, err: String(err) });
          return;
        }
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  };
}

// --- Register all handlers -------------------------------------------------------

export function registerHandlers(app: App): void {
  // ── Direct mentions ─────────────────────────────────────────────────────────
  app.event('app_mention', async ({ event, say, client }) => {
    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const userId = event.user || '';
    const text = stripMention(event.text || '');
    const postToSlack = makePoster(say, threadTs);

    // Security check — mentions get a (funny) rejection
    if (!userId || !isAuthorized(userId)) {
      await postToSlack(getRandomUnauthorizedResponse());
      return;
    }

    // Empty mention → help
    if (!text) {
      await postToSlack(
        `🔥 I'm RoastBot. Mention me and say something — I dare you.\n\n` +
          `*Commands*:\n` +
          `• \`stats\` — Interaction and token stats\n` +
          `• \`list profiles\` — List humor profiles I've learned\n` +
          `• \`show profile <key>\` — Show a profile (e.g. \`global\` or \`user:U123\`)\n` +
          `• \`rollback profile <key>\` — Restore the previous version of a profile`,
      );
      return;
    }

    // --- Utility commands ---
    if (text.toLowerCase() === 'stats') {
      const s = await getStats();
      await postToSlack(
        `📊 *RoastBot stats*\n` +
          `• Messages seen: ${s.total}\n` +
          `• Roasts delivered: ${s.responded}\n` +
          `• Gemini tokens: ${s.tokensIn.toLocaleString()} in / ${s.tokensOut.toLocaleString()} out`,
      );
      return;
    }

    if (text.toLowerCase() === 'list profiles') {
      const profiles = await getAllProfiles();
      if (profiles.length === 0) {
        await postToSlack('No humor profiles yet. Give me material to work with.');
        return;
      }
      const lines = profiles.map(
        (p) => `• \`${p.profile_key}\` (${p.profile_type}) — v${p.version} — updated ${p.updated_at.toISOString()}`,
      );
      await postToSlack(`*Humor Profiles*\n\n${lines.join('\n')}`);
      return;
    }

    const showMatch = text.match(/^show profile\s+(\S+)$/i);
    if (showMatch) {
      const profile = await getProfile(showMatch[1]);
      if (profile) {
        await postToSlack(`*\`${profile.profile_key}\` v${profile.version}*\n\n${profile.content}`);
      } else {
        await postToSlack(`❌ No profile found for \`${showMatch[1]}\``);
      }
      return;
    }

    const rollbackMatch = text.match(/^rollback profile\s+(\S+)$/i);
    if (rollbackMatch) {
      const result = await rollbackProfile(rollbackMatch[1]);
      if (result) {
        await postToSlack(`✅ Profile \`${rollbackMatch[1]}\` rolled back to v${result.version}`);
      } else {
        await postToSlack(`❌ No history found for profile \`${rollbackMatch[1]}\``);
      }
      return;
    }

    // --- Roast flow ---
    await handleRoast('mention', channelId, threadTs, userId, text, client, postToSlack);
  });

  // ── Ordinary channel messages (and thread replies) ──────────────────────────
  app.message(async ({ message, say, client }) => {
    const msg = message as any;

    // Ignore edits/joins/etc., bot messages, and our own messages
    if (msg.subtype || msg.bot_id) return;
    const userId: string = msg.user || '';
    const text: string = msg.text || '';
    if (!userId || userId === config.slack.botUserId || !text) return;

    // Mentions arrive via app_mention too — don't double-handle
    if (text.includes(`<@${config.slack.botUserId}>`)) return;

    const channelId: string = msg.channel;
    const userName = await getUserName(client, userId);

    // Thread reply in a thread the bot is part of → always engage
    if (msg.thread_ts && threadManager.botIsInThread(channelId, msg.thread_ts)) {
      if (!isAuthorized(userId)) return; // silent for non-allowlisted users
      const postToSlack = makePoster(say, msg.thread_ts);
      await handleRoast('thread', channelId, msg.thread_ts, userId, text, client, postToSlack);
      return;
    }

    // Thread reply in an unrelated thread → ignore (not channel ambience)
    if (msg.thread_ts) return;

    // Top-level channel message → record for context, maybe jump in
    threadManager.addChannelMessage(channelId, { userId, userName, text, ts: msg.ts });

    if (!isAuthorized(userId)) return;            // silent — no roast-rejecting randoms
    if (!threadManager.canRoastUnsolicited(channelId)) return; // cooldown active

    // Reply into the message's own thread so follow-ups become a conversation
    const postToSlack = makePoster(say, msg.ts);
    await handleRoast('channel', channelId, msg.ts, userId, text, client, postToSlack);
  });

  logger.info('Slack event handlers registered');
}

// --- Shared roast flow -------------------------------------------------------------

async function handleRoast(
  mode: TriggerType,
  channelId: string,
  threadTs: string,
  userId: string,
  text: string,
  client: WebClient,
  postToSlack: (msg: string) => Promise<void>,
): Promise<void> {
  const userName = await getUserName(client, userId);

  // Explicit meme request — only honoured when talking to the bot directly
  const memeRequested =
    mode !== 'channel' && /(make|send|create|do|give)?\s*(me\s+|us\s+)?(a\s+)?meme(\s+(this|it|that|pls|please))?\b/i.test(text) && /\bmeme\b/i.test(text);

  // Record the user's turn in the thread history
  threadManager.addThreadTurn(channelId, threadTs, {
    role: 'user',
    userId,
    userName,
    text,
    ts: String(Date.now()),
  });

  try {
    const result = await runRoaster({
      mode,
      channelId,
      userId,
      userName,
      message: text,
      channelHistory: threadManager.getChannelHistory(channelId),
      threadHistory: threadManager.getThreadHistory(channelId, threadTs),
      recentBotJokes: threadManager.getRecentBotResponses(channelId),
      forceMeme: memeRequested,
    });

    // Persist the interaction regardless of outcome
    await logInteraction({
      channel: channelId,
      threadTs,
      userId,
      triggerType: mode,
      userMessage: text,
      botResponse: result.response || undefined,
      responded: result.respond,
      inputTokens: result.tokens.input,
      outputTokens: result.tokens.output,
    });

    if (!result.respond || !result.response) {
      logger.info('Roaster chose silence', { mode, channelId });
      return;
    }

    if (mode === 'channel') {
      threadManager.markUnsolicitedRoast(channelId);
    }

    if (result.memeImage) {
      // Post the caption as text too — image models garble text often enough
      // that the correctly spelled punchline below the image saves the joke
      try {
        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          file: result.memeImage,
          filename: 'roastbot-meme.png',
          initial_comment: result.response,
        });
      } catch (err: any) {
        logger.warn('Meme upload failed — falling back to text', { err: String(err) });
        await postToSlack(result.response);
      }
    } else {
      await postToSlack(result.response);
    }

    // Record the bot's turn (thread history + cross-thread channel material)
    threadManager.addThreadTurn(channelId, threadTs, {
      role: 'bot',
      userName: 'RoastBot',
      text: result.response,
      ts: String(Date.now()),
    });
    threadManager.addBotResponse(channelId, result.response);

    // Automatic learning — fire-and-forget once there's a real exchange
    // (bot spoke and the user has engaged at least once after/around it)
    const history = threadManager.getThreadHistory(channelId, threadTs);
    if (history.length >= 3) {
      learnFromExchange(userId, userName, history).catch((err) =>
        logger.warn('Learning loop error (non-fatal)', { err: String(err) }),
      );
    }
  } catch (err: any) {
    logger.error('Roast flow failed', { error: err.message, mode });
    if (mode !== 'channel') {
      await postToSlack(`❌ My comedy circuits misfired: ${err.message}`);
    }
  }
}
