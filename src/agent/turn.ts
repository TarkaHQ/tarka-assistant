import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { config } from '../config.js';
import { integrations, messages, routines, usage, users, approvals as approvalsRepo, audit } from '../db/repo.js';
import type { Approval, ChannelName, MessageRow, User } from '../db/types.js';
import { log } from '../log.js';
import { memory } from '../memory/hindsight.js';
import { chatModel, costMicroUsd } from '../models/tarka.js';
import { sandboxesAvailable } from '../models/sandbox.js';
import { stripThinking } from '../channels/format.js';
import { enqueue } from '../jobs/queue.js';
import { buildInstructions, type Trigger } from './prompt.js';
import { requestApproval } from './approvals.js';
import { allTools, toolLabel } from './tools/index.js';
import { primeGoogleAvailability } from './tools/google.js';
import { toAiTools, type ToolContext } from './tools/spec.js';

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
  userMeta?: Record<string, unknown>;
  onStatus?: (label: string) => void;
  progress?: (text: string) => Promise<void>;
  abortSignal?: AbortSignal;
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

  // 1. Gather context in parallel.
  const historyP = messages.recent(user.id, HISTORY_ROWS);
  let userMessage: MessageRow | undefined;
  if (input.persistUserMessage) {
    userMessage = await messages.add(user.id, 'user', input.channel, input.text, input.userMeta ?? {});
  }
  const memoryQuery = input.trigger === 'message' ? input.text : `${input.title ?? input.trigger} ${input.text}`.slice(0, 1000);
  const [history, recalled, upcoming, pending, googleConnected, integ, profile] = await Promise.all([
    historyP,
    memory.recallForPrompt(user, memoryQuery),
    routines.forUser(user.id).then((rs) => rs.filter((r) => r.status === 'active')),
    approvalsRepo.pending(user.id),
    primeGoogleAvailability(user.id),
    integrations.get(user.id, 'google'),
    profileFor(user),
  ]);

  // 2. Messages: prior conversation, then this turn.
  const prior = historyToMessages(history.filter((m) => m.id !== userMessage?.id));
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
    progress: input.progress,
    activity: [],
    created: [],
  };
  const toolsUsed: string[] = [];
  const tools = toAiTools(allTools, ctx, requestApproval, (name) => {
    toolsUsed.push(name);
    input.onStatus?.(toolLabel(name));
  });

  const instructions = buildInstructions({
    user,
    channel: input.channel,
    now,
    trigger: input.trigger,
    model: pickModel(user),
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
  });

  // 4. Generate, with one fallback model on provider failure.
  const primary = pickModel(user);
  const candidates = [primary, ...(cfg.models.fallbackModel && cfg.models.fallbackModel !== primary ? [cfg.models.fallbackModel] : [])];
  let result: Awaited<ReturnType<typeof generateText>> | undefined;
  let usedModel = primary;
  let lastErr: unknown;
  for (const modelId of candidates) {
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

  // 5. Post-process.
  let text = stripThinking(result.text ?? '');
  const silent = input.trigger !== 'message' && (NO_MESSAGE.test(text) || text === '');
  if (!text && !silent) {
    text = ctx.created.length ? 'I need your OK before I go ahead — see above.' : 'Done.';
  }
  text = text.replace(/\bNO_MESSAGE\b/g, '').trim();

  const totalUsage = result.totalUsage;
  const inputTokens = totalUsage.inputTokens ?? 0;
  const cached = totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
  const outputTokens = totalUsage.outputTokens ?? 0;
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
    steps: result.steps.length,
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
  if (!silent) {
    const row = await messages.add(user.id, 'assistant', input.channel, text, {
      trace,
      proactive: input.trigger !== 'message',
      source: input.trigger,
      approvals: ctx.created.map((a) => a.id),
    });
    messageId = row.id;
  }
  for (const a of ctx.activity) await audit.add(user.id, 'agent', a.tool, { summary: a.summary });
  await users.touch(user.id, input.channel === 'cli' ? 'web' : input.channel).catch(() => {});

  // 6. Memory: retain real conversations asynchronously.
  if (input.trigger === 'message' && !silent && memory.enabled) {
    await enqueue('memory-retain', {
      userId: user.id,
      userText: input.text,
      assistantText: text,
      channel: input.channel,
      at: now.toISOString(),
      documentId: `msg-${userMessage?.id ?? messageId ?? Date.now()}`,
    }).catch((err) => log.warn({ err: String(err) }, 'could not queue memory retain'));
  }

  return { text, silent, approvals: ctx.created, trace, messageId, activity: ctx.activity };
}
