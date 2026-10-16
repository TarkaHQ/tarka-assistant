import { HindsightClient, type RecallResponse } from '@vectorize-io/hindsight-client';
import { config } from '../config.js';
import { users } from '../db/repo.js';
import type { User } from '../db/types.js';
import { log } from '../log.js';

/**
 * Long-term memory, one Hindsight bank per user ("isolation by structure": the agent can only
 * ever reach the bank this module derives from the user it is serving).
 *
 *  - every exchange is retained asynchronously (Hindsight extracts facts, entities and time);
 *  - before each reply we recall what is relevant to the new message;
 *  - a "profile" mental model is kept fresh by Hindsight and injected into every prompt;
 *  - the user can browse and delete memories from the dashboard.
 */

const PROFILE_MODEL_ID = 'profile';

const RETAIN_MISSION = [
  'This bank is the long-term memory of a personal assistant for one person (the user).',
  'Extract durable, useful facts: who the user is; the people in their life, with names and relationships;',
  'preferences and dislikes (food, travel, brands, communication style); routines and schedules; work and projects;',
  'goals, plans and dates; commitments made by the user or promised by the assistant (follow-ups, deadlines);',
  'and the outcomes of tasks the assistant carried out. Ignore greetings and small talk.',
  'Never store passwords, one-time codes, full payment card or bank account numbers, or government ID numbers.',
].join(' ');

const REFLECT_MISSION =
  'You are the memory of a personal assistant. Answer questions about the user so the assistant can help them well and proactively: their preferences, people, plans, commitments and history. Be specific and say when something is uncertain or out of date.';

const PROFILE_QUERY = [
  'Write a compact profile of the user for their personal assistant, as short bullet points:',
  'name and how they like to be addressed; where they live and their timezone; family and close people (names, relationship, key facts);',
  'work; routines; strong preferences and dislikes; current goals and projects; upcoming plans and dates; open commitments or follow-ups.',
  'Only include what the memories support. Omit any section with nothing known.',
].join(' ');

/** Patterns we never send to memory even if the user typed them. */
const SECRET_PATTERNS: RegExp[] = [
  /\b\d(?:[ -]?\d){12,18}\b/g, // card-like numbers
  /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
  /\b(?:code|otp|passcode|verification code|pin)\s*(?:is|:)?\s*\d{4,8}\b/gi,
  /\bpassword\s*(?:is|:)\s*\S+/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

export interface MemoryItem {
  id: string;
  text: string;
  type?: string | null;
  when?: string | null;
  context?: string | null;
}

class Memory {
  private client: HindsightClient;
  private ensured = new Set<string>();

  constructor() {
    const cfg = config();
    this.client = new HindsightClient({
      baseUrl: cfg.memory.url,
      apiKey: cfg.memory.apiKey,
      userAgent: 'tarka-assistant/0.1',
      maxAttempts: 2,
    });
  }

  get enabled(): boolean {
    return config().memory.enabled;
  }

  bankId(user: Pick<User, 'id' | 'memory_bank'>): string {
    return user.memory_bank ?? `user-${user.id}`;
  }

  /** Creates (or updates) the user's bank, its missions and the profile mental model. Idempotent. */
  async ensureBank(user: User): Promise<string> {
    const bank = this.bankId(user);
    if (!this.enabled || this.ensured.has(bank)) return bank;
    await this.client.createBank(bank, {
      name: user.name ? `${user.name}` : `user ${user.id.slice(0, 8)}`,
      reflectMission: REFLECT_MISSION,
      retainMission: RETAIN_MISSION,
      enableObservations: true,
    });
    try {
      await this.client.getMentalModel(bank, PROFILE_MODEL_ID, { detail: 'metadata' });
    } catch {
      await this.client
        .createMentalModel(bank, 'About the user', PROFILE_QUERY, {
          id: PROFILE_MODEL_ID,
          maxTokens: 900,
          trigger: { refreshAfterConsolidation: true, minRefreshIntervalSeconds: 1800, mode: 'delta' },
        })
        .catch((err) => log.warn({ err: String(err), bank }, 'could not create profile mental model'));
    }
    if (!user.memory_bank) await users.update(user.id, { memory_bank: bank });
    this.ensured.add(bank);
    return bank;
  }

  /** Memories relevant to a message, formatted for the prompt. Never throws; returns '' on failure. */
  async recallForPrompt(user: User, query: string, maxTokens = 1200): Promise<{ text: string; items: MemoryItem[]; ms: number }> {
    const started = Date.now();
    if (!this.enabled || !query.trim()) return { text: '', items: [], ms: 0 };
    try {
      const bank = await this.ensureBank(user);
      const res = await this.client.recall(bank, query.slice(0, 2000), {
        budget: 'low',
        maxTokens,
        signal: AbortSignal.timeout(config().memory.recallTimeoutMs),
      });
      const items = toItems(res);
      return { text: formatItems(items, user.timezone), items, ms: Date.now() - started };
    } catch (err) {
      log.warn({ err: String(err), user: user.id }, 'memory recall failed; continuing without it');
      return { text: '', items: [], ms: Date.now() - started };
    }
  }

  /** Stores one conversational exchange. Asynchronous on the Hindsight side. */
  async retainExchange(user: User, ex: { userText: string; assistantText: string; channel: string; at: Date; documentId: string }): Promise<void> {
    if (!this.enabled) return;
    const bank = await this.ensureBank(user);
    const who = user.name ?? 'User';
    const content = `${who}: ${redactSecrets(ex.userText)}\nAssistant: ${redactSecrets(ex.assistantText)}`;
    await this.client.retain(bank, content, {
      timestamp: ex.at,
      context: `conversation over ${ex.channel}`,
      documentId: ex.documentId,
      tags: [`channel:${ex.channel}`],
      async: true,
    });
  }

  /** Stores an explicit fact ("remember that…") or an outcome the assistant wants to keep. */
  async remember(user: User, fact: string, context = 'stated by the user'): Promise<void> {
    if (!this.enabled) throw new Error('Memory is switched off');
    const bank = await this.ensureBank(user);
    await this.client.retain(bank, redactSecrets(fact), { timestamp: new Date(), context, tags: ['explicit'], async: true });
  }

  async search(user: User, query: string, maxTokens = 2000): Promise<MemoryItem[]> {
    if (!this.enabled) return [];
    const bank = await this.ensureBank(user);
    const res = await this.client.recall(bank, query, { budget: 'mid', maxTokens });
    return toItems(res);
  }

  /** Deep question over everything known about the user (an agentic loop inside Hindsight). */
  async reflect(user: User, question: string): Promise<string> {
    if (!this.enabled) return '';
    const bank = await this.ensureBank(user);
    const res = await this.client.reflect(bank, question, { budget: 'low' });
    return (res as { text?: string }).text ?? '';
  }

  /** The profile mental model's current content (cached on the user row by the caller). */
  async profile(user: User): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const bank = await this.ensureBank(user);
      const mm = await this.client.getMentalModel(bank, PROFILE_MODEL_ID, { detail: 'content' });
      const content = (mm as { content?: string | null }).content;
      return content && content.trim() ? content.trim() : null;
    } catch {
      return null;
    }
  }

  async refreshProfile(user: User): Promise<void> {
    if (!this.enabled) return;
    const bank = await this.ensureBank(user);
    await this.client.refreshMentalModel(bank, PROFILE_MODEL_ID).catch((err) => log.warn({ err: String(err) }, 'profile refresh failed'));
  }

  async list(user: User, opts: { offset?: number; limit?: number; q?: string } = {}): Promise<{ items: MemoryItem[]; total: number }> {
    if (!this.enabled) return { items: [], total: 0 };
    const bank = await this.ensureBank(user);
    const res = await this.client.listMemories(bank, {
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      q: opts.q || undefined,
      state: 'valid',
    });
    const items = (res.items ?? []).map((m) => {
      const r = m as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        text: String(r.text ?? ''),
        type: (r.fact_type as string | null) ?? null,
        when: (r.occurred_start as string | null) ?? (r.mentioned_at as string | null) ?? (r.date as string | null) ?? null,
        context: (r.context as string | null) ?? null,
      };
    });
    return { items, total: res.total ?? items.length };
  }

  /** Soft-deletes one memory (Hindsight "invalidated" state removes it from recall). */
  async forget(user: User, memoryId: string, reason = 'removed by the user'): Promise<void> {
    const bank = this.bankId(user);
    const cfg = config();
    const res = await fetch(`${cfg.memory.url}/v1/default/banks/${encodeURIComponent(bank)}/memories/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(cfg.memory.apiKey ? { Authorization: `Bearer ${cfg.memory.apiKey}` } : {}) },
      body: JSON.stringify({ state: 'invalidated', reason }),
    });
    if (!res.ok) throw new Error(`Could not forget memory: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  /** Deletes the whole bank (account deletion or "forget everything"). */
  async wipe(user: User): Promise<void> {
    if (!this.enabled) return;
    const bank = this.bankId(user);
    await this.client.deleteBank(bank).catch((err) => log.warn({ err: String(err) }, 'bank delete failed'));
    this.ensured.delete(bank);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${config().memory.url}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function toItems(res: RecallResponse): MemoryItem[] {
  return (res.results ?? []).map((r) => ({
    id: r.id,
    text: r.text,
    type: r.type ?? null,
    when: r.occurred_start ?? r.mentioned_at ?? null,
    context: r.context ?? null,
  }));
}

export function formatItems(items: MemoryItem[], timezone: string): string {
  if (items.length === 0) return '';
  return items
    .map((m) => {
      const when = m.when ? ` (${shortDate(m.when, timezone)})` : '';
      return `- ${m.text.replace(/\s+/g, ' ').trim()}${when}`;
    })
    .join('\n');
}

function shortDate(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export const memory = new Memory();
