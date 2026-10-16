import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { calls, identities, users, usage } from '../db/repo.js';
import type { User } from '../db/types.js';
import { log } from '../log.js';
import { chatModel, costMicroUsd } from '../models/tarka.js';
import { runTurn } from '../agent/turn.js';
import { formatFor } from '../channels/format.js';
import { sendToUser } from '../channels/deliver.js';

/**
 * OpenAI-compatible endpoint that Telnyx AI Assistants call as their "custom LLM". Telnyx does the
 * telephony, speech-to-text and text-to-speech; this endpoint is the brain:
 *
 *  - concierge calls (extra_metadata.ta_call_id): the agent is phoning a business for a user;
 *  - inbound calls: the user rings their assistant; same memory and tools as text channels.
 */

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | { type: string; text?: string }[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

interface OAIRequest {
  model?: string;
  messages?: OAIMessage[];
  stream?: boolean;
  tools?: { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  extra_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function textOf(c: OAIMessage['content']): string {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c.map((p) => p.text ?? '').join('');
}

function authorised(c: Context): boolean {
  const secret = config().telnyx.voiceLlmSecret;
  if (!secret) return !config().isProd;
  const header = c.req.header('authorization') ?? '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function toModelMessages(msgs: OAIMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  const names = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user') out.push({ role: 'user', content: textOf(m.content) || '…' });
    else if (m.role === 'assistant') {
      const parts: ({ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown })[] = [];
      const t = textOf(m.content);
      if (t) parts.push({ type: 'text', text: t });
      for (const tc of m.tool_calls ?? []) {
        names.set(tc.id, tc.function.name);
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = {};
        }
        parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input });
      }
      if (parts.length) out.push({ role: 'assistant', content: parts });
    } else if (m.role === 'tool' && m.tool_call_id) {
      out.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: m.tool_call_id, toolName: names.get(m.tool_call_id) ?? m.name ?? 'tool', output: { type: 'text', value: textOf(m.content) } }],
      });
    }
  }
  return out;
}

/** Telnyx's own call tools (hang up, transfer, DTMF) passed through without execute functions. */
function passthroughTools(req: OAIRequest): ToolSet {
  const out: ToolSet = {};
  for (const t of req.tools ?? []) {
    if (t.type !== 'function') continue;
    out[t.function.name] = tool({
      description: t.function.description ?? '',
      inputSchema: jsonSchema((t.function.parameters ?? { type: 'object', properties: {} }) as never),
    });
  }
  return out;
}

function transcriptOf(msgs: OAIMessage[]): string {
  return msgs
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && textOf(m.content)))
    .map((m) => `${m.role === 'user' ? 'Business' : 'Assistant'}: ${textOf(m.content)}`)
    .join('\n');
}

async function conciergeReply(req: OAIRequest, callId: string): Promise<{ text: string; toolCalls: { id: string; name: string; args: string }[] }> {
  const call = await calls.get(callId);
  if (!call) return { text: "Sorry, I think I've called the wrong number. Goodbye.", toolCalls: [] };
  const user = await users.get(call.user_id);
  const msgs = req.messages ?? [];
  await calls.update(call.id, { status: 'in_progress', transcript: transcriptOf(msgs) });
  const business = (call.meta.business as string | undefined) ?? 'the business';
  const details = (call.meta.details as string | null | undefined) ?? '';
  const instructions = [
    `You are an AI assistant on a phone call to ${business}, calling on behalf of ${user?.name ?? 'your client'}.`,
    `Your objective: ${call.objective}.`,
    details ? `Details you may share when relevant: ${details}` : '',
    'Speak naturally in short sentences, like a polite, efficient human assistant. At the start, say you are an AI assistant calling on behalf of your client.',
    'Share only what is needed for the objective. Never give payment card numbers, passwords or ID numbers; say your client will handle payment directly.',
    'If they offer alternatives that are close to the objective, accept sensible ones; otherwise ask for the closest options and note them.',
    'Confirm the key details back (date, time, name, price, confirmation number) before ending. When finished, thank them, say goodbye and use the hang-up tool if you have one.',
    'If you reach voicemail or a phone menu you cannot get through, leave a brief message only if appropriate, then hang up.',
  ]
    .filter(Boolean)
    .join('\n');
  const model = config().models.defaultModel;
  const res = await generateText({
    model: chatModel(model),
    instructions,
    messages: toModelMessages(msgs).length ? toModelMessages(msgs) : [{ role: 'user', content: '(The call has connected. Start speaking.)' }],
    tools: passthroughTools(req),
    maxRetries: 1,
    timeout: { totalMs: 20_000 },
    providerOptions: { tarka: { user: call.user_id } },
  });
  const u = res.totalUsage;
  await usage.add({
    userId: call.user_id, purpose: 'voice', model, inputTokens: u.inputTokens ?? 0, cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: u.outputTokens ?? 0, costMicroUsd: costMicroUsd(model, u.inputTokens ?? 0, u.inputTokenDetails?.cacheReadTokens ?? 0, u.outputTokens ?? 0),
  });
  return {
    text: formatFor('voice', res.text ?? ''),
    toolCalls: res.toolCalls.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: JSON.stringify(tc.input ?? {}) })),
  };
}

async function personalReply(req: OAIRequest, caller: string): Promise<string> {
  let user: User | null = null;
  const identity = (await identities.find('voice', caller)) ?? (await identities.find('sms', caller)) ?? (await identities.find('whatsapp', caller));
  if (identity) user = await users.get(identity.user_id);
  if (!user) user = await users.byPhone(caller);
  if (!user) {
    return `Hi! I'm ${config().product.assistantName}, a personal assistant. I don't recognise this number yet. Text me at this number or sign up at ${config().publicUrl.replace(/^https?:\/\//, '')}, and then you can call me any time.`;
  }
  if (!identity || identity.channel !== 'voice') await identities.create(user.id, 'voice', caller, null, true);
  const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user');
  const said = textOf(lastUser?.content).trim();
  if (!said) return `Hi${user.name ? ` ${user.name}` : ''}! What can I do for you?`;
  const turn = await runTurn({ user, channel: 'voice', text: said, trigger: 'message', persistUserMessage: true });
  // Approvals are confirmed in writing, on the person's own text channel.
  for (const a of turn.approvals) {
    await sendToUser(user, `From our call — reply YES to confirm or NO to cancel:\n${a.summary}`, {
      buttons: [
        { label: 'Yes, go ahead', data: `ap:${a.id}:y` },
        { label: 'No', data: `ap:${a.id}:n` },
      ],
      persist: { role: 'assistant', meta: { source: 'approval', approvals: [a.id] } },
    }).catch((err) => log.warn({ err: String(err) }, 'could not text an approval request'));
  }
  return formatFor('voice', turn.text);
}

function completionBody(model: string, text: string, toolCalls: { id: string; name: string; args: string }[]) {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      },
    ],
  };
}

export async function voiceCompletions(c: Context): Promise<Response> {
  if (!authorised(c)) return c.json({ error: { message: 'unauthorized' } }, 401);
  const req = (await c.req.json().catch(() => ({}))) as OAIRequest;
  const meta = { ...(req.metadata ?? {}), ...(req.extra_metadata ?? {}) } as Record<string, unknown>;
  const model = req.model ?? 'tarka-assistant';
  let text = '';
  let toolCalls: { id: string; name: string; args: string }[] = [];
  try {
    if (typeof meta.ta_call_id === 'string') {
      ({ text, toolCalls } = await conciergeReply(req, meta.ta_call_id));
    } else {
      const caller = String(meta.telnyx_end_user_target ?? meta.from ?? '');
      text = caller ? await personalReply(req, caller) : "Sorry, I can't tell who's calling. Please call from the number you registered.";
    }
  } catch (err) {
    log.error({ err: String(err) }, 'voice completion failed');
    text = "Sorry, I'm having trouble right now. Please try again in a moment.";
  }

  if (!req.stream) return c.json(completionBody(model, text, toolCalls));

  return streamSSE(c, async (stream) => {
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
    await stream.writeSSE({ data: chunk({ role: 'assistant' }, null) });
    // Sentence-sized pieces let text-to-speech start sooner.
    for (const piece of text.match(/[^.!?]+[.!?]*\s*/g) ?? (text ? [text] : [])) {
      await stream.writeSSE({ data: chunk({ content: piece }, null) });
    }
    if (toolCalls.length) {
      await stream.writeSSE({
        data: chunk({ tool_calls: toolCalls.map((t, index) => ({ index, id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) }, null),
      });
    }
    await stream.writeSSE({ data: chunk({}, toolCalls.length ? 'tool_calls' : 'stop') });
    await stream.writeSSE({ data: '[DONE]' });
  });
}

export function voiceModels(c: Context): Response {
  return c.json({ object: 'list', data: [{ id: 'tarka-assistant', object: 'model', owned_by: 'tarka' }] });
}
