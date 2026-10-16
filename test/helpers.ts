import { MockLanguageModelV4 } from 'ai/test';
import { db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { setModelOverride } from '../src/models/tarka.js';
import { identities, users } from '../src/db/repo.js';
import type { ChannelName, User } from '../src/db/types.js';
import { smsAdapter, whatsappAdapter } from '../src/channels/telnyx.js';
import { telegramAdapter } from '../src/channels/telegram.js';
import type { ChannelAdapter, OutboundMessage } from '../src/channels/types.js';

export async function resetDb(): Promise<void> {
  const sql = db();
  await sql.unsafe('drop schema if exists public cascade; create schema public; drop schema if exists pgboss cascade;');
  await migrate(sql);
}

export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

/** A model that plays back a fixed script, one entry per model call; records what it was sent. */
export function scriptedModel(steps: ScriptStep[]) {
  const calls: { prompt: unknown; tools: string[] }[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push({ prompt: options.prompt, tools: (options.tools ?? []).map((t) => (t as { name: string }).name) });
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      const content: ({ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: string })[] = [];
      if (step.text) content.push({ type: 'text', text: step.text });
      (step.toolCalls ?? []).forEach((tc, n) => content.push({ type: 'tool-call', toolCallId: `call_${i}_${n}`, toolName: tc.name, input: JSON.stringify(tc.input) }));
      return {
        content,
        finishReason: { unified: step.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: undefined },
          outputTokens: { total: 50, text: 50, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  setModelOverride(() => model);
  return { model, calls };
}

export function clearModel(): void {
  setModelOverride(undefined);
}

/** Captures what each channel adapter would have sent. */
export function captureChannels() {
  const sent: { channel: ChannelName; to: string; msg: OutboundMessage }[] = [];
  const patch = (a: ChannelAdapter) => {
    a.enabled = () => true;
    a.send = async (identity, msg) => {
      sent.push({ channel: a.name, to: identity.external_id, msg });
      return { providerMessageId: `m${sent.length}` };
    };
  };
  [smsAdapter, whatsappAdapter, telegramAdapter].forEach(patch);
  return sent;
}

export async function makeUser(over: Partial<{ name: string; timezone: string; status: User['status']; phone: string; channel: ChannelName }> = {}): Promise<User> {
  const u = await users.create({
    name: over.name ?? 'Priya',
    timezone: over.timezone ?? 'Europe/Berlin',
    status: over.status ?? 'active',
    phone: over.phone ?? '+4915112345678',
    plan: 'trial',
    trialDays: 14,
  });
  await identities.create(u.id, over.channel ?? 'sms', over.phone ?? '+4915112345678', null, true);
  return (await users.get(u.id))!;
}
