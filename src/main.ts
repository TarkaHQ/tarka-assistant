import { serve } from '@hono/node-server';
import { config } from './config.js';
import { db, closeDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { users } from './db/repo.js';
import { log } from './log.js';
import { memory } from './memory/hindsight.js';
import { handleInbound } from './channels/inbound.js';
import type { InboundMessage } from './channels/types.js';
import { setTelegramInbound, telegramBot } from './channels/telegram.js';
import { startQueue, stopQueue, work } from './jobs/queue.js';
import { meetingNudgeScan, runRoutine, schedulerTick, watchCall } from './proactive/scheduler.js';
import { createApp, enqueueInbound } from './web/server.js';

/**
 * ROLE=web     HTTP: dashboard, webhooks, voice endpoint (enqueues work)
 * ROLE=worker  background: inbound messages, memory, schedules, calls, Telegram polling
 * ROLE=all     both in one process (development and small deployments)
 */
const role = (process.env.ROLE ?? 'all') as 'web' | 'worker' | 'all';
const cfg = config();

async function startWeb() {
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' });
  log.info({ port: cfg.port, url: cfg.publicUrl }, 'web server listening');
  const bot = telegramBot();
  if (bot && cfg.telegram.mode === 'webhook') {
    await bot.api
      .setWebhook(`${cfg.publicUrl}/webhooks/telegram`, { secret_token: cfg.telegram.webhookSecret, allowed_updates: ['message', 'callback_query'] })
      .then(() => log.info('telegram webhook registered'))
      .catch((err) => log.error({ err: String(err) }, 'telegram webhook registration failed'));
  }
  return server;
}

async function startWorker() {
  await work<InboundMessage>('inbound', async (msg) => {
    await handleInbound(msg);
  }, 4);
  await work<{ userId: string; userText: string; assistantText: string; channel: string; at: string; documentId: string }>('memory-retain', async (d) => {
    const user = await users.get(d.userId);
    if (!user) return;
    await memory.retainExchange(user, { userText: d.userText, assistantText: d.assistantText, channel: d.channel, at: new Date(d.at), documentId: d.documentId });
  }, 4);
  await work<{ routineId: string; userId: string }>('routine-run', async (d) => {
    await runRoutine(d.routineId, d.userId);
  }, 3);
  await work<{ callId: string; attempt: number }>('call-watch', async (d) => {
    await watchCall(d.callId, d.attempt);
  }, 2);

  const tick = async () => {
    try {
      await schedulerTick();
    } catch (err) {
      log.error({ err: String(err) }, 'scheduler tick failed');
    }
  };
  setInterval(tick, cfg.proactive.schedulerIntervalMs).unref();
  void tick();
  setInterval(() => void meetingNudgeScan().catch((err) => log.error({ err: String(err) }, 'nudge scan failed')), 5 * 60_000).unref();

  const bot = telegramBot();
  if (bot && cfg.telegram.mode === 'polling') {
    await bot.api.deleteWebhook().catch(() => {});
    bot
      .start({ drop_pending_updates: false, onStart: (me) => log.info({ bot: me.username }, 'telegram polling started') })
      .catch((err) => log.error({ err: String(err) }, 'telegram polling stopped (check TELEGRAM_BOT_TOKEN)'));
  }
  log.info('worker started');
}

async function main() {
  const applied = await migrate(db());
  if (applied.length) log.info({ applied }, 'migrations applied');
  await startQueue();
  // Telegram updates become queued inbound jobs in every role.
  setTelegramInbound(enqueueInbound);
  if (role === 'web' || role === 'all') await startWeb();
  if (role === 'worker' || role === 'all') await startWorker();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await telegramBot()?.stop().catch(() => {});
    await stopQueue().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.stack : String(err) }, 'fatal startup error');
  process.exit(1);
});
