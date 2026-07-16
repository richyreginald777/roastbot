import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { getProfile } from '../db/profiles';
import { TriggerType } from '../db/interactions';
import { ChannelMessage, ThreadTurn, threadManager } from '../state/thread-manager';
import { withModelFallback } from '../utils/model-fallback';
import { generateMemeImage } from './memer';

export interface RoasterInput {
  mode: TriggerType;            // 'mention' | 'channel' | 'thread'
  channelId: string;
  userId: string;
  userName: string;
  message: string;
  channelHistory: ChannelMessage[];
  threadHistory: ThreadTurn[];
  recentBotJokes: string[];     // bot's own recent replies in this channel (cross-thread)
  forceMeme?: boolean;          // user explicitly asked for a meme
}

// --- Repetition detection -----------------------------------------------------
// Word-set Jaccard similarity against the bot's recent material. Cheap, no extra
// API call, catches "same pun retold with slightly different wrapping".

function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9஀-௿\s]/g, ' ') // keep latin + Tamil script
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function isRepeatOfRecent(text: string, previous: string[]): boolean {
  const a = wordSet(text);
  if (a.size === 0) return false;
  for (const p of previous) {
    const b = wordSet(p);
    if (b.size === 0) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const jaccard = inter / (a.size + b.size - inter);
    if (jaccard > 0.5) return true;
  }
  return false;
}

// --- Style roulette ---------------------------------------------------------------
// LLMs are poor at self-randomizing — left alone, the bot converges on one joke
// format. So variety is enforced in code: each reply gets a style directive picked
// at random, excluding the last few styles used in that channel.

interface ComedyStyle {
  name: string;
  directive: string;
}

const STYLES: ComedyStyle[] = [
  {
    name: 'tanglish_pun',
    directive: 'Tanglish phonetic pun — misinterpret an English word as a Tamil sound-alike (or invent a new pair), committed 100% literally.',
  },
  {
    name: 'deadpan_one_liner',
    directive: 'Yogi Babu deadpan — one bone-dry, under-the-breath line. Minimal words, zero excitement, maximum damage.',
  },
  {
    name: 'absurd_simile_roast',
    directive: 'Santhanam-style roast — one hyper-specific, absurd simile about them or their message ("like a run-over idli" energy). Optionally hit twice in rapid succession.',
  },
  {
    name: 'literal_suppandi',
    directive: 'Suppandi literalism — take their message 100% literally and follow the flawed logic to a ridiculous conclusion. No Tamil wordplay needed.',
  },
  {
    name: 'smiling_observation',
    directive: 'Ma Ka Pa-style — a friendly, smiling-toned but sharp observation about their behaviour or message. Sarcasm without malice.',
  },
  {
    name: 'mock_drama',
    directive: 'Vadivelu-style theatrical overreaction — treat their message as a personal catastrophe or betrayal, full melodrama, then the punchline.',
  },
  {
    name: 'callback',
    directive: 'Callback — dig into the humor profiles or thread history and reference a running joke, a past fail, or their own material against them.',
  },
  {
    name: 'plain_wit',
    directive: 'Plain sharp wit — a clean, clever joke or comeback in English. No Tamil, no puns, just good comedy-club crowd work.',
  },
  {
    name: 'self_roast',
    directive: 'Self-deprecating pivot — roast yourself (a bot, running on borrowed electricity) first, then sneak the real jab at them through the side door.',
  },
  {
    name: 'exasperation',
    directive: 'Goundamani-style escalating disbelief — start mildly confused by their message and build to comic exasperation. Keep it short.',
  },
];

const recentStylesByChannel = new Map<string, string[]>();

function pickStyle(channelId: string): ComedyStyle {
  const recent = recentStylesByChannel.get(channelId) ?? [];
  const pool = STYLES.filter((s) => !recent.includes(s.name));
  const chosen = pool[Math.floor(Math.random() * pool.length)] ?? STYLES[0];
  recentStylesByChannel.set(channelId, [...recent, chosen.name].slice(-3));
  return chosen;
}

export interface RoasterOutput {
  respond: boolean;
  response: string | null;
  memeImage?: Buffer;           // present when this reply is a meme
  tokens: { input: number; output: number };
}

// Meme mode replaces the style directive: the text reply becomes the caption,
// and the model also DESIGNS the visual — image models are illustrators, not
// comedians, so all comedy decisions happen here where the context lives.
const MEME_STYLE: ComedyStyle = {
  name: 'meme',
  directive: `MEME MODE — this reply becomes a meme image. You are the meme DESIGNER; the image model only draws what you specify.

- "response": the meme caption. HARD LIMIT 10 words (image models mangle longer text — shorter is funnier anyway). Punchy meme voice, no dialogue format, no surrounding quotes. Tanglish welcome but keep spellings simple.
- ALSO include a "memeScene" key in your JSON: 1-2 sentences describing the visual. Two allowed layouts:
  1. ONE single panel: one or two generic cartoon characters, one clear action or emotion.
  2. A simple TOP-HALF vs BOTTOM-HALF contrast — describe each half explicitly (e.g. "Top half: a developer proudly presenting a tiny fix. Bottom half: the same developer staring at 47 new bugs.").
  NEVER name meme templates or celebrities ("Drake style", "distracted boyfriend") — describe generic people and what they do. AT MOST 2 labels, 1-2 words each, and say exactly which object each label sits on. The scene must mock the ACTUAL situation in this conversation — specific people, their actual message, their actual fail — never generic office chaos.

Example: {"respond": true, "response": "Deploy pannalam, Friday dhaane", "memeScene": "A relaxed developer sips coffee at a desk while flames labeled 'FRIDAY DEPLOY' fill the room behind him."}`,
};

// --- Static system instruction -------------------------------------------------
// PROMPT-CACHING STRATEGY: this string is built ONCE and is byte-identical for
// every call, every user, every mode. Gemini's implicit context caching bills
// repeated prompt prefixes at a steep discount, but only when the prefix is
// stable — so everything dynamic (mode, profiles, histories, the message) lives
// in the user content, ordered most-stable-first:
//   [static system instruction] → [global profile] → [user profile] → [mode]
//   → [histories] → [new message]
// Watch `cachedTokens` in the logs to verify hits.

const STATIC_SYSTEM_PROMPT = `You are **RoastBot** — a Slack roast comedian for the Surfboard Payments workspace.

## Personality

- A sharp, quick-witted roast comic: think comedy-club crowd work, not corporate chatbot.
- You roast people for fun, tell jokes, and build running gags over time.
- Confidently cocky, never mean-spirited. The target should laugh, not file an HR complaint.
- You remember people: the request will include humor profiles — use them for callbacks and personalised jabs.

## Language

- Roast in **English**, **Tanglish** (Tamil-English mix), or **Tamil**.
- Sometimes mirror the language of the incoming message; sometimes switch for comedic effect. Mix it up — don't be predictable.

## Hard Rules

- Keep it SHORT: 1–3 sentences. No essays.
- Punch at behaviour, choices, messages, and code — never at protected characteristics (ethnicity, religion, gender, appearance, health).
- No slurs, no harassment, workplace-survivable at all times.
- Use Slack formatting (*bold*, _italics_, emoji) sparingly and well.
- If the message is a sincere request for help or clearly a bad moment (bad news, distress), drop the act and be briefly kind instead — a comic reads the room.

## Joke Explanations — NEVER Volunteer Them

- NEVER explain your own joke. No "Explanation:" line, no "it's funny because", no translation of the pun. The joke stands alone — if it needs a manual, it wasn't good enough, and if they don't get it, that's THEIR problem. Let it hang.
- ONLY when someone explicitly asks you to explain a joke (any phrasing, any language — "explain", "I don't get it", "what does that mean", "puriyala", etc.), do BOTH of these in one reply:
  1. **Roast them for asking.** A comedian being asked to explain a joke is a tragedy — make them feel it. The roast must be specific to THIS person, THIS joke, and THIS conversation — not a generic "explaining kills the joke" line.
  2. Then give the explanation — short, begrudging, like a professor forced to teach nursery rhymes.
- **Vary the roast angle every single time.** Check the thread history for how you reacted to previous explanation requests and pick a DIFFERENT style. Rotate through: Yogi Babu deadpan disappointment, a Santhanam-style absurd simile about their comprehension speed, Goundamani-style exasperated explosion, mock-scientific condescension ("let me dissect this frog for you"), fake sympathy ("it's okay, humor unlocks at level 5"), reluctant-teacher sighing, or invent new angles. Same energy twice in a row = you've failed as a comic.

## Variety — You Are Not a One-Trick Bot

- NEVER use the same joke structure twice in a row. Before writing, scan the thread and channel history for your own recent replies and pick a different shape.
- NEVER retell a joke, pun pair, or punchline that appears in the "Your Recent Material" list or anywhere in the thread history — not even reworded. Each of those is spent ammunition. A callback REFERENCES a past joke in passing; it never retells it.
- The request includes a **Style Directive** — treat it as a strong default for this reply. Only override it if the moment clearly demands something else (a perfect pun setup, an irresistible callback, or a sincere moment).
- Tanglish puns are a spice, not the whole meal. A great comic switches between roasting the person, absurd observations, deadpan one-liners, callbacks, and dumb literalism.

## Modes

The request will declare one of two modes:

- **DIRECT_ENGAGEMENT** (mention or thread reply): the person is talking to you. You MUST respond — "respond" is always true.
- **CHANNEL_EAVESDROPPING**: you were NOT mentioned; you're reading an ordinary channel message. Only respond if it's a genuinely good roast opportunity (someone bragging, a typo goldmine, a bold claim, an easy setup for a callback). Default to staying silent — a bot that replies to everything is annoying, and annoying is the opposite of funny. If in doubt, "respond": false.

## Output Format

Respond with EXACTLY this JSON shape:

{
  "respond": true | false,
  "response": "your roast/joke/reply as a Slack message" | null
}`;

// --- Explanation scrubber ---------------------------------------------------------
// Belt-and-suspenders: the system prompt forbids volunteering explanations, but a
// model instruction is a request, not a guarantee. If the user's message did NOT
// ask for an explanation, deterministically strip any trailing explanation block
// before the response reaches Slack.

const EXPLANATION_REQUEST_RE =
  /(explain|expln|don'?t (get|understand)|didn'?t (get|understand)|not able to understand|what (does|did) (it|that|this) mean|meaning\??|what'?s the joke|why is (it|that|this) funny|puriya?la|puriyalai|puriyale|artham enna|enna joke)/i;

function stripJokeExplanation(text: string, userMessage: string): string {
  if (EXPLANATION_REQUEST_RE.test(userMessage)) return text; // they asked — allowed

  let cleaned = text
    // "Explanation: ..." / "*Explanation*: ..." / "Why it's funny: ..." to end of message
    .replace(/\n+\s*[_*>]*\s*(explanation|why (it|this)'?s funny|why it is funny|meaning)\s*[:\-–—][\s\S]*$/i, '')
    // Trailing "It is funny because ..." / "(It's funny because ...)" sentences
    .replace(/\n+\s*[_*(]*\s*it('?s| is) funny because[\s\S]*$/i, '')
    // Same but inline at the end of a single-line response
    .replace(/\s*\(?\bit('?s| is) funny because[^)]*\)?\s*$/i, '');

  cleaned = cleaned.trim();
  if (cleaned && cleaned !== text.trim()) {
    logger.info('Stripped volunteered joke explanation from response');
  }
  return cleaned || text;
}

// --- Main roaster ---------------------------------------------------------------

export async function runRoaster(input: RoasterInput): Promise<RoasterOutput> {
  const globalProfile = await getProfile('global');
  const userProfile = await getProfile(`user:${input.userId}`);

  // Meme roll: explicit request always wins; otherwise a rare random treat,
  // gated by a per-channel cooldown so image costs stay bounded.
  const isMeme =
    input.forceMeme ||
    (threadManager.canMeme(input.channelId) && Math.random() < config.bot.memeProbability);

  const style = isMeme ? MEME_STYLE : pickStyle(input.channelId);
  const userMessage = buildUserMessage(
    input,
    globalProfile?.content || '(no global profile yet)',
    userProfile?.content || '(no profile for this user yet — first impressions matter)',
    style,
  );

  logger.info('Running Gemini roaster...', { mode: input.mode, style: style.name });

  const totalTokens = { input: 0, output: 0 };

  const callModel = async (
    contents: string,
  ): Promise<{ parsed: { respond?: boolean; response?: string | null } | null }> => {
    let usedModel = '';
    const response = await withModelFallback(config.gemini.textModels, (ai, model) => {
      usedModel = model;
      return ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: STATIC_SYSTEM_PROMPT,
          responseMimeType: 'application/json',
        },
      });
    });

    const inputTokens = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    totalTokens.input += inputTokens;
    totalTokens.output += outputTokens;
    const cachedTokens = (response.usageMetadata as any)?.cachedContentTokenCount || 0;

    logger.info('Gemini roaster responded', {
      model: usedModel,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheHitRatio: inputTokens > 0 ? +(cachedTokens / inputTokens).toFixed(2) : 0,
    });

    try {
      return { parsed: JSON.parse(response.text || '{}') };
    } catch {
      logger.error('Failed to parse roaster response', { raw: response.text });
      return { parsed: null };
    }
  };

  let { parsed } = await callModel(userMessage);

  // Repetition guard: if the reply rehashes recent material, re-roll ONCE with
  // the rejected draft shown to the model.
  if (parsed?.response && isRepeatOfRecent(parsed.response, input.recentBotJokes)) {
    logger.info('Roaster repeated recent material — re-rolling once');
    const retryMessage =
      userMessage +
      `\n\n## REJECTED DRAFT — DO NOT RESUBMIT\n\n` +
      `You already used this material in this channel:\n"${parsed.response}"\n\n` +
      `Produce something COMPLETELY different: different pun (or no pun at all), different topic, different structure.`;
    const retry = await callModel(retryMessage);
    if (retry.parsed?.response && !isRepeatOfRecent(retry.parsed.response, input.recentBotJokes)) {
      parsed = retry.parsed;
    } else if (retry.parsed?.response) {
      parsed = retry.parsed; // still similar — post it anyway rather than a third call
    }
  }

  const tokens = totalTokens;

  if (!parsed) {
    // Mentions must always get something back — fall back to a canned line
    if (input.mode !== 'channel') {
      return {
        respond: true,
        response: "My roast generator just blue-screened. Consider yourself lucky. 🔥",
        tokens,
      };
    }
    return { respond: false, response: null, tokens };
  }

  // Mentions and thread replies always get a response, even if the model tries to stay silent
  const mustRespond = input.mode !== 'channel';
  const respond = mustRespond ? true : Boolean(parsed.respond);
  const rawText = parsed.response?.trim() || null;
  const text = rawText ? stripJokeExplanation(rawText, input.message) : null;

  if (respond && !text) {
    return {
      respond: mustRespond,
      response: mustRespond ? "I had a roast ready but it was too devastating to publish. You win this round." : null,
      tokens,
    };
  }

  // Meme rendering — failure falls back to the text reply, never blocks it
  if (respond && text && isMeme) {
    const memeScene = typeof (parsed as any).memeScene === 'string' ? (parsed as any).memeScene : '';
    const image = await generateMemeImage(text, memeScene);
    if (image) {
      threadManager.markMeme(input.channelId);
      return { respond, response: text, memeImage: image, tokens };
    }
  }

  return { respond, response: respond ? text : null, tokens };
}

// --- User message (dynamic content, most-stable-first for cache hits) -----------

function buildUserMessage(
  input: RoasterInput,
  globalProfile: string,
  userProfile: string,
  style: ComedyStyle,
): string {
  const lines: string[] = [];

  // 1. Global profile — identical across ALL users and modes until the learner updates it
  lines.push('## Global Humor Profile (workspace memory)');
  lines.push('');
  lines.push(globalProfile);
  lines.push('');

  // 2. User profile — stable per person
  lines.push(`## Profile of the Person You're Talking To`);
  lines.push('');
  lines.push(userProfile);
  lines.push('');

  // 3. Mode — one of two values
  lines.push(`## Mode: ${input.mode === 'channel' ? 'CHANNEL_EAVESDROPPING' : 'DIRECT_ENGAGEMENT'}`);
  lines.push('');

  // 4. Style directive — rotates per reply, enforced in code
  lines.push(`## Style Directive (for this reply)`);
  lines.push('');
  lines.push(style.directive);
  lines.push('');

  // 5. Bot's own recent material — spent ammunition, cross-thread
  if (input.recentBotJokes.length > 0) {
    lines.push(`## Your Recent Material in This Channel (SPENT — do not reuse any pun, pair, or punchline from these)`);
    lines.push('');
    for (const joke of input.recentBotJokes) {
      lines.push(`- ${joke}`);
    }
    lines.push('');
  }

  // 4. Histories — change every message
  if (input.channelHistory.length > 0) {
    lines.push('## Recent Channel Messages (oldest first)');
    lines.push('');
    for (const m of input.channelHistory) {
      lines.push(`- ${m.userName}: ${m.text}`);
    }
    lines.push('');
  }

  if (input.threadHistory.length > 0) {
    lines.push('## Current Thread (oldest first)');
    lines.push('');
    for (const t of input.threadHistory) {
      lines.push(`- ${t.role === 'bot' ? 'RoastBot' : t.userName}: ${t.text}`);
    }
    lines.push('');
  }

  // 5. The new message
  lines.push(`## New Message from ${input.userName}`);
  lines.push('');
  lines.push(input.message);

  return lines.join('\n');
}
