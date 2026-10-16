import { PgBoss, type Job } from 'pg-boss';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Background work runs on pg-boss (jobs in the same Postgres). Inbound messages use the
 * `singleton` policy keyed by person: one message per person is handled at a time, in arrival
 * order, while different people run in parallel. Unlike a strict FIFO, a job that fails can't
 * hold back that person's later messages.
 */

type QueueDef = {
  policy?: 'standard' | 'singleton' | 'stately';
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  /** Workers heartbeat while a job runs; a crashed worker's job is retried after this. */
  heartbeatSeconds?: number;
  notify?: boolean;
};

export const QUEUES: Record<string, QueueDef> = {
  // One retry, for a worker that died mid-message (deploy, crash). handleInbound itself never throws.
  inbound: { policy: 'singleton', retryLimit: 1, retryDelay: 5, expireInSeconds: 420, heartbeatSeconds: 30, notify: true },
  'memory-retain': { retryLimit: 5, retryDelay: 20, retryBackoff: true, expireInSeconds: 300 },
  'routine-run': { retryLimit: 1, retryDelay: 60, expireInSeconds: 900, heartbeatSeconds: 60, notify: true },
  'call-watch': { retryLimit: 0, expireInSeconds: 300 },
  'profile-refresh': { retryLimit: 1, expireInSeconds: 300 },
};

export type QueueName = keyof typeof QUEUES;

/** How long a stopping worker waits for running jobs; the rest are failed and retried on restart. */
const STOP_GRACE_MS = 25_000;

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export async function startQueue(): Promise<PgBoss> {
  if (boss) return boss;
  starting ??= (async () => {
    const b = new PgBoss({ connectionString: config().databaseUrl, schema: 'pgboss', max: 6, useListenNotify: true });
    b.on('error', (err) => log.error({ err: String(err) }, 'queue error'));
    await b.start();
    for (const [name, def] of Object.entries(QUEUES)) {
      const existing = await b.getQueue(name);
      if (!existing) {
        await b.createQueue(name, def as never);
        continue;
      }
      const { policy, ...rest } = def;
      if ((existing as { policy?: string }).policy !== (policy ?? 'standard')) {
        log.warn({ queue: name, has: (existing as { policy?: string }).policy, wants: policy }, 'queue policy differs; recreate the queue to change it');
      }
      await b.updateQueue(name, rest as never).catch((err) => log.warn({ err: String(err), queue: name }, 'could not update queue settings'));
    }
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopQueue(): Promise<void> {
  if (boss) await boss.stop({ graceful: true, timeout: STOP_GRACE_MS });
  boss = undefined;
  starting = undefined;
}

export async function enqueue(name: QueueName, data: object, opts: { singletonKey?: string; startAfterSeconds?: number; id?: string } = {}): Promise<string | null> {
  const b = await startQueue();
  return b.send(name, data, {
    ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
    ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
    // A fixed id makes a redelivered webhook a no-op (the second insert is ignored).
    ...(opts.id ? { id: opts.id } : {}),
  });
}

export async function work<T extends object>(name: QueueName, handler: (data: T, job: Job<T>) => Promise<void>, concurrency = 2): Promise<void> {
  const b = await startQueue();
  await b.work<T>(name, { localConcurrency: concurrency, pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs: Job<T>[]) => {
    for (const job of jobs) await handler(job.data, job);
  });
}
