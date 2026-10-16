import { generateText, jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { audit, calls, identities, kv, users, usage } from '../db/repo.js';
import type { CallRow, User } from '../db/types.js';
import { log } from '../log.js';
import { chatModel, costMicroUsd } from '../models/tarka.js';
import { approvalButtons, withApprovalNotice } from '../agent/approvals.js';
import { runTurn } from '../agent/turn.js';
import { formatFor, usableReply } from '../channels/format.js';
import { sendToUser } from '../channels/deliver.js';
import { proactiveChannel } from '../proactive/scheduler.js';
import { upgradeLink } from '../web/links.js';
import { checkCaller, pinAttempt } from './pin.js';

/**
 * OpenAI-compatible endpoint that Telnyx AI Assistants call as their "custom LLM". Telnyx does the
 * telephony, speech-to-text and text-to-speech; this endpoint is the brain:
 *
 *  - concierge calls (extra_metadata.ta_call_id): the agent is phoning a business for a user;
 *  - inbound calls: the user rings their assistant. Caller ID can be faked, so a caller gets their
 *    memory and tools only when the carrier vouches for the number (STIR/SHAKEN "A") or they say
 *    their voice PIN; otherwise a restricted assistant with nothing personal answers.
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

/** A concierge call is only served while it is live, recent, and to the number the user approved. */
function conciergeCallValid(call: CallRow | null, meta: Record<string, unknown>): call is CallRow {
  if (!call || call.direction !== 'outbound') return false;
  if (!['scheduled', 'in_progress', 'queued'].includes(call.status)) return false;
  if (Date.now() - call.created_at.getTime() > 3 * 3600_000) return false;
  const target = typeof meta.telnyx_end_user_target === 'string' ? meta.telnyx_end_user_target : null;
  return !target || !call.to_number || target === call.to_number;
}

async function conciergeReply(req: OAIRequest, callId: string, meta: Record<string, unknown>): Promise<{ text: string; toolCalls: { id: string; name: string; args: string }[] }> {
  const call = await calls.get(callId).catch(() => null);
  if (!conciergeCallValid(call, meta)) return { text: "Sorry, I think I've called the wrong number. Goodbye.", toolCalls: [] };
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
    text: formatFor('voice', usableReply(res.text ?? '')),
    toolCalls: res.toolCalls.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: JSON.stringify(tc.input ?? {}) })),
  };
}

function planAllows(user: User): boolean {
  if (!config().stripe.enabled || user.plan !== 'trial') return true;
  return !user.trial_ends_at || user.trial_ends_at.getTime() > Date.now();
}

/** Once per `hours` per key (stops a looping call from texting the user over and over). */
async function onceEvery(key: string, hours: number): Promise<boolean> {
  const last = await kv.get<number>(key);
  if (last && Date.now() - last < hours * 3600_000) return false;
  await kv.set(key, Date.now());
  return true;
}

/** This call's earlier turns for an unverified caller, with anything that looks like a PIN removed. */
function callHistory(msgs: OAIMessage[]): ModelMessage[] {
  const turns = msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && textOf(m.content).trim());
  const lastUser = turns.map((m) => m.role).lastIndexOf('user');
  const out: ModelMessage[] = [];
  for (const m of turns.slice(0, lastUser)) {
    const text = textOf(m.content).trim();
    const content = m.role === 'user' && pinAttempt(text) ? '[said a PIN]' : text;
    out.push(m.role === 'user' ? { role: 'user', content } : { role: 'assistant', content });
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

async function personalReply(req: OAIRequest, caller: string, meta: Record<string, unknown>): Promise<string> {
  const cfg = config();
  let user: User | null = null;
  const identity = (await identities.find('voice', caller)) ?? (await identities.find('sms', caller)) ?? (await identities.find('whatsapp', caller));
  if (identity) user = await users.get(identity.user_id);
  if (!user) user = await users.byPhone(caller);
  if (!user) {
    return `Hi! I'm ${cfg.product.assistantName}, a personal assistant. I don't recognise this number yet. Text me at this number or sign up at ${cfg.publicUrl.replace(/^https?:\/\//, '')}, and then you can call me any time.`;
  }
  if (user.status === 'deleted' || user.status === 'paused') return 'Sorry, this assistant is switched off right now. Goodbye.';
  if (!identity || identity.channel !== 'voice') await identities.create(user.id, 'voice', caller, null, true).catch(() => {});

  const utterances = (req.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content).trim()).filter(Boolean);
  const said = utterances.at(-1) ?? '';
  const attestation = typeof meta.telnyx_shaken_stir_attestation === 'string' ? meta.telnyx_shaken_stir_attestation : undefined;
  const check = await checkCaller(user, utterances, attestation);
  if (check.notify) {
    // Every wrong PIN is reported to the account holder, so slow guessing can't go unnoticed.
    await sendToUser(user, check.notify, { proactive: true, persist: { role: 'assistant', meta: { source: 'security' } } }).catch(() => {});
    await audit.add(user.id, 'system', 'voice.pin_wrong', { summary: 'A wrong voice PIN was said on a call' });
  }
  // A PIN utterance is answered here in code; it never reaches the model or the conversation.
  if (check.pinReply) return check.pinReply;

  const name = user.assistant_name || cfg.product.assistantName;
  if (!said) {
    if (check.trusted) return `Hi${user.name ? ` ${user.name}` : ''}! What can I do for you?`;
    return user.settings.voicePin
      ? `Hi! It's ${name}. Say your voice PIN for anything personal, or just ask me something general.`
      : `Hi! It's ${name}. What can I do for you?`;
  }

  if (!planAllows(user)) {
    if (await onceEvery(`voice-trial:${user.id}`, 6)) {
      await sendToUser(user, `Your free trial has ended. Keep me going for ${cfg.product.priceLabel}: ${upgradeLink(user)}`, { persist: { role: 'assistant' } }).catch(() => {});
    }
    return "Your free trial has ended, so I can't help on calls right now. I've texted you a link to keep me going.";
  }

  if (!check.trusted) {
    // Caller ID alone isn't proof: a restricted assistant with nothing personal, and nothing stored.
    // (The activity entry doesn't quote the caller: their words would land in the owner's dashboard.)
    if (utterances.length === 1) await audit.add(user.id, 'system', 'voice.unverified_call', { summary: `Unverified call from ${caller.slice(0, 4)}…${caller.slice(-4)}; nothing personal was shared` });
    const turn = await runTurn({
      user, channel: 'voice', text: said, trigger: 'message',
      restricted: { pinSet: Boolean(user.settings.voicePin), history: callHistory(req.messages ?? []) },
    });
    return formatFor('voice', turn.text);
  }

  const turn = await runTurn({ user, channel: 'voice', text: said, trigger: 'message', persistUserMessage: true, userMeta: { verifiedBy: check.how } });
  // Approvals are confirmed in writing, on the person's own text channel.
  if (turn.approvals.length) {
    const channel = await proactiveChannel(user);
    await sendToUser(user, withApprovalNotice('From our call:', turn.approvals, channel === 'web' ? 'sms' : channel), {
      channel,
      buttons: approvalButtons(turn.approvals),
      persist: { role: 'assistant', meta: { source: 'approval', approvals: turn.approvals.map((a) => a.id) } },
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
      ({ text, toolCalls } = await conciergeReply(req, meta.ta_call_id, meta));
    } else {
      const caller = String(meta.telnyx_end_user_target ?? meta.from ?? '');
      text = caller ? await personalReply(req, caller, meta) : "Sorry, I can't tell who's calling. Please call from the number you registered.";
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
