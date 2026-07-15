import { config } from '../utils/config';
import { logger } from '../utils/logger';

export interface ChannelMessage {
  userId: string;
  userName: string;
  text: string;
  ts: string;
}

export interface ThreadTurn {
  role: 'user' | 'bot';
  userId?: string;
  userName: string;
  text: string;
  ts: string;
}

interface ChannelState {
  recentMessages: ChannelMessage[];
  recentBotResponses: string[];   // bot's own recent jokes in this channel (any thread)
  lastUnsolicitedRoastAt: number; // epoch ms, 0 = never
  lastMemeAt: number;             // epoch ms, 0 = never
  updatedAt: number;
}

const MAX_RECENT_BOT_RESPONSES = 10;

interface ThreadState {
  turns: ThreadTurn[];
  botParticipated: boolean;
  updatedAt: number;
}

const MAX_THREAD_TURNS = 20;

class ThreadManager {
  private channels = new Map<string, ChannelState>();
  private threads = new Map<string, ThreadState>();

  private threadKey(channelId: string, threadTs: string): string {
    return `${channelId}::${threadTs}`;
  }

  // --- Channel rolling buffer -------------------------------------------------

  private getChannel(channelId: string): ChannelState {
    let state = this.channels.get(channelId);
    if (!state) {
      state = { recentMessages: [], recentBotResponses: [], lastUnsolicitedRoastAt: 0, lastMemeAt: 0, updatedAt: Date.now() };
      this.channels.set(channelId, state);
    }
    return state;
  }

  addChannelMessage(channelId: string, msg: ChannelMessage): void {
    const state = this.getChannel(channelId);
    state.recentMessages.push(msg);
    if (state.recentMessages.length > config.bot.channelHistoryLimit) {
      state.recentMessages.shift();
    }
    state.updatedAt = Date.now();
  }

  getChannelHistory(channelId: string): ChannelMessage[] {
    return this.getChannel(channelId).recentMessages;
  }

  // --- Bot's own recent material (cross-thread, per channel) --------------------

  addBotResponse(channelId: string, text: string): void {
    const state = this.getChannel(channelId);
    state.recentBotResponses.push(text);
    if (state.recentBotResponses.length > MAX_RECENT_BOT_RESPONSES) {
      state.recentBotResponses.shift();
    }
    state.updatedAt = Date.now();
  }

  getRecentBotResponses(channelId: string): string[] {
    return this.getChannel(channelId).recentBotResponses;
  }

  // --- Meme cooldown -------------------------------------------------------------

  canMeme(channelId: string): boolean {
    const state = this.getChannel(channelId);
    const cooldownMs = config.bot.memeCooldownMinutes * 60 * 1000;
    return Date.now() - state.lastMemeAt >= cooldownMs;
  }

  markMeme(channelId: string): void {
    const state = this.getChannel(channelId);
    state.lastMemeAt = Date.now();
    state.updatedAt = Date.now();
  }

  // --- Unsolicited-roast cooldown ----------------------------------------------

  canRoastUnsolicited(channelId: string): boolean {
    const state = this.getChannel(channelId);
    const cooldownMs = config.bot.cooldownMinutes * 60 * 1000;
    return Date.now() - state.lastUnsolicitedRoastAt >= cooldownMs;
  }

  markUnsolicitedRoast(channelId: string): void {
    const state = this.getChannel(channelId);
    state.lastUnsolicitedRoastAt = Date.now();
    state.updatedAt = Date.now();
  }

  // --- Thread conversation history ----------------------------------------------

  addThreadTurn(channelId: string, threadTs: string, turn: ThreadTurn): void {
    const key = this.threadKey(channelId, threadTs);
    let state = this.threads.get(key);
    if (!state) {
      state = { turns: [], botParticipated: false, updatedAt: Date.now() };
      this.threads.set(key, state);
    }
    state.turns.push(turn);
    if (turn.role === 'bot') state.botParticipated = true;
    if (state.turns.length > MAX_THREAD_TURNS) state.turns.shift();
    state.updatedAt = Date.now();
  }

  getThreadHistory(channelId: string, threadTs: string): ThreadTurn[] {
    return this.threads.get(this.threadKey(channelId, threadTs))?.turns ?? [];
  }

  botIsInThread(channelId: string, threadTs: string): boolean {
    return this.threads.get(this.threadKey(channelId, threadTs))?.botParticipated ?? false;
  }

  // --- Cleanup ---------------------------------------------------------------

  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, state] of this.threads) {
      if (now - state.updatedAt > maxAgeMs) {
        this.threads.delete(key);
        logger.info(`Thread state cleaned up: ${key}`);
      }
    }
    for (const [key, state] of this.channels) {
      if (now - state.updatedAt > maxAgeMs) {
        this.channels.delete(key);
        logger.info(`Channel state cleaned up: ${key}`);
      }
    }
  }
}

export const threadManager = new ThreadManager();
