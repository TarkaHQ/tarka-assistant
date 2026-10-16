import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { config } from '../config.js';
import { integrations, kv, messages, routines, usage, users, approvals as approvalsRepo, audit } from '../db/repo.js';
import type { Approval, ChannelName, MessageRow, User } from '../db/types.js';
import { log } from '../log.js';
import { memory } from '../memory/hindsight.js';
import { chatModel, costMicroUsd, modelInfo } from '../models/tarka.js';
import { startOfLocalMonth } from '../util/time.js';
import { sandboxesAvailable } from '../models/sandbox.js';
import { hasLeakedTokens, usableReply } from '../channels/format.js';
import { enqueue } from '../jobs/queue.js';
import { buildInstructions, type Trigger } from './prompt.js';
import { requestApproval } from './approvals.js';
import { allTools, toolLabel } from './tools/index.js';
import { primeGoogleAvailability } from './tools/google.js';
import { toAiTools, UNVERIFIED_VOICE_TOOLS, type ToolContext } from './tools/spec.js';

export interface TurnInput {
  user: User;
  channel: ChannelName;
  /** The user's message (with transcripts/OCR folded in) or a task's instructions. */
  text: string;
  trigger: Trigger;
  /** Shown to the model as the routine/task title for scheduled triggers. */
  title?: string;
  /** Persist `text` as the user's message (true for real messages). */
  persistUserMessage?: boolean;
  /** The user's message is already stored (a retried job): use this row instead of adding one. */
  existingUserMessageId?: number;
  userMeta?: Record<string, unknown>;
  onStatus?: (label: string) => void;
  progress?: (text: string) => Promise<void>;
  abortSignal?: AbortSignal;
  /**
   * An unverified phone call: no history, memory or personal context; a few harmless tools; and
   * nothing is written to the conversation or memory (the caller might not be the account holder).
   * `history` is the call's own earlier turns.
   */
  restricted?: { pinSet: boolean; history: ModelMessage[] };
}

export interface TurnTrace {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  memoryMs: number;
  memoriesUsed: number;
  steps: number;
  tools: string[];
}

export interface TurnResult {
  text: string;
  /** The model decided there was nothing worth sending (scheduled triggers only). */
  silent: boolean;
  approvals: Approval[];
  trace: TurnTrace;
  messageId?: number;
  activity: { tool: string; summary: string }[];
}

const NO_MESSAGE = /^\s*NO_MESSAGE\s*\.?\s*$/;
const HISTORY_ROWS = 30;
const HISTORY_CHARS = 16_000;

export function pickModel(user: User): string {
  const cfg = config();
  return user.model && cfg.models.allowed.includes(user.model) ? user.model : cfg.models.defaultModel;
}

/**
 * The model for this turn, keeping the plan's margin: someone who picked a pricier model gets the
 * default model for the rest of the month once their model spend passes MODEL_BUDGET_USD_PER_MONTH.
 */
async function modelWithinBudget(user: User): Promise<{ model: string; overBudget: boolean }> {
  const cfg = config();
  const chosen = pickModel(user);
  if (chosen === cfg.models.defaultModel || cfg.models.budgetMicroUsdPerMonth <= 0) return { model: chosen, overBudget: false };
  const spent = await usage.costSince(user.id, startOfLocalMonth(user.timezone));
  if (spent < cfg.models.budgetMicroUsdPerMonth) return { model: chosen, overBudget: false };
  return { model: cfg.models.defaultModel, overBudget: true };
}

/** Conversation rows → model messages: merged by role, starting with a user turn, capped in size. */
export function historyToMessages(rows: MessageRow[]): ModelMessage[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  let budget = HISTORY_CHARS;
  for (const row of [...rows].reverse()) {
    const role = row.role === 'user' ? 'user' : 'assistant';
    const content = row.role === 'event' ? `[note] ${row.content}` : row.content;
    if (budget - content.length < 0 && out.length > 0) break;
    budget -= content.length;
    out.unshift({ role, content });
  }
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0]!.role !== 'user') merged.shift();
  return merged;
}

function trialDaysLeft(user: User): number | null {
  if (user.plan !== 'trial' || !user.trial_ends_at) return null;
  return Math.max(0, Math.ceil((user.trial_ends_at.getTime() - Date.now()) / 86_400_000));
}

async function profileFor(user: User): Promise<string | null> {
  const stale = !user.profile_refreshed_at || Date.now() - user.profile_refreshed_at.getTime() > 3 * 3600_000;
  if (stale && memory.enabled) {
    // Refresh the cached copy in the background; use what we have now.
    void memory
      .profile(user)
      .then((p) => users.update(user.id, { profile_summary: p, profile_refreshed_at: new Date() }))
      .catch(() => {});
  }
  return user.profile_summary;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const cfg = config();
  const started = Date.now();
  const user = (await users.get(input.user.id)) ?? input.user;
  const now = new Date();
  const restricted = input.restricted;

  // 1. Gather context in parallel (none of it for an unverified caller).
  const historyP = restricted ? Promise.resolve([] as MessageRow[]) : messages.recent(user.id, HISTORY_ROWS);
  let userMessage: MessageRow | undefined;
  if (input.persistUserMessage && !restricted && !input.existingUserMessageId) {
    userMessage = await messages.add(user.id, 'user', input.channel, input.text, input.userMeta ?? {});
  }
  const userMessageId = userMessage?.id ?? input.existingUserMessageId;
  const memoryQuery = input.trigger === 'message' ? input.text : `${input.title ?? input.trigger} ${input.text}`.slice(0, 1000);
  const [history, recalled, upcoming, pending, googleConnected, integ, profile] = await Promise.all([
    historyP,
    restricted ? Promise.resolve({ text: '', items: [], ms: 0 }) : memory.recallForPrompt(user, memoryQuery),
    restricted ? Promise.resolve([]) : routines.forUser(user.id).then((rs) => rs.filter((r) => r.status === 'active')),
    restricted ? Promise.resolve([]) : approvalsRepo.pending(user.id),
    restricted ? Promise.resolve(false) : primeGoogleAvailability(user.id),
    restricted ? Promise.resolve(null) : integrations.get(user.id, 'google'),
    restricted ? Promise.resolve(null) : profileFor(user),
  ]);

  // 2. Messages: prior conversation, then this turn.
  const prior = restricted ? restricted.history : historyToMessages(history.filter((m) => m.id !== userMessageId));
  let finalUser: string;
  switch (input.trigger) {
    case 'message':
      finalUser = input.text;
      break;
    case 'brief':
      finalUser = '[It is time for the morning brief.]';
      break;
    case 'checkin':
      finalUser = '[Scheduled check-in: is there anything worth flagging right now?]';
      break;
    case 'routine':
      finalUser = `[Scheduled task "${input.title ?? 'task'}"]\n${input.text}`;
      break;
    default:
      finalUser = input.text;
  }
  const modelMessages: ModelMessage[] = [...prior, { role: 'user', content: finalUser }];

  // 3. Tools for this user and turn.
  const ctx: ToolContext & { created: Approval[] } = {
    user,
    channel: input.channel,
    now,
    trigger: input.trigger,
    restricted: Boolean(restricted),
    progress: input.progress,
    activity: [],
    created: [],
  };
  const toolsUsed: string[] = [];
  const tools = toAiTools(
    allTools,
    ctx,
    requestApproval,
    (name) => {
      toolsUsed.push(name);
      input.onStatus?.(toolLabel(name));
    },
    restricted ? UNVERIFIED_VOICE_TOOLS : undefined,
  );

  const { model: primary, overBudget } = await modelWithinBudget(user);
  if (overBudget && (await kv.get(`budget-note:${user.id}:${startOfLocalMonth(user.timezone).toISOString().slice(0, 7)}`)) === null) {
    await kv.set(`budget-note:${user.id}:${startOfLocalMonth(user.timezone).toISOString().slice(0, 7)}`, Date.now());
    await messages.add(user.id, 'event', input.channel, `This month's allowance for ${modelInfo(pickModel(user)).label} is used up, so replies use ${modelInfo(primary).label} until the 1st.`);
  }

  const instructions = buildInstructions({
    user,
    channel: input.channel,
    now,
    trigger: input.trigger,
    model: primary,
    profile,
    memories: recalled.text,
    upcoming,
    pending,
    googleAccount: googleConnected ? (integ?.account ?? 'connected') : null,
    capabilities: {
      search: cfg.search.provider !== 'none',
      phone: Boolean(cfg.telnyx.apiKey && cfg.telnyx.conciergeAssistantId && cfg.telnyx.phoneNumber),
      code: sandboxesAvailable(),
      google: googleConnected,
      googleAvailable: cfg.google.enabled,
      memory: cfg.memory.enabled,
      billing: cfg.stripe.enabled,
    },
    trialDaysLeft: trialDaysLeft(user),
    restricted: restricted ? { pinSet: restricted.pinSet } : undefined,
  });

  // 4. Generate, with one fallback model on provider failure. Only when no tool has run yet:
  //    a retry after a tool ran could repeat what it did (a second reminder, a second request).
  const candidates = [primary, ...(cfg.models.fallbackModel && cfg.models.fallbackModel !== primary ? [cfg.models.fallbackModel] : [])];
  let result: Awaited<ReturnType<typeof generateText>> | undefined;
  let usedModel = primary;
  let lastErr: unknown;
  for (const modelId of candidates) {
    if (toolsUsed.length > 0) break;
    try {
      result = await generateText({
        model: chatModel(modelId),
        instructions,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(cfg.models.maxSteps),
        maxRetries: 2,
        abortSignal: input.abortSignal,
        timeout: { totalMs: input.channel === 'voice' ? 25_000 : 150_000 },
        providerOptions: { tarka: { user: user.id } },
      });
      usedModel = modelId;
      break;
    } catch (err) {
      lastErr = err;
      log.warn({ err: String(err), model: modelId, user: user.id }, 'model call failed');
    }
  }
  if (!result) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

  // Some models now and then finish with an empty message, the answer left in their reasoning
  // or a tool call lost on the way (Kimi K3 on Tarka did in about a third of tool loops in
  // October 2026). Ask again, up to twice, from where it stopped, tools included: what already
  // ran is in the history with its result, so the model carries on rather than starting over.
  const retryUsage = { inputTokens: 0, cached: 0, outputTokens: 0 };
  let retryText = '';
  let retrySteps = 0;
  // An empty or garbled reply (control tokens leaked as text) is asked again, never shown.
  let lastEmpty = !usableReply(result.text ?? '') && (result.finishReason === 'stop' || hasLeakedTokens(result.text ?? ''));
  let sofar = [...result.responseMessages]; // every step so far (result.response is only the last)
  for (let attempt = 1; attempt <= 2 && lastEmpty && !input.abortSignal?.aborted; attempt++) {
    if (sofar.at(-1)?.role === 'assistant') sofar = sofar.slice(0, -1); // the empty message
    try {
      const again = await generateText({
        model: chatModel(usedModel),
        instructions,
        messages: [...modelMessages, ...sofar],
        tools,
        stopWhen: stepCountIs(cfg.models.maxSteps),
        maxRetries: 1,
        abortSignal: input.abortSignal,
        timeout: { totalMs: input.channel === 'voice' ? 10_000 : 90_000 },
        providerOptions: { tarka: { user: user.id } },
      });
      retryText = usableReply(again.text ?? '');
      retrySteps += again.steps.length;
      retryUsage.inputTokens += again.totalUsage.inputTokens ?? 0;
      retryUsage.cached += again.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
      retryUsage.outputTokens += again.totalUsage.outputTokens ?? 0;
      sofar = [...sofar, ...again.responseMessages];
      lastEmpty = !retryText && (again.finishReason === 'stop' || hasLeakedTokens(again.text ?? ''));
      log.info({ model: usedModel, user: user.id, attempt, recovered: Boolean(retryText) }, 'empty reply, asked again');
    } catch (err) {
      log.warn({ err: String(err), model: usedModel, user: user.id }, 'retry after empty reply failed');
      break;
    }
  }

  // 5. Post-process.
  let text = usableReply(result.text ?? '') || retryText;
  const silent = input.trigger !== 'message' && (NO_MESSAGE.test(text) || text === '');
  if (!text && !silent) {
    text = ctx.created.length ? 'I need your OK before I go ahead — see above.' : 'Done.';
  }
  text = text.replace(/\bNO_MESSAGE\b/g, '').trim();

  const totalUsage = result.totalUsage;
  const inputTokens = (totalUsage.inputTokens ?? 0) + retryUsage.inputTokens;
  const cached = (totalUsage.inputTokenDetails?.cacheReadTokens ?? 0) + retryUsage.cached;
  const outputTokens = (totalUsage.outputTokens ?? 0) + retryUsage.outputTokens;
  const cost = costMicroUsd(usedModel, inputTokens, cached, outputTokens);
  const trace: TurnTrace = {
    model: usedModel,
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    costMicroUsd: Math.round(cost),
    latencyMs: Date.now() - started,
    memoryMs: recalled.ms,
    memoriesUsed: recalled.items.length,
    steps: result.steps.length + retrySteps,
    tools: toolsUsed,
  };

  await usage.add({
    userId: user.id,
    purpose: user.status === 'onboarding' ? 'onboarding' : input.trigger === 'message' ? 'chat' : 'proactive',
    model: usedModel,
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    costMicroUsd: cost,
    latencyMs: trace.latencyMs,
    steps: trace.steps,
  });

  let messageId: number | undefined;
  if (!silent && !restricted) {
    const row = await messages.add(user.id, 'assistant', input.channel, text, {
      trace,
      proactive: input.trigger !== 'message',
      source: input.trigger,
      approvals: ctx.created.map((a) => a.id),
    });
    messageId = row.id;
  }
  for (const a of ctx.activity) await audit.add(user.id, 'agent', a.tool, { summary: a.summary });
  if (!restricted) await users.touch(user.id, input.channel === 'cli' ? 'web' : input.channel).catch(() => {});

  // 6. Memory: retain real conversations asynchronously.
  if (input.trigger === 'message' && !silent && memory.enabled && !restricted) {
    await enqueue('memory-retain', {
      userId: user.id,
      userText: input.text,
      assistantText: text,
      channel: input.channel,
      at: now.toISOString(),
      documentId: `msg-${userMessageId ?? messageId ?? Date.now()}`,
    }).catch((err) => log.warn({ err: String(err) }, 'could not queue memory retain'));
  }

  return { text, silent, approvals: ctx.created, trace, messageId, activity: ctx.activity };
}
