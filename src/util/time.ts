import * as chrono from 'chrono-node';
import { CronExpressionParser } from 'cron-parser';
import { DateTime } from 'luxon';
import type { User } from '../db/types.js';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return DateTime.local().setZone(tz).isValid;
  } catch {
    return false;
  }
}

export function safeZone(tz: string | null | undefined): string {
  return tz && isValidTimezone(tz) ? tz : 'UTC';
}

/** "Friday 16 October 2026, 9:42 AM" in the given zone. */
export function describeLocal(date: Date, tz: string): string {
  return DateTime.fromJSDate(date).setZone(safeZone(tz)).toFormat("cccc d LLLL yyyy, h:mm a");
}

export function shortLocal(date: Date, tz: string): string {
  const d = DateTime.fromJSDate(date).setZone(safeZone(tz));
  const now = DateTime.now().setZone(safeZone(tz));
  if (d.hasSame(now, 'day')) return `today ${d.toFormat('h:mm a')}`;
  if (d.hasSame(now.plus({ days: 1 }), 'day')) return `tomorrow ${d.toFormat('h:mm a')}`;
  if (Math.abs(d.diff(now, 'days').days) < 6) return d.toFormat('ccc h:mm a');
  return d.toFormat('ccc d LLL, h:mm a');
}

/**
 * Parses a time the model or user gave: ISO 8601 (with or without offset; without one it is read
 * in the user's zone) or natural language ("tomorrow at 9", "in 20 minutes", "next Friday 6pm").
 * Returns null when nothing usable is found.
 */
export function parseWhen(input: string, tz: string, now = new Date()): Date | null {
  const zone = safeZone(tz);
  const text = input.trim();
  if (!text) return null;

  // ISO forms first.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text);
    const dt = hasOffset ? DateTime.fromISO(text, { setZone: true }) : DateTime.fromISO(text, { zone });
    if (dt.isValid) return dt.toJSDate();
  }

  // Natural language, parsed against the user's wall-clock time so DST is handled by luxon.
  const localNow = DateTime.fromJSDate(now).setZone(zone);
  const wallClock = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day, localNow.hour, localNow.minute, localNow.second));
  const results = chrono.parse(text, { instant: wallClock, timezone: 0 }, { forwardDate: true });
  const first = results[0];
  if (!first) return null;
  // chrono worked in "fake UTC" wall-clock time; read its fields back as local time in the zone.
  const target = first.date();
  const relative = /\b(in|after)\s+(\d|an?\b|half\b|a few\b|couple)|\bfrom now\b/i.test(first.text);
  let hour = target.getUTCHours();
  let minute = target.getUTCMinutes();
  if (!relative && !first.start.isCertain('hour')) {
    hour = 9; // a date with no time ("on Friday") means the morning
    minute = 0;
  }
  const dt = DateTime.fromObject(
    { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate(), hour, minute, second: relative ? target.getUTCSeconds() : 0 },
    { zone },
  );
  if (!dt.isValid) return null;
  return dt.toJSDate();
}

/**
 * Phrases that name a span of days ("next week", "this weekend", "next 3 days"), as the first
 * and last moment of the span. chrono reads these as a single day, so they are handled here.
 * Weeks start on Monday.
 */
function spanOf(input: string, now: DateTime): { start: DateTime; end: DateTime } | null {
  const t = input.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^(the|all of|during|over) /, '');
  const today = now.startOf('day');
  const shift = (word: string | undefined) => (word === 'next' ? 1 : word === 'last' ? -1 : 0);
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(this|next|last)? ?week$/))) {
    const start = today.startOf('week').plus({ weeks: shift(m[1]) });
    return { start, end: start.endOf('week') };
  }
  if ((m = t.match(/^(this|next|last)? ?weekend$/))) {
    const start = today.startOf('week').plus({ days: 5, weeks: shift(m[1]) });
    return { start, end: start.plus({ days: 1 }).endOf('day') };
  }
  if ((m = t.match(/^(this|next|last)? ?month$/))) {
    const start = today.startOf('month').plus({ months: shift(m[1]) });
    return { start, end: start.endOf('month') };
  }
  if ((m = t.match(/^(?:next|coming) (\d{1,2}) days$/))) {
    return { start: today, end: today.plus({ days: Number(m[1]) }).endOf('day') };
  }
  if ((m = t.match(/^end of (this|next) (week|month)$/))) {
    const unit = m[2] as 'week' | 'month';
    const last = today.startOf(unit).plus({ [`${unit}s`]: shift(m[1]) }).endOf(unit).startOf('day');
    return { start: last, end: last.endOf('day') };
  }
  return null;
}

/**
 * One end of a time range ("what's on tomorrow", "free slots from Monday to Friday"). A day
 * without a time ("tomorrow", "2026-10-20", "Friday", "in 3 days") covers the whole day: as the
 * start of a range it means the start of that day, as the end the end of it. A span ("next
 * week") covers the whole span. Explicit times ("tomorrow 3pm", "in 2 hours") are kept.
 * (parseWhen reads a bare day as 9 AM, so "from tomorrow to tomorrow" used to be empty.)
 */
export function parseRangeEdge(input: string, tz: string, edge: 'start' | 'end', now = new Date()): Date | null {
  const zone = safeZone(tz);
  const text = input.trim();
  if (!text) return null;
  const wholeDay = (d: DateTime) => (edge === 'start' ? d.startOf('day') : d.endOf('day')).toJSDate();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = DateTime.fromISO(text, { zone });
    return d.isValid ? wholeDay(d) : null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return parseWhen(text, zone, now);
  const localNow = DateTime.fromJSDate(now).setZone(zone);
  const span = spanOf(text, localNow);
  if (span) return (edge === 'start' ? span.start : span.end).toJSDate();
  const wallClock = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day, localNow.hour, localNow.minute, localNow.second));
  const first = chrono.parse(text, { instant: wallClock, timezone: 0 }, { forwardDate: true })[0];
  if (!first) return null;
  if (first.start.isCertain('hour')) return parseWhen(text, zone, now);
  const t = first.start.date();
  return wholeDay(DateTime.fromObject({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }, { zone }));
}

/** Next occurrence of a 5-field cron expression, evaluated in `tz`, strictly after `after`. */
export function nextCronRun(cron: string, tz: string, after = new Date()): Date | null {
  try {
    const expr = CronExpressionParser.parse(cron, { currentDate: after, tz: safeZone(tz) });
    return expr.next().toDate();
  } catch {
    return null;
  }
}

/** The shortest gap, in minutes, between upcoming runs of a cron (sampled over its next runs). */
export function minCronGapMinutes(cron: string, tz: string, samples = 24, from = new Date()): number {
  try {
    const expr = CronExpressionParser.parse(cron, { currentDate: from, tz: safeZone(tz) });
    let prev = expr.next().toDate().getTime();
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < samples; i++) {
      const t = expr.next().toDate().getTime();
      min = Math.min(min, (t - prev) / 60_000);
      prev = t;
    }
    return min;
  } catch {
    return 0;
  }
}

export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return nextCronRun(cron, 'UTC') !== null;
}

/**
 * Turns a simple repeat rule into cron at the given local time:
 * daily | weekdays | weekends | weekly | monthly | hourly | a 5-field cron expression.
 */
export function repeatToCron(repeat: string, firstLocal: DateTime): string | null {
  const r = repeat.trim().toLowerCase();
  const m = firstLocal.minute;
  const h = firstLocal.hour;
  switch (r) {
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
    case 'every day':
      return `${m} ${h} * * *`;
    case 'weekdays':
    case 'every weekday':
      return `${m} ${h} * * 1-5`;
    case 'weekends':
      return `${m} ${h} * * 0,6`;
    case 'weekly':
    case 'every week':
      return `${m} ${h} * * ${firstLocal.weekday % 7}`;
    case 'monthly':
    case 'every month':
      return `${m} ${h} ${firstLocal.day} * *`;
    default:
      return isValidCron(repeat) ? repeat.trim() : null;
  }
}

/** Human description of a cron in plain words (covers the shapes this app creates). */
export function describeCron(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const time = hour !== undefined && min !== undefined && /^\d+$/.test(hour) && /^\d+$/.test(min)
    ? DateTime.fromObject({ hour: Number(hour), minute: Number(min) }).toFormat('h:mm a')
    : null;
  if (hour === '*' && dom === '*' && dow === '*') return `every hour at :${(min ?? '0').padStart(2, '0')}`;
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return `every day at ${time}`;
    if (dow === '1-5') return `weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `weekends at ${time}`;
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    if (dow && /^\d$/.test(dow)) return `every ${names[Number(dow)]} at ${time}`;
  }
  if (time && dom && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `monthly on day ${dom} at ${time}`;
  return `on schedule "${cron}"`;
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function isValidHHMM(hhmm: string): boolean {
  return minutesOf(hhmm) !== null;
}

/** Quiet hours default to 22:00–07:30 local. */
export function quietHours(user: Pick<User, 'settings'>): { start: string; end: string } {
  return user.settings.quietHours ?? { start: '22:00', end: '07:30' };
}

export function isQuiet(user: Pick<User, 'settings' | 'timezone'>, at = new Date()): boolean {
  const { start, end } = quietHours(user);
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === null || e === null || s === e) return false;
  const local = DateTime.fromJSDate(at).setZone(safeZone(user.timezone));
  const now = local.hour * 60 + local.minute;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The next moment quiet hours end (or `at` itself when not quiet). */
export function endOfQuiet(user: Pick<User, 'settings' | 'timezone'>, at = new Date()): Date {
  if (!isQuiet(user, at)) return at;
  const { end } = quietHours(user);
  const e = minutesOf(end) ?? 450;
  const local = DateTime.fromJSDate(at).setZone(safeZone(user.timezone));
  let candidate = local.set({ hour: Math.floor(e / 60), minute: e % 60, second: 0, millisecond: 0 });
  if (candidate <= local) candidate = candidate.plus({ days: 1 });
  return candidate.toJSDate();
}

export function startOfLocalDay(tz: string, at = new Date()): Date {
  return DateTime.fromJSDate(at).setZone(safeZone(tz)).startOf('day').toJSDate();
}

export function startOfLocalMonth(tz: string, at = new Date()): Date {
  return DateTime.fromJSDate(at).setZone(safeZone(tz)).startOf('month').toJSDate();
}
