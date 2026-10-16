import { DateTime } from 'luxon';
import { config } from '../config.js';
import { approvals, identities, kv, messages, nudges, routines, users, calls, audit } from '../db/repo.js';
import type { ChannelName, Routine, User } from '../db/types.js';
import { log } from '../log.js';
import { approvalButtons, withApprovalNotice } from '../agent/approvals.js';
import { runTurn } from '../agent/turn.js';
import { sendToUser } from '../channels/deliver.js';
import { adapterFor } from '../channels/registry.js';
import { Google } from '../integrations/google.js';
import { getScheduledEvent } from '../integrations/telnyx.js';
import { enqueue } from '../jobs/queue.js';
import { generateText } from 'ai';
import { usableReply } from '../channels/format.js';
import { chatModel, costMicroUsd } from '../models/tarka.js';
import { usage } from '../db/repo.js';
import { endOfQuiet, isQuiet, nextCronRun, safeZone, startOfLocalDay } from '../util/time.js';

/** Claims due routines and queues them. Runs every few seconds in the worker. */
export async function schedulerTick(): Promise<number> {
  const due = await routines.claimDue(25, (r) => (r.cron ? nextCronRun(r.cron, r.timezone, new Date()) : null));
  for (const r of due) {
    await enqueue('routine-run', { routineId: r.id, userId: r.user_id, firedAt: new Date().toISOString() }, { singletonKey: r.user_id });
  }
  if (Math.random() < 0.05) await approvals.expireOld().catch(() => {});
  return due.length;
}

/** Where a proactive message for this user should go (decides formatting too). */
export async function proactiveChannel(user: User): Promise<ChannelName> {
  const ids = (await identities.forUser(user.id)).filter((i) => !i.opted_out_at && adapterFor(i.channel)?.enabled());
  const pref = user.settings.preferredChannel;
  const pick = (ch?: ChannelName | null) => (ch ? ids.find((i) => i.channel === ch) : undefined);
  const id = pick(pref) ?? pick(user.last_channel) ?? pick('telegram') ?? pick('whatsapp') ?? pick('sms');
  return id?.channel ?? 'web';
}

function planAllows(user: User): boolean {
  if (!config().stripe.enabled || user.plan !== 'trial') return true;
  return !user.trial_ends_at || user.trial_ends_at.getTime() > Date.now();
}

export async function runRoutine(routineId: string, userId: string, signal?: AbortSignal): Promise<void> {
  const user = await users.get(userId);
  const routine = user ? await routines.get(userId, routineId) : null;
  if (!user || !routine || !planAllows(user)) return;
  // Someone still in onboarding gets the reminders and tasks they asked for; the brief and
  // check-ins start once onboarding is done.
  const own = routine.kind === 'reminder' || routine.kind === 'task' || routine.kind === 'followup';
  if (user.status !== 'active' && !(user.status === 'onboarding' && own)) return;
  if (routine.status === 'cancelled' || routine.status === 'paused') return;

  const cfg = config();
  const day = DateTime.now().setZone(safeZone(user.timezone)).toISODate();

  if (routine.kind === 'reminder') {
    // A ceiling on reminder texts per day, so no schedule (or planted reminder) can flood someone.
    const sent = await kv.incr(`reminders-sent:${user.id}:${day}`);
    if (sent > cfg.limits.remindersPerDay) {
      if (sent === cfg.limits.remindersPerDay + 1) {
        await sendToUser(user, `That's ${cfg.limits.remindersPerDay} reminders today, the daily limit, so I'm holding the rest until tomorrow. You can tidy them up in the dashboard.`, {
          proactive: true,
          persist: { role: 'assistant', meta: { source: 'system' } },
        });
      }
      return;
    }
    // Reminders are the user's own request: they fire on time, quiet hours or not.
    await sendToUser(user, `⏰ Reminder: ${routine.title}`, { proactive: true, persist: { role: 'assistant', meta: { source: 'reminder', routine: routine.id } } });
    return;
  }

  // PROACTIVE_ENABLED is the operator's switch for every agent-initiated turn; the user's own
  // "proactivity: off" stops the brief and check-ins but not tasks they asked for.
  if (!cfg.proactive.enabled) return;
  if (!own && user.settings.proactivity === 'off') return;

  if (routine.kind === 'task' || routine.kind === 'followup') {
    // Each run is a full agent turn: a daily ceiling keeps a runaway schedule from burning money.
    const runs = await kv.incr(`task-runs:${user.id}:${day}`);
    if (runs > cfg.limits.taskRunsPerDay) {
      if (runs === cfg.limits.taskRunsPerDay + 1) {
        await sendToUser(user, `I've run ${cfg.limits.taskRunsPerDay} scheduled tasks today, which is the daily limit, so I skipped “${routine.title}”. It will run again next time.`, {
          proactive: true,
          persist: { role: 'assistant', meta: { source: 'system' } },
        });
      }
      await audit.add(user.id, 'system', 'task.skipped', { routine: routine.id, summary: `Daily limit reached: ${routine.title}` });
      return;
    }
  }

  if (routine.kind === 'brief' || routine.kind === 'checkin') {
    if (isQuiet(user)) {
      if (routine.kind === 'brief') {
        // Push the brief to the end of quiet hours, once.
        const at = endOfQuiet(user);
        await routines.update(user.id, routine.id, { nextRunAt: at });
      }
      return;
    }
    if (routine.kind === 'checkin') {
      const today = startOfLocalDay(user.timezone);
      if ((await messages.proactiveCountSince(user.id, today)) >= cfg.proactive.maxPerDay) return;
      // Don't interrupt an active conversation.
      if (user.last_active_at && Date.now() - user.last_active_at.getTime() < 20 * 60_000) return;
    }
  }

  const channel = await proactiveChannel(user);
  const trigger = routine.kind === 'brief' ? 'brief' : routine.kind === 'checkin' ? 'checkin' : 'routine';
  const turn = await runTurn({ user, channel, text: routine.instructions ?? routine.title, title: routine.title, trigger, abortSignal: signal });
  if (turn.silent) {
    await audit.add(user.id, 'agent', `${routine.kind}.skipped`, { routine: routine.id, reason: 'nothing worth sending' });
    return;
  }
  await sendToUser(user, withApprovalNotice(turn.text, turn.approvals, channel), { channel, proactive: true, buttons: approvalButtons(turn.approvals) });
}

/** Meeting heads-ups: no model call, just the calendar. Every few minutes in the worker. */
export async function meetingNudgeScan(): Promise<void> {
  if (!config().google.enabled) return;
  let after: string | undefined;
  for (;;) {
    const batch = await users.listActive(200, after);
    if (batch.length === 0) break;
    after = batch[batch.length - 1]!.id;
    for (const user of batch) {
      if (user.settings.meetingNudges === false || user.settings.proactivity === 'off' || isQuiet(user)) continue;
      try {
        const g = await Google.forUser(user.id).catch(() => null);
        if (!g) continue;
        const now = Date.now();
        const events = await g.listEvents({ timeMin: new Date(now + 4 * 60_000), timeMax: new Date(now + 16 * 60_000), max: 5 });
        for (const e of events) {
          if (e.allDay || !e.start) continue;
          const me = e.attendees.find((a) => a.self);
          if (me?.response === 'declined') continue;
          if (!(await nudges.mark(user.id, `evt:${e.id}:${e.start}`))) continue;
          const tz = safeZone(user.timezone);
          const time = DateTime.fromISO(e.start).setZone(tz).toFormat('h:mm a');
          const where = e.meetLink ? `\nJoin: ${e.meetLink}` : e.location ? `\nWhere: ${e.location}` : '';
          const who = e.attendees.filter((a) => !a.self).slice(0, 4).map((a) => a.name ?? a.email.split('@')[0]).join(', ');
          await sendToUser(user, `Heads up: “${e.title}” at ${time}${who ? ` with ${who}` : ''}.${where}`, {
            proactive: true,
            persist: { role: 'assistant', meta: { source: 'nudge', event: e.id } },
          });
        }
      } catch (err) {
        log.warn({ err: String(err), user: user.id }, 'meeting nudge scan failed for user');
      }
    }
    if (batch.length < 200) break;
  }
}

/** Polls a concierge call until it finishes, then tells the user what happened. */
export async function watchCall(callId: string, attempt: number): Promise<void> {
  const call = await calls.get(callId);
  if (!call || ['completed', 'failed', 'reported'].includes(call.status)) return;
  const user = await users.get(call.user_id);
  if (!user) return;
  const assistantId = config().telnyx.conciergeAssistantId;
  let status = call.status;
  if (assistantId && call.provider_call_id) {
    try {
      const ev = await getScheduledEvent(assistantId, call.provider_call_id);
      status = ev.status ?? status;
      if (ev.errors?.length) await calls.update(call.id, { meta: { errors: ev.errors } });
    } catch (err) {
      log.warn({ err: String(err) }, 'call status check failed');
    }
  }
  const finished = status === 'completed' || status === 'failed';
  const tooLong = attempt >= 20;
  if (!finished && !tooLong) {
    await enqueue('call-watch', { callId, attempt: attempt + 1 }, { startAfterSeconds: 60 });
    return;
  }
  const business = (call.meta.business as string | undefined) ?? 'the business';
  let summary: string;
  if (status === 'failed' || !call.transcript) {
    summary = `I couldn't complete the call to ${business}${status === 'failed' ? ' (the call failed)' : ' (no conversation was recorded)'}. Want me to try again later or find another way?`;
  } else {
    summary = await summariseCall(user, call.objective ?? '', business, call.transcript);
  }
  await calls.update(call.id, { status: 'reported', summary, ended: true });
  const channel = (call.meta.channel as ChannelName | undefined) ?? undefined;
  await sendToUser(user, summary, { channel, proactive: true, persist: { role: 'assistant', meta: { source: 'call', call: call.id } } });
}

async function summariseCall(user: User, objective: string, business: string, transcript: string): Promise<string> {
  const model = config().models.defaultModel;
  const res = await generateText({
    model: chatModel(model),
    instructions:
      'You summarise a phone call an AI assistant made on behalf of its user. Write a short message to the user: did it achieve the objective, the key details (date, time, price, confirmation number, names), and any next step. Plain text, no preamble.',
    messages: [{ role: 'user', content: `Objective: ${objective}\nBusiness: ${business}\n\nTranscript:\n${transcript.slice(-12_000)}` }],
    maxRetries: 2,
    providerOptions: { tarka: { user: user.id } },
  });
  const u = res.totalUsage;
  await usage.add({
    userId: user.id, purpose: 'voice', model, inputTokens: u.inputTokens ?? 0, cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: u.outputTokens ?? 0, costMicroUsd: costMicroUsd(model, u.inputTokens ?? 0, u.inputTokenDetails?.cacheReadTokens ?? 0, u.outputTokens ?? 0),
  });
  return `📞 ${business}: ${usableReply(res.text ?? '') || 'the call has ended, but I couldn’t write up how it went just now.'}`;
}

export type { Routine };
