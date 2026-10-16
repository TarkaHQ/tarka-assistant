import { routines } from '../db/repo.js';
import type { User } from '../db/types.js';
import { isValidHHMM, nextCronRun, safeZone } from '../util/time.js';

export const DEFAULT_BRIEF_TIME = '07:30';

function cronAt(hhmm: string, dow = '*'): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m} ${h} * * ${dow}`;
}

/**
 * Keeps the system-owned routines (morning brief, check-ins) in line with the user's settings and
 * timezone. Called after onboarding and whenever settings change.
 */
export async function syncSystemRoutines(user: User): Promise<void> {
  const tz = safeZone(user.timezone);

  // Morning brief: on by default at 07:30 local; settings.briefTime === null switches it off.
  const briefTime = user.settings.briefTime === undefined ? DEFAULT_BRIEF_TIME : user.settings.briefTime;
  const [brief] = await routines.byKind(user.id, 'brief');
  if (!briefTime || !isValidHHMM(briefTime) || user.settings.proactivity === 'off') {
    if (brief) await routines.setStatus(user.id, brief.id, 'cancelled');
  } else {
    const cron = cronAt(briefTime);
    const next = nextCronRun(cron, tz);
    // A brief the user paused stays paused; only its time and zone follow the settings.
    if (brief) await routines.update(user.id, brief.id, { cron, timezone: tz, nextRunAt: next, status: brief.status === 'paused' ? 'paused' : 'active' });
    else
      await routines.create(user.id, {
        kind: 'brief', title: 'Morning brief', scheduleType: 'cron', cron, timezone: tz, nextRunAt: next, createdBy: 'system',
      });
  }

  // Check-ins: a couple of times on weekdays the assistant looks for something worth flagging.
  const proactivity = user.settings.proactivity ?? 'normal';
  const [checkin] = await routines.byKind(user.id, 'checkin');
  if (proactivity === 'off' || proactivity === 'low') {
    if (checkin) await routines.setStatus(user.id, checkin.id, 'cancelled');
  } else {
    const cron = proactivity === 'high' ? '15 10,13,16,19 * * *' : '30 12,17 * * 1-5';
    const next = nextCronRun(cron, tz);
    if (checkin) await routines.update(user.id, checkin.id, { cron, timezone: tz, nextRunAt: next, status: checkin.status === 'paused' ? 'paused' : 'active' });
    else
      await routines.create(user.id, {
        kind: 'checkin', title: 'Check-in', scheduleType: 'cron', cron, timezone: tz, nextRunAt: next, createdBy: 'system',
      });
  }

  // Timezone moves: re-anchor the user's own repeating items too.
  for (const r of await routines.forUser(user.id)) {
    if (r.created_by === 'system' || r.timezone === tz || r.schedule_type !== 'cron' || !r.cron) continue;
    await routines.update(user.id, r.id, { timezone: tz, nextRunAt: nextCronRun(r.cron, tz) });
  }
}
