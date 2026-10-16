import { approvals, audit, messages } from '../db/repo.js';
import type { Approval, ChannelName, User } from '../db/types.js';
import { db } from '../db/index.js';
import { log } from '../log.js';
import { findTool } from './tools/index.js';
import type { ToolContext, ToolSpec } from './tools/spec.js';

/**
 * The approval gate. Tools that send, buy, call or delete on the user's behalf never run inside
 * the model's loop: they create a pending approval, and only an explicit yes from the user's own
 * channel (or a button in their dashboard) executes them. The model cannot approve its own actions.
 */

export async function requestApproval(spec: ToolSpec, input: unknown, summary: string, ctx: ToolContext & { created?: Approval[] }): Promise<Record<string, unknown>> {
  // A newer request for the same tool supersedes an older pending one (e.g. an edited draft).
  await db()`update approvals set status = 'expired' where user_id = ${ctx.user.id} and tool = ${spec.name} and status = 'pending'`;
  const a = await approvals.create(ctx.user.id, spec.name, input as Record<string, unknown>, summary, ctx.channel);
  ctx.created?.push(a);
  await audit.add(ctx.user.id, 'agent', 'approval.requested', { tool: spec.name, approval: a.id, summary });
  return {
    status: 'waiting_for_user_approval',
    approval_code: a.short_code,
    summary,
    note: 'Nothing has been done yet. Show the user exactly what will happen (recipients, text, time, number) and ask them to reply YES to go ahead or NO to cancel. Do not claim it is done.',
  };
}

const YES = /^(y|yes|yep|yeah|yup|ya|sure|ok|okay|go|go ahead|do it|send|send it|call|approve|approved|confirm|confirmed|please do|👍|✅)\b/i;
const NO = /^(n|no|nope|nah|cancel|don'?t|stop|reject|deny|never ?mind|👎|❌)\b/i;
const CHANGE = /\b(but|change|instead|edit|actually|wait|except|make it|rather)\b/i;

export type ApprovalMatch =
  | { kind: 'decision'; decision: 'approved' | 'rejected'; approval: Approval }
  | { kind: 'ambiguous'; decision: 'approved' | 'rejected'; pending: Approval[] };

/** Deterministic: only short, unambiguous yes/no replies count as decisions. */
export async function matchApprovalReply(user: User, text: string): Promise<ApprovalMatch | null> {
  const t = text.trim();
  if (!t || t.length > 60 || CHANGE.test(t)) return null;
  const isYes = YES.test(t);
  const isNo = !isYes && NO.test(t);
  if (!isYes && !isNo) return null;
  const pending = await approvals.pending(user.id);
  if (pending.length === 0) return null;
  const decision = isYes ? 'approved' : 'rejected';
  const coded = pending.find((a) => new RegExp(`\\b${a.short_code}\\b`, 'i').test(t));
  if (coded) return { kind: 'decision', decision, approval: coded };
  if (pending.length === 1) return { kind: 'decision', decision, approval: pending[0]! };
  // "yes" with several waiting: approve only when they asked for all of them explicitly.
  if (/\ball\b/i.test(t)) return { kind: 'ambiguous', decision, pending };
  return { kind: 'ambiguous', decision, pending };
}

export interface ApprovalOutcome {
  ok: boolean;
  message: string;
}

/** Decides and, when approved, executes the stored tool call with the stored input. */
export async function decideApproval(user: User, approvalId: string, decision: 'approved' | 'rejected', channel: ChannelName): Promise<ApprovalOutcome> {
  const a = await approvals.decide(user.id, approvalId, decision);
  if (!a) return { ok: false, message: 'That request has already been handled or has expired.' };
  await audit.add(user.id, 'user', `approval.${decision}`, { approval: a.id, tool: a.tool, channel });
  if (decision === 'rejected') {
    await messages.add(user.id, 'event', channel, `Cancelled at the user's request: ${a.summary}`, { approval: a.id });
    return { ok: true, message: 'Okay, cancelled. Nothing was sent.' };
  }
  const spec = findTool(a.tool);
  if (!spec) {
    await approvals.finish(a.id, 'failed', { error: 'unknown tool' });
    return { ok: false, message: 'Sorry, I can no longer do that action.' };
  }
  const ctx: ToolContext = { user, channel, now: new Date(), approved: true, activity: [] };
  try {
    const result = (await spec.run(a.input as never, ctx)) as Record<string, unknown> | undefined;
    await approvals.finish(a.id, 'executed', result ?? null);
    await audit.add(user.id, 'agent', a.tool, { approval: a.id, input: a.input, result: summariseResult(result) });
    const firstLine = a.summary.split('\n')[0]!;
    const done = typeof result?.message === 'string' ? (result.message as string) : `Done: ${lowerFirst(firstLine)}.`;
    await messages.add(user.id, 'event', channel, `Approved by the user and done: ${firstLine}`, { approval: a.id, result: summariseResult(result) });
    return { ok: true, message: done };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, tool: a.tool }, 'approved action failed');
    await approvals.finish(a.id, 'failed', { error: msg });
    await messages.add(user.id, 'event', channel, `Approved action failed (${a.tool}): ${msg}`, { approval: a.id });
    return { ok: false, message: `I couldn't do that: ${msg}` };
  }
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function summariseResult(result: unknown): unknown {
  if (result === undefined || result === null) return null;
  const s = JSON.stringify(result);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : result;
}

export function approvalPrompt(pending: Approval[]): string {
  if (pending.length === 0) return '';
  return pending.map((a) => `• ${a.summary.split('\n')[0]} — reply "yes ${a.short_code}" or "no ${a.short_code}"`).join('\n');
}
