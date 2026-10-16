import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/index.js';
import { enqueue, startQueue, stopQueue, work } from '../src/jobs/queue.js';
import { stableUuid } from '../src/util/crypto.js';
import { resetDb } from './helpers.js';

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
});
afterAll(async () => {
  await stopQueue();
  await closeDb();
});

describe('inbound queue', () => {
  it('is per-person, retries once and heartbeats', async () => {
    const boss = await startQueue();
    const q = (await boss.getQueue('inbound')) as unknown as { policy: string; retryLimit: number; heartbeatSeconds: number | null };
    expect(q).toMatchObject({ policy: 'singleton', retryLimit: 1, heartbeatSeconds: 30 });
  });

  it('queues a redelivered webhook once', async () => {
    const id = stableUuid('telegram:42:1001');
    expect(await enqueue('inbound', { n: 'dup' }, { singletonKey: 'user:dup', id })).toBe(id);
    expect(await enqueue('inbound', { n: 'dup' }, { singletonKey: 'user:dup', id })).toBeNull();
  });

  it('does not let a failed message hold back that person’s next one', async () => {
    const seen: string[] = [];
    await work<{ n: string }>(
      'inbound',
      async (d) => {
        seen.push(d.n);
        if (d.n === 'a') throw new Error('boom');
      },
      2,
    );
    await enqueue('inbound', { n: 'a' }, { singletonKey: 'user:1' });
    await enqueue('inbound', { n: 'b' }, { singletonKey: 'user:1' });
    await waitFor(() => seen.includes('b'));
    expect(seen.indexOf('a')).toBeLessThan(seen.indexOf('b'));
  });
});
