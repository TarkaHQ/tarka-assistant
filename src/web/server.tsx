import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stream } from 'hono/streaming';
import { webhookCallback } from 'grammy';
import { config } from '../config.js';
import { approvals, audit, auth, calls, identities, integrations, invites, messages, routines, usage, users } from '../db/repo.js';
import type { User, UserSettings } from '../db/types.js';
import { log } from '../log.js';
import { memory } from '../memory/hindsight.js';
import { availableModels, modelInfo } from '../models/tarka.js';
import { decideApproval } from '../agent/approvals.js';
import { pickModel, type TurnTrace } from '../agent/turn.js';
import { handleInbound } from '../channels/inbound.js';
import { parseTelnyxMessage } from '../channels/telnyx.js';
import { telegramBot, telegramUsername } from '../channels/telegram.js';
import type { InboundMessage } from '../channels/types.js';
import { sendToUser } from '../channels/deliver.js';
import { authUrl, completeOAuth } from '../integrations/google.js';
import { verifyTelnyxSignature } from '../integrations/telnyx.js';
import { sendEmail } from '../integrations/email.js';
import { checkoutUrl, handleStripeEvent, portalUrl, verifyStripeSignature } from '../billing/stripe.js';
import { enqueue } from '../jobs/queue.js';
import { syncSystemRoutines } from '../proactive/system-routines.js';
import { randomToken, openState, sealState } from '../util/crypto.js';
import { isValidHHMM, isValidTimezone, nextCronRun, startOfLocalMonth } from '../util/time.js';
import { voiceCompletions, voiceModels } from '../voice/llm.js';
import { ActivityPage, HomePage, HoodPage, MemoryPage, SchedulePage, SettingsPage, messageHtml, ApprovalCard, UpcomingList, type ActivityEntry } from './pages/app.js';
import { Landing, LoginPage, LoginSent, SimpleMessage } from './pages/public.js';
import { endSession, rateLimited, requireApi, requirePage, startSession, type AppEnv } from './session.js';
import { inboundKey } from '../channels/inbound.js';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(here, 'static');

function trialDaysLeft(user: User): number | null {
  if (user.plan !== 'trial' || !user.trial_ends_at) return null;
  return Math.max(0, Math.ceil((user.trial_ends_at.getTime() - Date.now()) / 86_400_000));
}

/** Webhooks hand messages to the queue so the HTTP response is immediate. */
export async function enqueueInbound(msg: InboundMessage): Promise<void> {
  const identity = await identities.find(msg.channel, msg.externalId);
  await enqueue('inbound', msg, { singletonKey: identity ? `user:${identity.user_id}` : inboundKey(msg) });
}

export function createApp(): Hono<AppEnv> {
  const cfg = config();
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    log.error({ err: err.stack ?? String(err), path: c.req.path }, 'request failed');
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/webhooks/')) return c.json({ error: 'Something went wrong' }, 500);
    return c.html(String(<SimpleMessage title="Something went wrong" body="Please try again in a moment." href="/app" cta="Back to the app" />), 500);
  });

  // ------------------------------------------------------------------ static & health
  app.get('/static/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9.-]+$/i.test(file)) return c.notFound();
    try {
      const body = await readFile(join(STATIC_DIR, file));
      const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      return c.body(body, 200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': cfg.isProd ? 'public, max-age=3600' : 'no-cache' });
    } catch {
      return c.notFound();
    }
  });

  app.get('/healthz', async (c) => {
    const mem = cfg.memory.enabled ? await memory.health() : null;
    return c.json({ ok: true, memory: mem, model: cfg.models.defaultModel });
  });

  // ------------------------------------------------------------------ public pages
  app.get('/', async (c) => {
    const username = await telegramUsername();
    return c.html(
      String(
        <Landing
          telegramUrl={username ? `https://t.me/${username}` : null}
          smsNumber={cfg.telnyx.phoneNumber && cfg.telnyx.apiKey ? cfg.telnyx.phoneNumber : null}
          whatsappNumber={cfg.telnyx.whatsappNumber && cfg.telnyx.apiKey ? cfg.telnyx.whatsappNumber : null}
          phoneCalls={Boolean(cfg.telnyx.conciergeAssistantId)}
        />,
      ),
    );
  });

  app.get('/login', (c) => c.html(String(<LoginPage next={c.req.query('next')} invite={cfg.product.signupMode === 'invite'} />)));

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? '').trim().toLowerCase();
    const next = String(form.next ?? '/app');
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.html(String(<LoginPage next={next} error="Enter a valid email address." invite={cfg.product.signupMode === 'invite'} />), 400);
    if (rateLimited(`login:${ip}`, 10, 15 * 60_000) || rateLimited(`login:${email}`, 5, 15 * 60_000)) {
      return c.html(String(<LoginPage next={next} error="Too many attempts. Try again in a few minutes." invite={cfg.product.signupMode === 'invite'} email={email} />), 429);
    }
    let user = await users.byEmail(email);
    if (!user) {
      if (cfg.product.signupMode === 'closed') return c.html(String(<LoginPage next={next} error="Sign-ups are closed right now." invite={false} email={email} />), 403);
      if (cfg.product.signupMode === 'invite' && !(await invites.consume(String(form.invite ?? '')))) {
        return c.html(String(<LoginPage next={next} error="That invite code isn’t valid." invite email={email} />), 403);
      }
      user = await users.create({ email, plan: 'trial', trialDays: cfg.product.trialDays, status: 'onboarding' });
      await audit.add(user.id, 'system', 'user.created', { channel: 'web' });
    }
    const token = randomToken(24);
    await auth.createLoginToken(token, email, user.id, 20);
    const link = `${cfg.publicUrl}/auth/${token}?next=${encodeURIComponent(next.startsWith('/') ? next : '/app')}`;
    const sent = await sendEmail(
      email,
      `Sign in to ${cfg.product.productName}`,
      `Here is your sign-in link. It works once, for 20 minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`,
    );
    if (!sent && !cfg.product.devLogin) log.warn({ email }, 'no email provider configured: sign-in link not delivered');
    return c.html(String(<LoginSent email={email} devLink={cfg.product.devLogin ? link : null} />));
  });

  app.get('/auth/:token', async (c) => {
    const row = await auth.consumeLoginToken(c.req.param('token'));
    if (!row?.user_id) return c.html(String(<SimpleMessage title="That link has expired" body="Sign-in links work once, for a short time. Ask for a new one." href="/login" cta="Get a new link" />), 400);
    const user = await users.get(row.user_id);
    if (!user || user.status === 'deleted') return c.redirect('/login');
    await startSession(c, user);
    const next = c.req.query('next');
    return c.redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : '/app');
  });

  app.post('/logout', async (c) => {
    await endSession(c);
    return c.redirect('/');
  });

  // ------------------------------------------------------------------ app pages
  app.get('/app', requirePage, async (c) => {
    const user = c.get('user');
    const [msgs, pending, rs, ids, username] = await Promise.all([
      messages.recent(user.id, 60),
      approvals.pending(user.id),
      routines.forUser(user.id),
      identities.forUser(user.id),
      telegramUsername(),
    ]);
    return c.html(
      String(
        <HomePage
          user={user}
          messages={msgs}
          approvals={pending}
          upcoming={rs.filter((r) => r.status === 'active' && r.next_run_at)}
          identities={ids}
          telegramReady={Boolean(username)}
          smsNumber={cfg.telnyx.phoneNumber && cfg.telnyx.apiKey ? cfg.telnyx.phoneNumber : null}
          whatsappNumber={cfg.telnyx.whatsappNumber && cfg.telnyx.apiKey ? cfg.telnyx.whatsappNumber : null}
          trialDaysLeft={trialDaysLeft(user)}
          canUpgrade={cfg.stripe.enabled}
          notice={c.req.query('google') === 'connected' ? 'Google is connected.' : undefined}
        />,
      ),
    );
  });

  app.get('/app/memory', requirePage, async (c) => {
    const user = c.get('user');
    const q = c.req.query('q') ?? '';
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
    const [list, profile] = await Promise.all([
      memory.list(user, { q, offset, limit: 50 }).catch(() => ({ items: [], total: 0 })),
      memory.profile(user).catch(() => null),
    ]);
    if (profile && profile !== user.profile_summary) await users.update(user.id, { profile_summary: profile, profile_refreshed_at: new Date() });
    return c.html(String(<MemoryPage user={user} profile={profile ?? user.profile_summary} items={list.items} total={list.total} q={q} offset={offset} enabled={cfg.memory.enabled} />));
  });

  app.get('/app/schedule', requirePage, async (c) => {
    const user = c.get('user');
    return c.html(String(<SchedulePage user={user} routines={await routines.forUser(user.id)} />));
  });

  app.get('/app/activity', requirePage, async (c) => {
    const user = c.get('user');
    const [log_, aps, cs] = await Promise.all([audit.recent(user.id, 150), approvals.recent(user.id, 50), calls.recent(user.id, 20)]);
    const entries: ActivityEntry[] = log_.map((e) => ({
      at: e.created_at,
      who: e.actor === 'agent' ? 'Assistant' : e.actor === 'user' ? 'You' : 'System',
      what: humanAction(e.action),
      detail: typeof e.detail.summary === 'string' ? e.detail.summary : undefined,
    }));
    return c.html(String(<ActivityPage user={user} entries={entries} approvals={aps} calls={cs} />));
  });

  app.get('/app/hood', requirePage, async (c) => {
    const user = c.get('user');
    const since = startOfLocalMonth(user.timezone);
    const [sum, lat, daily, recent, mem] = await Promise.all([
      usage.summary(user.id, since),
      usage.latency(user.id, since),
      usage.daily(user.id, 30),
      messages.recent(user.id, 40),
      memory.list(user, { limit: 1 }).catch(() => ({ items: [], total: 0 })),
    ]);
    const last = [...recent].reverse().find((m) => m.role === 'assistant' && m.meta.trace)?.meta.trace as TurnTrace | undefined;
    const month = sum.reduce(
      (acc, r) => ({
        messages: acc.messages + (r.purpose === 'chat' || r.purpose === 'onboarding' || r.purpose === 'proactive' ? r.calls : 0),
        inputTokens: acc.inputTokens + r.input_tokens,
        outputTokens: acc.outputTokens + r.output_tokens,
        costMicroUsd: acc.costMicroUsd + Number(r.cost_micro_usd),
        calls: acc.calls + r.calls,
      }),
      { messages: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, calls: 0 },
    );
    return c.html(
      String(
        <HoodPage
          user={user}
          model={modelInfo(pickModel(user))}
          models={availableModels()}
          last={last ?? null}
          month={month}
          latency={lat}
          daily={daily.map((d) => ({ day: d.day, tokens: d.tokens }))}
          memoryCount={mem.total}
          memoryBank={memory.bankId(user)}
        />,
      ),
    );
  });

  app.get('/app/settings', requirePage, async (c) => {
    const user = c.get('user');
    const [integ, ids] = await Promise.all([integrations.get(user.id, 'google'), identities.forUser(user.id)]);
    const billingNotice = c.req.query('billing') === 'success' ? 'Thanks — your subscription is active.' : c.req.query('google') === 'connected' ? 'Google is connected.' : undefined;
    return c.html(
      String(
        <SettingsPage
          user={user}
          googleEnabled={cfg.google.enabled}
          googleAccount={integ?.status === 'active' ? integ.account ?? 'Connected' : null}
          identities={ids}
          billing={{ enabled: cfg.stripe.enabled, plan: user.plan, trialDaysLeft: trialDaysLeft(user), status: user.subscription_status }}
          notice={billingNotice}
        />,
      ),
    );
  });

  // ------------------------------------------------------------------ JSON API (session)
  app.post('/api/chat', requireApi, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = String(body.text ?? '').trim().slice(0, 8000);
    if (!text) return c.json({ error: 'Empty message' }, 400);
    if (rateLimited(`chat:${user.id}`, 20, 60_000)) return c.json({ error: 'You are sending messages very fast. Wait a moment.' }, 429);
    await identities.create(user.id, 'web', user.id, null, true);
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return stream(c, async (s) => {
      const write = (o: unknown) => s.write(`${JSON.stringify(o)}\n`);
      await write({ type: 'status', label: 'Thinking' });
      const result = await handleInbound(
        { channel: 'web', externalId: user.id, text, receivedAt: new Date().toISOString() },
        { onStatus: (label) => void write({ type: 'status', label }) },
      );
      await write({ type: 'done', reply: result.reply ?? null });
    });
  });

  app.get('/api/messages', requireApi, async (c) => {
    const user = c.get('user');
    const after = Number(c.req.query('after') ?? 0) || 0;
    const rows = (await messages.recent(user.id, 60)).filter((m) => m.id > after);
    const pending = await approvals.pending(user.id);
    const byId = new Map(pending.map((a) => [a.id, a]));
    const upcoming = (await routines.forUser(user.id)).filter((r) => r.status === 'active' && r.next_run_at);
    return c.json({
      messages: rows.map((m) => ({ id: m.id, html: messageHtml(m, user, byId) })),
      approvalsHtml: pending.length
        ? `<ul class="list">${pending.map((a) => String(<ApprovalCard a={a} tz={user.timezone} />)).join('')}</ul>`
        : '<p class="empty">Nothing needs your OK. Anything that sends, invites, deletes or calls will wait here.</p>',
      upcomingHtml: String(<UpcomingList upcoming={upcoming} tz={user.timezone} />),
    });
  });

  app.post('/api/approvals/:id', requireApi, async (c) => {
    const user = c.get('user');
    const { decision } = (await c.req.json().catch(() => ({}))) as { decision?: string };
    if (decision !== 'approved' && decision !== 'rejected') return c.json({ error: 'Invalid decision' }, 400);
    const outcome = await decideApproval(user, c.req.param('id'), decision, 'web');
    await messages.add(user.id, 'assistant', 'web', outcome.message, { source: 'approval' });
    return c.json(outcome);
  });

  app.post('/api/memories/forget-all', requireApi, async (c) => {
    const user = c.get('user');
    await memory.wipe(user);
    await users.update(user.id, { profile_summary: null, profile_refreshed_at: null });
    await audit.add(user.id, 'user', 'memory.wiped', {});
    return c.json({ ok: true });
  });

  app.post('/api/memories/:id/forget', requireApi, async (c) => {
    const user = c.get('user');
    await memory.forget(user, c.req.param('id'));
    await audit.add(user.id, 'user', 'memory.forgot', {});
    return c.json({ ok: true });
  });

  app.post('/api/routines/:id/:action', requireApi, async (c) => {
    const user = c.get('user');
    const r = await routines.get(user.id, c.req.param('id'));
    if (!r) return c.json({ error: 'Not found' }, 404);
    const action = c.req.param('action');
    if (action === 'pause') await routines.setStatus(user.id, r.id, 'paused');
    else if (action === 'cancel') {
      await routines.setStatus(user.id, r.id, 'cancelled');
      if (r.kind === 'brief') await users.updateSettings(user.id, { briefTime: null });
    } else if (action === 'resume') {
      const next = r.schedule_type === 'cron' && r.cron ? nextCronRun(r.cron, r.timezone) : r.run_at && r.run_at > new Date() ? r.run_at : null;
      await routines.update(user.id, r.id, { status: next ? 'active' : 'done', nextRunAt: next });
    } else return c.json({ error: 'Unknown action' }, 400);
    await audit.add(user.id, 'user', `routine.${action}`, { summary: r.title });
    return c.json({ ok: true });
  });

  app.post('/api/settings', requireApi, async (c) => {
    const user = c.get('user');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Partial<User> = {};
    const str = (k: string, max = 120) => (typeof b[k] === 'string' ? (b[k] as string).trim().slice(0, max) : undefined);
    if (str('name') !== undefined) patch.name = str('name') || null;
    if (str('assistant_name', 40) !== undefined) patch.assistant_name = str('assistant_name', 40) || null;
    if (str('city') !== undefined) patch.city = str('city') || null;
    const tz = str('timezone', 64);
    if (tz !== undefined) {
      if (!isValidTimezone(tz)) return c.json({ error: `“${tz}” isn’t a timezone name. Try Europe/Berlin or America/New_York.` }, 400);
      patch.timezone = tz;
    }
    const model = str('model', 64);
    if (model !== undefined) {
      if (!cfg.models.allowed.includes(model)) return c.json({ error: 'That model isn’t available' }, 400);
      patch.model = model;
    }
    const settings: Partial<UserSettings> = {};
    const brief = str('brief_time', 5);
    if (brief !== undefined) {
      if (brief !== 'off' && !isValidHHMM(brief)) return c.json({ error: 'Brief time must be HH:MM' }, 400);
      settings.briefTime = brief === 'off' ? null : brief;
    }
    const prox = str('proactivity', 10);
    if (prox && ['off', 'low', 'normal', 'high'].includes(prox)) settings.proactivity = prox as UserSettings['proactivity'];
    const qs = str('quiet_start', 5);
    const qe = str('quiet_end', 5);
    if (qs && qe && isValidHHMM(qs) && isValidHHMM(qe)) settings.quietHours = { start: qs, end: qe };
    if (typeof b.meeting_nudges === 'boolean') settings.meetingNudges = b.meeting_nudges;
    if (typeof b.voice_replies === 'boolean') settings.voiceReplies = b.voice_replies;
    let updated = Object.keys(patch).length ? await users.update(user.id, patch) : user;
    if (Object.keys(settings).length) updated = await users.updateSettings(user.id, settings);
    if (updated.status === 'onboarding' && updated.name && updated.timezone !== 'UTC') updated = await users.update(user.id, { status: 'active' });
    await syncSystemRoutines(updated);
    await audit.add(user.id, 'user', 'settings.updated', {});
    return c.json({ ok: true });
  });

  app.post('/api/link/telegram', requireApi, async (c) => {
    const user = c.get('user');
    const username = await telegramUsername();
    if (!username) return c.json({ error: 'Telegram isn’t set up on this deployment' }, 400);
    const code = await auth.createLinkCode(user.id, 30);
    return c.json({ url: `https://t.me/${username}?start=${code}` });
  });

  app.post('/api/google/disconnect', requireApi, async (c) => {
    const user = c.get('user');
    await integrations.remove(user.id, 'google');
    await audit.add(user.id, 'user', 'google.disconnected', {});
    return c.json({ ok: true });
  });

  app.post('/api/identities/:id/remove', requireApi, async (c) => {
    const user = c.get('user');
    await identities.remove(user.id, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/account/delete', requireApi, async (c) => {
    const user = c.get('user');
    await memory.wipe(user);
    await users.delete(user.id);
    await endSession(c);
    log.info({ user: user.id }, 'account deleted');
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ Google OAuth
  app.get('/oauth/google/connect', requirePage, (c) => {
    if (!cfg.google.enabled) return c.redirect('/app/settings');
    return c.redirect(authUrl(sealState({ uid: c.get('user').id, p: 'google' }, 900)));
  });

  // Link sent in chat (signed, expiring): starts OAuth for that user without a web session.
  app.get('/oauth/google/start', (c) => {
    const s = openState<{ uid: string; p: string }>(c.req.query('s') ?? '');
    if (!s || s.p !== 'google' || !cfg.google.enabled) return c.html(String(<SimpleMessage title="That link has expired" body="Ask your assistant for a new link to connect Google." />), 400);
    return c.redirect(authUrl(sealState({ uid: s.uid, p: 'google' }, 900)));
  });

  app.get('/oauth/google/callback', async (c) => {
    const s = openState<{ uid: string; p: string }>(c.req.query('state') ?? '');
    const code = c.req.query('code');
    if (!s || s.p !== 'google' || !code) return c.html(String(<SimpleMessage title="Google wasn’t connected" body="The request expired or was cancelled. Try again from your assistant." href="/app/settings" cta="Open settings" />), 400);
    const user = await users.get(s.uid);
    if (!user) return c.redirect('/');
    const integ = await completeOAuth(user.id, code);
    await audit.add(user.id, 'user', 'google.connected', { summary: integ.account ?? undefined });
    await sendToUser(user, `Google is connected${integ.account ? ` (${integ.account})` : ''}. I can now see your calendar and email. Try “what does my week look like?”`, {
      persist: { role: 'assistant', meta: { source: 'system' } },
    });
    return c.html(String(<SimpleMessage title="Google is connected" body="You can close this page and go back to your conversation." href="/app" cta="Open the app" />));
  });

  // ------------------------------------------------------------------ Billing
  app.get('/billing/start', requirePage, async (c) => {
    if (!cfg.stripe.enabled) return c.redirect('/app/settings');
    return c.redirect(await checkoutUrl(c.get('user')));
  });
  app.get('/billing/checkout', async (c) => {
    const s = openState<{ uid: string; p: string }>(c.req.query('s') ?? '');
    if (!s || s.p !== 'checkout' || !cfg.stripe.enabled) return c.redirect('/login');
    const user = await users.get(s.uid);
    if (!user) return c.redirect('/login');
    return c.redirect(await checkoutUrl(user));
  });
  app.get('/billing/portal', requirePage, async (c) => {
    const url = cfg.stripe.enabled ? await portalUrl(c.get('user')) : null;
    return c.redirect(url ?? '/app/settings');
  });
  app.post('/webhooks/stripe', async (c) => {
    const raw = await c.req.text();
    if (!verifyStripeSignature(raw, c.req.header('stripe-signature'))) return c.json({ error: 'bad signature' }, 400);
    await handleStripeEvent(JSON.parse(raw));
    return c.json({ received: true });
  });

  // ------------------------------------------------------------------ Channel webhooks
  const bot = telegramBot();
  if (bot && cfg.telegram.mode === 'webhook') {
    const handle = webhookCallback(bot, 'hono', { secretToken: cfg.telegram.webhookSecret, timeoutMilliseconds: 9000 });
    app.post('/webhooks/telegram', (c) => handle(c) as Promise<Response>);
  }

  app.post('/webhooks/telnyx/messaging', async (c) => {
    const raw = await c.req.text();
    if (!verifyTelnyxSignature(raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'))) {
      return c.json({ error: 'bad signature' }, 401);
    }
    const event = JSON.parse(raw) as Parameters<typeof parseTelnyxMessage>[0];
    const msg = parseTelnyxMessage(event);
    if (msg) await enqueueInbound(msg);
    return c.json({ ok: true });
  });

  app.post('/webhooks/telnyx/voice', async (c) => {
    // Call lifecycle events (optional): useful for logs; the concierge flow polls instead.
    const raw = await c.req.text();
    if (!verifyTelnyxSignature(raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'))) return c.json({ error: 'bad signature' }, 401);
    log.debug({ event: JSON.parse(raw)?.data?.event_type }, 'telnyx voice event');
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ Voice "custom LLM" (Telnyx AI Assistants)
  app.post('/voice/v1/chat/completions', (c) => voiceCompletions(c));
  app.get('/voice/v1/models', (c) => voiceModels(c));

  return app;
}

const ACTIONS: Record<string, string> = {
  'user.created': 'Account created',
  'approval.requested': 'Asked for your approval',
  'approval.approved': 'You approved a request',
  'approval.rejected': 'You declined a request',
  'channel.linked': 'Connected a channel',
  'channel.opted_out': 'You stopped messages on a channel',
  'google.connected': 'Connected Google',
  'google.disconnected': 'Disconnected Google',
  'memory.wiped': 'Erased all memory',
  'memory.forgot': 'Forgot a memory',
  'settings.updated': 'Updated settings',
  'billing.subscribed': 'Subscribed',
  remember: 'Saved to memory',
  memory_forget: 'Forgot memories',
  schedule_reminder: 'Set a reminder',
  schedule_task: 'Scheduled a task',
  cancel_scheduled: 'Cancelled a scheduled item',
  reschedule: 'Changed a scheduled item',
  list_add: 'Updated a list',
  update_profile: 'Updated your profile',
  finish_onboarding: 'Finished setup',
  calendar_create_event: 'Added a calendar event',
  calendar_update_event: 'Changed a calendar event',
  calendar_delete_event: 'Deleted a calendar event',
  email_draft: 'Drafted an email',
  email_send: 'Sent an email',
  call_business: 'Called a business',
  'brief.skipped': 'Skipped a brief (nothing to say)',
  'checkin.skipped': 'Checked in quietly (nothing to flag)',
};

function humanAction(action: string): string {
  return ACTIONS[action] ?? action.replace(/[._]/g, ' ');
}

