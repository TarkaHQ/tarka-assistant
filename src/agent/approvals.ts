import { approvals, audit, messages } from '../db/repo.js';
import type { Approval, ChannelName, User } from '../db/types.js';
import { log } from '../log.js';
import type { OutboundButton } from '../channels/types.js';
import { findTool } from './tools/index.js';
import type { ToolContext, ToolSpec } from './tools/spec.js';

/**
 * The approval gate. Tools that send, buy, call or delete on the user's behalf never run inside
 * the model's loop: they create a pending approval, and only an explicit yes from the user's own
 * channel (a reply, a button, or the dashboard) executes them. The model cannot approve its own
 * actions, and the user always sees a summary written by code, not by the model.
 */

export async function requestApproval(spec: ToolSpec, input: unknown, summary: string, ctx: ToolContext & { created?: Approval[] }): Promise<Record<string, unknown>> {
  // Nothing is superseded automatically: each request stays answerable by its own code until it is
  // decided or expires, so a later request (an edit, or one from a scheduled task) can never
  // quietly take the place of the one the person is looking at.
  const origin = ctx.trigger === 'message' ? 'message' : ctx.trigger;
  const a = await approvals.create(ctx.user.id, spec.name, input as Record<string, unknown>, summary, ctx.channel, origin);
  ctx.created?.push(a);
  await audit.add(ctx.user.id, 'agent', 'approval.requested', { tool: spec.name, approval: a.id, summary });
  return {
    status: 'waiting_for_user_approval',
    approval_code: a.short_code,
    summary,
    note:
      ctx.channel === 'voice'
        ? 'Nothing has been done yet. The exact details are being texted to the user to confirm. Tell them that in one short sentence.'
        : 'Nothing has been done yet. The exact details and a YES/NO prompt are attached under your reply automatically, so do not repeat the full text: say in a sentence what you prepared and that it is waiting for their OK. Never claim it is done.',
  };
}

// ---------------------------------------------------------------------------------------------
// Reading a reply as a decision
// ---------------------------------------------------------------------------------------------

const YES_WORD = '(?:yes|y|yep|yeah|yup|ya|yea|sure|ok|okay|k|kk|approve|approved|confirm|confirmed|go|send|call|book)';
const YES_TAIL = '(?:please|pls|thanks|thank you|ty|go ahead|do it|send it|call them|book it|thats fine|go for it|send|call)';
const YES_ALONE = '(?:go ahead|do it|send it|call them|book it|please do|sounds good|looks good|all good|go for it|👍|✅|👌|🆗|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)';
const NO_WORD = '(?:no|n|nope|nah|cancel|cancel it|cancel that|reject|deny|declined?|dont|dont send|dont send it|do not|do not send|never ?mind|forget it|👎|❌|🚫)';
const NO_TAIL = '(?:thanks|thank you|please|pls)';

const YES_RE = new RegExp(`^(?:${YES_WORD}|${YES_ALONE})(?: ?(?:${YES_WORD}|${YES_ALONE}|${YES_TAIL}))*$`, 'u');
const NO_RE = new RegExp(`^${NO_WORD}(?: ?(?:${NO_WORD}|${NO_TAIL}))*$`, 'u');
const ALL_RE = /\s+(?:to\s+)?(?:all|both|all of them|both of them|everything)$/u;

/** A bare yes counts for a request only while it is the newest thing the assistant said. */
const BARE_REPLY_WINDOW_MS = 12 * 3600_000;

export type ApprovalMatch =
  | { kind: 'decision'; decision: 'approved' | 'rejected'; approvals: Approval[] }
  | { kind: 'clarify'; decision: 'approved' | 'rejected'; pending: Approval[] };

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/'/g, '')
    .replace(/[.,!?;:"“”()[\]*_~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic: a reply is a decision only when the WHOLE message is a yes or a no (optionally
 * with an approval code, "please", "thanks"…). "Yes I'm free Tuesday" or "ok but change the time"
 * are conversation, not approvals.
 *
 *  - "yes K7PD" / "no K7PD" decide that request, whenever it was asked.
 *  - a bare "yes" decides the request(s) in the assistant's newest message, and nothing older.
 *  - anything else returns null and goes to the conversation as usual.
 */
export async function matchApprovalReply(user: User, text: string, sentAt: Date = new Date()): Promise<ApprovalMatch | null> {
  const raw = text.trim();
  // A question ("yes?", "yes?!") is hesitation, not a decision.
  if (!raw || raw.length > 80 || raw.includes('?')) return null;
  const pending = await approvals.pending(user.id);
  if (pending.length === 0) return null;

  let norm = ` ${normalise(raw)} `;
  const coded: Approval[] = [];
  for (const a of pending) {
    const code = ` ${a.short_code.toLowerCase()} `;
    if (norm.includes(code)) {
      coded.push(a);
      norm = norm.split(code).join(' ');
    }
  }
  norm = norm.replace(/\s+/g, ' ').trim();
  let all = false;
  if (ALL_RE.test(norm)) {
    all = true;
    norm = norm.replace(ALL_RE, '').trim();
  }
  const decision = YES_RE.test(norm) ? 'approved' : NO_RE.test(norm) ? 'rejected' : null;
  if (!decision) return null;
  if (coded.length) return { kind: 'decision', decision, approvals: coded };

  const asked = await justAsked(user.id, pending, sentAt);
  if (asked.length === 0) return null;
  if (asked.length === 1 || all) return { kind: 'decision', decision, approvals: asked };
  return { kind: 'clarify', decision, pending: asked };
}

/**
 * The requests a bare yes/no can answer: those in the assistant's newest message, only if the
 * person's reply was sent after that message existed (a "yes" typed before the request arrived
 * never approves it), and only for requests the person asked for themselves. Requests raised by
 * scheduled tasks or the brief always need their code or a button.
 */
async function justAsked(userId: string, pending: Approval[], sentAt: Date): Promise<Approval[]> {
  const last = await messages.lastAssistant(userId);
  if (!last || Date.now() - last.created_at.getTime() > BARE_REPLY_WINDOW_MS) return [];
  // (Timestamps are compared to the millisecond; a reply written before the request arrived is
  // seconds older, since the request takes a model turn to produce.)
  if (sentAt.getTime() < last.created_at.getTime()) return [];
  const ids = Array.isArray(last.meta.approvals) ? (last.meta.approvals as string[]) : [];
  return pending.filter((a) => ids.includes(a.id) && a.origin === 'message');
}

// ---------------------------------------------------------------------------------------------
// Presenting requests
// ---------------------------------------------------------------------------------------------

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * The code-written request appended under the model's reply on text channels, so what the user
 * approves is exactly what will run, whatever the model said. (The web shows approval cards.)
 */
export function approvalNotice(list: Approval[], channel: ChannelName): string {
  if (list.length === 0 || channel === 'web' || channel === 'cli' || channel === 'voice') return '';
  const max = channel === 'sms' ? 700 : 1500;
  // Requests nobody asked for just now (from a scheduled task, the brief) need their code.
  const needsCode = list.some((a) => a.origin !== 'message');
  if (list.length === 1) {
    const a = list[0]!;
    const full = a.summary.length > max ? `${clip(a.summary, max)}\n(Full text in your dashboard.)` : a.summary;
    // Not "reply CANCEL": on SMS that word is a carrier opt-out keyword.
    const yes = needsCode ? `YES ${a.short_code}` : 'YES';
    const how = channel === 'telegram' ? `Tap a button, or reply ${yes} to go ahead or NO if not.` : `Reply ${yes} to go ahead, or NO if not.`;
    return `Needs your OK:\n${full}\n${how}`;
  }
  const lines = list.map((a) => `- ${clip(a.summary.split('\n')[0]!, 160)}: reply "yes ${a.short_code}"`);
  return `These need your OK:\n${lines.join('\n')}\n${needsCode ? 'Reply with each code to go ahead.' : 'Reply "yes all" for everything, or "no" with a code to cancel one.'}`;
}

export function approvalButtons(list: Approval[]): OutboundButton[] {
  if (list.length !== 1) return [];
  const a = list[0]!;
  return [
    { label: 'Yes, go ahead', data: `ap:${a.id}:y` },
    { label: 'No', data: `ap:${a.id}:n` },
  ];
}

/** Model reply + the code-written request, for a text channel. */
export function withApprovalNotice(text: string, list: Approval[], channel: ChannelName): string {
  const notice = approvalNotice(list, channel);
  return notice ? `${text.trim()}\n\n${notice}` : text;
}

// ---------------------------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------------------------

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
    return { ok: true, message: `Okay, cancelled: ${lowerFirst(a.summary.split('\n')[0]!)}. Nothing was done.` };
  }
  const spec = findTool(a.tool);
  if (!spec) {
    await approvals.finish(a.id, 'failed', { error: 'unknown tool' });
    return { ok: false, message: 'Sorry, I can no longer do that action.' };
  }
  const ctx: ToolContext = { user, channel, now: new Date(), trigger: 'approval', approved: true, activity: [] };
  try {
    const result = (await spec.run(a.input as never, ctx)) as Record<string, unknown> | undefined;
    await approvals.finish(a.id, 'executed', result ?? null);
    await audit.add(user.id, 'agent', a.tool, { approval: a.id, input: a.input, result: summariseResult(result) });
    for (const act of ctx.activity) await audit.add(user.id, 'agent', act.tool, { summary: act.summary });
    const firstLine = a.summary.split('\n')[0]!.replace(/[:\s]+$/, ''); // "Send email to x — “Hi”:" introduces the body
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

/** Several decisions from one reply ("yes all", "yes K7PD 3HXM"): one combined answer. */
export async function decideApprovals(user: User, list: Approval[], decision: 'approved' | 'rejected', channel: ChannelName): Promise<ApprovalOutcome> {
  const outcomes: ApprovalOutcome[] = [];
  for (const a of list) outcomes.push(await decideApproval(user, a.id, decision, channel));
  if (outcomes.length === 1) return outcomes[0]!;
  return { ok: outcomes.every((o) => o.ok), message: outcomes.map((o) => `- ${o.message}`).join('\n') };
}

export function clarifyMessage(pending: Approval[], decision: 'approved' | 'rejected'): string {
  const word = decision === 'approved' ? 'yes' : 'no';
  return `A few things are waiting for you. Which one?\n${pending.map((a) => `- ${clip(a.summary.split('\n')[0]!, 160)}: reply "${word} ${a.short_code}"`).join('\n')}\nOr reply "${word} all".`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function summariseResult(result: unknown): unknown {
  if (result === undefined || result === null) return null;
  const s = JSON.stringify(result);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : result;
}
