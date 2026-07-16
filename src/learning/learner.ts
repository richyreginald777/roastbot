import { GoogleGenAI } from '@google/genai';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { getProfile, upsertProfile } from '../db/profiles';
import { ThreadTurn } from '../state/thread-manager';
import { withModelFallback } from '../utils/model-fallback';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// Cap profile size so the roaster prompt doesn't grow without bound
const MAX_PROFILE_CHARS = 6000;

// Static system instruction — byte-identical on every call so Gemini's
// implicit prompt caching can bill the prefix at a discount. All dynamic
// content (profiles, transcript, user name) goes in the user content.
const STATIC_LEARNER_PROMPT = `You are the **Learning Engine** of RoastBot — a Slack roast-comedy bot.

Your job: read an exchange between RoastBot and a person, judge how the humor landed, and maintain two "humor profile" documents that make the bot funnier over time. The request will contain the current profiles and the exchange transcript.

## What to Extract

- **Reactions**: Did they laugh (😂, "lol", playing along, roasting back)? Or did it fall flat / annoy them?
- **Their humor style**: What kind of jokes do THEY make? What do they find funny?
- **Personal material**: Quirks, recurring topics, running jokes, nicknames, memorable moments — future roast ammunition.
- **Language**: Which language(s) they use (English / Tanglish / Tamil) and what landed in which language.

## Rules

1. **Refine, don't append endlessly** — merge new observations into existing sections; rewrite stale ones. Profiles must stay under ~800 words each.
2. **Preserve markdown structure** — keep heading hierarchy intact.
3. **Be specific** — "his 'quick question' messages are never quick" beats "likes irony".
4. **Conservative** — if the exchange reveals nothing new, return null for that profile.
5. **Never store sensitive material** — nothing about protected characteristics, health, or genuinely private matters. Comedy ammunition only.

## Output Format

Return EXACTLY this JSON shape — full replacement documents, or null to leave a profile unchanged:

{
  "userProfile": "full updated markdown document" | null,
  "globalProfile": "full updated markdown document" | null
}`;

/**
 * Automatic learning loop — mirrors receipt-agent's context refinement, but
 * silent: no apply/discard gate. After an exchange, Gemini Flash reviews how
 * the person reacted to the bot's humor and rewrites the versioned profiles.
 * Old versions are archived in roastbot_profile_history (rollback available).
 *
 * Fire-and-forget: callers should .catch() and never block the reply on this.
 */
export async function learnFromExchange(
  userId: string,
  userName: string,
  threadHistory: ThreadTurn[],
): Promise<void> {
  // Need at least: bot said something AND the user reacted to it
  const botSpoke = threadHistory.some((t) => t.role === 'bot');
  if (!botSpoke || threadHistory.length < 2) return;

  const userKey = `user:${userId}`;
  const globalProfile = await getProfile('global');
  const userProfile = await getProfile(userKey);

  const transcript = threadHistory
    .map((t) => `${t.role === 'bot' ? 'RoastBot' : t.userName}: ${t.text}`)
    .join('\n');

  const userMessage = [
    `## Current User Profile (${userName})`,
    '',
    userProfile?.content || '(none yet — create one if the exchange reveals anything useful)',
    '',
    '## Current Global Profile (workspace-wide running jokes)',
    '',
    globalProfile?.content || '(none yet)',
    '',
    '## Exchange Transcript',
    '',
    transcript,
    '',
    'Analyse this exchange and return updated profiles (or null where no update is warranted).',
  ].join('\n');

  try {
    const response = await withModelFallback(config.gemini.textModels, (model) =>
      ai.models.generateContent({
        model,
        contents: userMessage,
        config: {
          systemInstruction: STATIC_LEARNER_PROMPT,
          responseMimeType: 'application/json',
        },
      }),
    );

    const raw = response.text || '{}';
    let parsed: { userProfile?: string | null; globalProfile?: string | null };
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.error('Failed to parse learner response', { raw });
      return;
    }

    if (parsed.userProfile && parsed.userProfile.trim()) {
      const content = parsed.userProfile.slice(0, MAX_PROFILE_CHARS);
      if (content !== userProfile?.content) {
        await upsertProfile(userKey, 'user', content);
        logger.info('Learner updated user profile', { userKey });
      }
    }

    if (parsed.globalProfile && parsed.globalProfile.trim()) {
      const content = parsed.globalProfile.slice(0, MAX_PROFILE_CHARS);
      if (content !== globalProfile?.content) {
        await upsertProfile('global', 'global', content);
        logger.info('Learner updated global profile');
      }
    }
  } catch (err: any) {
    logger.error('Learning loop failed', { error: err.message });
  }
}

