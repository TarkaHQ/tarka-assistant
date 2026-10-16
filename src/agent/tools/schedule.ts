import { DateTime } from 'luxon';
import { z } from 'zod';
import { config } from '../../config.js';
import { routines } from '../../db/repo.js';
import type { Routine } from '../../db/types.js';
import { describeCron, minCronGapMinutes, nextCronRun, parseWhen, repeatToCron, safeZone, shortLocal } from '../../util/time.js';
import { defineTool, type ToolContext, type ToolSpec } from './spec.js';

/** How often something may repeat: reminders every 15 minutes at most, agent tasks hourly. */
const MIN_GAP_MINUTES = { reminder: 15, task: 60 } as const;

function assertGap(cron: string, tz: string, kind: keyof typeof MIN_GAP_MINUTES): void {
  const gap = minCronGapMinutes(cron, tz);
  if (gap < MIN_GAP_MINUTES[kind]) {
    const limit = kind === 'task' ? 'once an hour' : 'every 15 minutes';
    throw new Error(`That would repeat every ${Math.max(1, Math.round(gap))} minutes; ${kind === 'task' ? 'scheduled tasks' : 'reminders'} can repeat at most ${limit}. Suggest a less frequent schedule.`);
  }
}

async function assertRoom(ctx: ToolContext): Promise<void> {
  const max = config().limits.scheduledItems;
  if ((await routines.countOwn(ctx.user.id)) >= max) {
    throw new Error(`The user already has ${max} reminders and scheduled tasks, which is the limit. Offer to cancel some (list_scheduled) first.`);
  }
}

const whenField = z
  .string()
  .describe('When, in the user’s local time: ISO like "2026-10-17T09:00" (no offset) or plain words like "tomorrow 9am", "in 20 minutes", "next Friday at 6pm"');
const repeatField = z
  .string()
  .optional()
  .describe('Optional repeat: daily | weekdays | weekends | weekly | monthly | hourly, or a 5-field cron expression in local time');

function resolveSchedule(when: string, repeat: string | undefined, ctx: ToolContext, kind: keyof typeof MIN_GAP_MINUTES) {
  const tz = safeZone(ctx.user.timezone);
  const first = parseWhen(when, tz, ctx.now);
  if (!first) throw new Error(`I couldn't work out the time from "${when}". Ask the user for a specific time.`);
  if (first.getTime() < ctx.now.getTime() - 60_000 && !repeat) {
    throw new Error(`That time (${first.toISOString()}) is in the past. Ask the user to confirm the date.`);
  }
  if (!repeat) return { scheduleType: 'once' as const, runAt: first, cron: null, nextRunAt: first };
  const cron = repeatToCron(repeat, DateTime.fromJSDate(first).setZone(tz));
  if (!cron) throw new Error(`Unsupported repeat rule "${repeat}"`);
  assertGap(cron, tz, kind);
  const firstRun = first.getTime() >= ctx.now.getTime() ? first : nextCronRun(cron, tz, ctx.now);
  return { scheduleType: 'cron' as const, runAt: null, cron, nextRunAt: firstRun };
}

function present(r: Routine, tz: string) {
  return {
    id: r.id.slice(0, 8),
    kind: r.kind,
    title: r.title,
    schedule: r.schedule_type === 'cron' && r.cron ? describeCron(r.cron) : 'once',
    next: r.next_run_at ? shortLocal(r.next_run_at, tz) : null,
    status: r.status,
  };
}

async function findRoutine(userId: string, idPrefix: string): Promise<Routine> {
  const all = await routines.forUser(userId);
  const matches = all.filter((r) => r.id.startsWith(idPrefix.trim().toLowerCase()));
  if (matches.length === 0) throw new Error(`No scheduled item with id ${idPrefix}. Call list_scheduled to see ids.`);
  if (matches.length > 1) throw new Error('That id is ambiguous; use more characters.');
  return matches[0]!;
}

export const scheduleTools: ToolSpec[] = [
  defineTool({
    name: 'schedule_reminder',
    label: 'Setting a reminder',
    description:
      'Remind the user about something at a time (optionally repeating). At that time the user gets your reminder text as a message. Use for "remind me…", "ping me…", birthdays, bills, medication times.',
    input: z.object({
      text: z.string().min(1).describe('The reminder as it should read to the user, e.g. "Call Mum — it’s her birthday"'),
      when: whenField,
      repeat: repeatField,
    }),
    run: async ({ text, when, repeat }, ctx) => {
      const s = resolveSchedule(when, repeat, ctx, 'reminder');
      await assertRoom(ctx);
      const r = await routines.create(ctx.user.id, {
        kind: 'reminder',
        title: text,
        scheduleType: s.scheduleType,
        runAt: s.runAt,
        cron: s.cron,
        timezone: safeZone(ctx.user.timezone),
        nextRunAt: s.nextRunAt,
        createdBy: 'user',
      });
      ctx.activity.push({ tool: 'schedule_reminder', summary: `Reminder: ${text}` });
      return { scheduled: present(r, ctx.user.timezone) };
    },
  }),

  defineTool({
    name: 'schedule_task',
    label: 'Scheduling a task',
    description:
      'Schedule work for you (the assistant) to do later, once or on repeat (at most hourly), then message the user the result. The instructions run as a fresh request with all your tools. Use for "every Monday send me…", "check the price of… each morning", "on Friday look up…", or to follow up on something you promised. A repeating task needs the user’s approval.',
    input: z.object({
      title: z.string().min(1).max(120).describe('Short name, e.g. "Weekly plan"'),
      instructions: z.string().min(5).max(2000).describe('What to do at that time, written to yourself in detail'),
      when: whenField,
      repeat: repeatField,
    }),
    // A repeating task acts on its own, with every tool, for as long as it exists: the user signs off
    // on exactly what it will do (and an instruction smuggled in by an email or web page can't set one up).
    approval: (i, ctx) => {
      if (!i.repeat) return null;
      const tz = safeZone(ctx.user.timezone);
      const s = resolveSchedule(i.when, i.repeat, ctx, 'task');
      return `Set up a repeating task “${i.title}”, ${describeCron(s.cron!)}${s.nextRunAt ? `, starting ${shortLocal(s.nextRunAt, tz)}` : ''}. Each time I will:\n${i.instructions}`;
    },
    run: async ({ title, instructions, when, repeat }, ctx) => {
      const s = resolveSchedule(when, repeat, ctx, 'task');
      await assertRoom(ctx);
      const r = await routines.create(ctx.user.id, {
        kind: 'task',
        title,
        instructions,
        scheduleType: s.scheduleType,
        runAt: s.runAt,
        cron: s.cron,
        timezone: safeZone(ctx.user.timezone),
        nextRunAt: s.nextRunAt,
        createdBy: 'agent',
      });
      ctx.activity.push({ tool: 'schedule_task', summary: `Scheduled: ${title}` });
      return { scheduled: present(r, ctx.user.timezone) };
    },
  }),

  defineTool({
    name: 'list_scheduled',
    label: 'Checking your schedule',
    description: 'List the user’s reminders, scheduled tasks and routines (including the morning brief) with their ids.',
    input: z.object({}),
    run: async (_input, ctx) => {
      const all = await routines.forUser(ctx.user.id);
      return { items: all.map((r) => present(r, ctx.user.timezone)) };
    },
  }),

  defineTool({
    name: 'cancel_scheduled',
    label: 'Cancelling',
    description: 'Cancel a reminder or scheduled task by id (from list_scheduled). Pause instead when the user wants it back later.',
    input: z.object({ id: z.string().min(4), pause: z.boolean().optional() }),
    run: async ({ id, pause }, ctx) => {
      const r = await findRoutine(ctx.user.id, id);
      const updated = await routines.setStatus(ctx.user.id, r.id, pause ? 'paused' : 'cancelled');
      ctx.activity.push({ tool: 'cancel_scheduled', summary: `${pause ? 'Paused' : 'Cancelled'}: ${r.title}` });
      return { done: true, item: updated ? present(updated, ctx.user.timezone) : null };
    },
  }),

  defineTool({
    name: 'reschedule',
    label: 'Rescheduling',
    description:
      'Change the time, repeat rule or text of an existing reminder/task (including the morning brief), or resume a paused one. For a repeating item, a new `when` changes its time of day and keeps how often it repeats.',
    input: z.object({
      id: z.string().min(4),
      when: whenField.optional(),
      repeat: repeatField,
      text: z.string().max(200).optional().describe('New reminder text or task title'),
      instructions: z.string().max(2000).optional(),
      resume: z.boolean().optional(),
    }),
    // Making a task repeat, or changing what a repeating task does, needs the same sign-off as
    // creating one.
    approval: async (i, ctx) => {
      const r = await findRoutine(ctx.user.id, i.id);
      if (r.kind !== 'task') return null;
      const repeats = Boolean(i.repeat) || r.schedule_type === 'cron';
      if (!repeats || (!i.repeat && i.instructions === undefined)) return null;
      const what = i.instructions ?? r.instructions ?? r.title;
      const schedule = i.repeat ? `repeat ${i.repeat}` : r.cron ? describeCron(r.cron) : 'repeat';
      return `Change the repeating task “${i.text ?? r.title}” (${schedule}). Each time I will:\n${what}`;
    },
    run: async ({ id, when, repeat, text, instructions, resume }, ctx) => {
      const r = await findRoutine(ctx.user.id, id);
      const tz = safeZone(ctx.user.timezone);
      const patch: Parameters<typeof routines.update>[2] = { title: text, instructions };
      const kind = r.kind === 'reminder' ? 'reminder' : 'task';
      if (repeat) {
        const anchor = when ?? (r.next_run_at ? DateTime.fromJSDate(r.next_run_at).setZone(tz).toFormat("yyyy-LL-dd'T'HH:mm") : 'tomorrow 9am');
        const s = resolveSchedule(anchor, repeat, ctx, kind);
        Object.assign(patch, { scheduleType: s.scheduleType, cron: s.cron, runAt: s.runAt, nextRunAt: s.nextRunAt });
      } else if (when) {
        if (r.schedule_type === 'cron' && r.cron) {
          const t = parseWhen(when, tz, ctx.now);
          if (!t) throw new Error(`I couldn't work out the time from "${when}".`);
          const local = DateTime.fromJSDate(t).setZone(tz);
          const fields = r.cron.trim().split(/\s+/);
          fields[0] = String(local.minute);
          if (fields[1] !== '*') fields[1] = String(local.hour);
          const cron = fields.join(' ');
          Object.assign(patch, { cron, nextRunAt: nextCronRun(cron, tz, ctx.now) });
        } else {
          const s = resolveSchedule(when, undefined, ctx, kind);
          Object.assign(patch, { runAt: s.runAt, nextRunAt: s.nextRunAt });
        }
      }
      if (resume) {
        patch.status = 'active';
        if (!patch.nextRunAt && r.schedule_type === 'cron' && r.cron && (!r.next_run_at || r.next_run_at < ctx.now)) {
          patch.nextRunAt = nextCronRun(patch.cron ?? r.cron, tz, ctx.now);
        }
      }
      const updated = await routines.update(ctx.user.id, r.id, patch);
      ctx.activity.push({ tool: 'reschedule', summary: `Updated: ${updated?.title ?? r.title}` });
      return { updated: updated ? present(updated, tz) : null };
    },
  }),
];
