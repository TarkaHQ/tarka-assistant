import { PgBoss, type Job } from 'pg-boss';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Background work runs on pg-boss (jobs in the same Postgres). Inbound messages are ordered per
 * conversation with `key_strict_fifo`, so one user's messages are handled one at a time, in order.
 */

type QueueDef = {
  policy?: 'standard' | 'key_strict_fifo' | 'singleton' | 'stately';
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  notify?: boolean;
};

export const QUEUES: Record<string, QueueDef> = {
  // Handlers never throw for inbound: a failed job would hold back that user's later messages.
  inbound: { policy: 'key_strict_fifo', retryLimit: 0, expireInSeconds: 600, notify: true },
  'memory-retain': { retryLimit: 5, retryDelay: 20, retryBackoff: true, expireInSeconds: 300 },
  'routine-run': { retryLimit: 1, retryDelay: 60, expireInSeconds: 900, notify: true },
  'call-watch': { retryLimit: 0, expireInSeconds: 300 },
  'profile-refresh': { retryLimit: 1, expireInSeconds: 300 },
};

export type QueueName = keyof typeof QUEUES;

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
      if (!existing) await b.createQueue(name, def as never);
    }
    boss = b;
    return b;
  })();
  return starting;
}

export async function stopQueue(): Promise<void> {
  if (boss) await boss.stop({ graceful: true, timeout: 10_000 } as never);
  boss = undefined;
  starting = undefined;
}

export async function enqueue(name: QueueName, data: object, opts: { singletonKey?: string; startAfterSeconds?: number } = {}): Promise<string | null> {
  const b = await startQueue();
  const def = QUEUES[name]!;
  const singletonKey = opts.singletonKey ?? (def.policy === 'key_strict_fifo' ? 'default' : undefined);
  return b.send(name, data, {
    ...(singletonKey ? { singletonKey } : {}),
    ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
  });
}

export async function work<T extends object>(name: QueueName, handler: (data: T, job: Job<T>) => Promise<void>, concurrency = 2): Promise<void> {
  const b = await startQueue();
  await b.work<T>(name, { localConcurrency: concurrency, pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs: Job<T>[]) => {
    for (const job of jobs) await handler(job.data, job);
  });
}
