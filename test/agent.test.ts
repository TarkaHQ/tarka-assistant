import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { db, closeDb } from '../src/db/index.js';
import { approvals, identities, integrations, lists, messages, routines, usage, users, invites } from '../src/db/repo.js';
import { handleInbound } from '../src/channels/inbound.js';
import { schedulerTick, runRoutine } from '../src/proactive/scheduler.js';
import { loadConfig, setConfig } from '../src/config.js';
import { encrypt } from '../src/util/crypto.js';
import { captureChannels, clearModel, makeUser, resetDb, scriptedModel } from './helpers.js';
import type { InboundMessage } from '../src/channels/types.js';

const sent = captureChannels();
const sms = (from: string, text: string): InboundMessage => ({ channel: 'sms', externalId: from, text, receivedAt: new Date().toISOString(), country: from.startsWith('+49') ? 'DE' : 'US' });

beforeAll(async () => {
  await resetDb();
});
beforeEach(async () => {
  sent.length = 0;
  clearModel();
  await db().unsafe('truncate users cascade; truncate invites; truncate kv;');
});
afterAll(async () => {
  await closeDb();
});

describe('sign-up and onboarding over SMS', () => {
  it('creates a user for a new number and replies', async () => {
    const { calls } = scriptedModel([{ text: 'Hi! I’m Tarka. What should I call you?' }]);
    const res = await handleInbound(sms('+4915100000001', 'hi'));
    expect(res.reply).toContain('What should I call you');
    const user = await users.byPhone('+4915100000001');
    expect(user).toMatchObject({ status: 'onboarding', plan: 'trial', timezone: 'Europe/Berlin' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', to: '+4915100000001' });
    const rows = await messages.recent(user!.id);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    // The onboarding instructions reached the model.
    expect(JSON.stringify(calls[0]!.prompt)).toContain('First conversation (onboarding)');
    const u = await usage.summary(user!.id, new Date(0));
    expect(u[0]).toMatchObject({ purpose: 'onboarding', input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 });
  });

  it('saves the profile, finishes onboarding and starts the morning brief', async () => {
    const user = await makeUser({ status: 'onboarding', name: undefined as unknown as string, phone: '+4915100000002' });
    await users.update(user.id, { name: null });
    scriptedModel([
      { toolCalls: [{ name: 'update_profile', input: { name: 'Priya', city: 'Berlin', timezone: 'Europe/Berlin' } }] },
      { toolCalls: [{ name: 'finish_onboarding', input: {} }] },
      { text: 'Lovely to meet you, Priya. I’ll send a short brief at 7:30 each morning.' },
    ]);
    await handleInbound(sms('+4915100000002', 'Priya, I live in Berlin'));
    const u = (await users.get(user.id))!;
    expect(u).toMatchObject({ name: 'Priya', city: 'Berlin', timezone: 'Europe/Berlin', status: 'active' });
    const rs = await routines.forUser(user.id);
    const brief = rs.find((r) => r.kind === 'brief')!;
    expect(brief.cron).toBe('30 7 * * *');
    expect(DateTime.fromJSDate(brief.next_run_at!).setZone('Europe/Berlin').toFormat('HH:mm')).toBe('07:30');
    expect(rs.some((r) => r.kind === 'checkin')).toBe(true);
  });
});

describe('everyday tools', () => {
  it('sets a reminder in the user’s timezone', async () => {
    const user = await makeUser({ phone: '+4915100000003' });
    scriptedModel([{ toolCalls: [{ name: 'schedule_reminder', input: { text: 'Call Mum', when: 'tomorrow at 6pm' } }] }, { text: 'Done — I’ll remind you tomorrow at 6pm.' }]);
    await handleInbound(sms('+4915100000003', 'remind me to call mum tomorrow at 6pm'));
    const [r] = await routines.byKind(user.id, 'reminder');
    expect(r!.title).toBe('Call Mum');
    const local = DateTime.fromJSDate(r!.next_run_at!).setZone('Europe/Berlin');
    expect(local.toFormat('HH:mm')).toBe('18:00');
    expect(local.toISODate()).toBe(DateTime.now().setZone('Europe/Berlin').plus({ days: 1 }).toISODate());
  });

  it('keeps lists', async () => {
    const user = await makeUser({ phone: '+4915100000004' });
    scriptedModel([{ toolCalls: [{ name: 'list_add', input: { list: 'groceries', items: ['milk', 'eggs', 'Milk'] } }] }, { text: 'Added milk and eggs.' }]);
    await handleInbound(sms('+4915100000004', 'add milk and eggs to groceries'));
    expect((await lists.items(user.id, 'groceries list')).map((i) => i.text)).toEqual(['milk', 'eggs']);
  });

  it('reports tool errors to the model instead of crashing', async () => {
    await makeUser({ phone: '+4915100000005' });
    const { calls } = scriptedModel([{ toolCalls: [{ name: 'schedule_reminder', input: { text: 'x', when: 'whenever' } }] }, { text: 'When exactly?' }]);
    const res = await handleInbound(sms('+4915100000005', 'remind me sometime'));
    expect(res.reply).toBe('When exactly?');
    expect(JSON.stringify(calls[1]!.prompt)).toContain("couldn't work out the time");
  });
});

describe('approval gate', () => {
  const realFetch = globalThis.fetch;
  let gmailSends = 0;

  beforeAll(() => {
    setConfig(loadConfig({ ...process.env, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }));
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
        gmailSends++;
        return new Response(JSON.stringify({ id: 'sent1', threadId: 't1' }), { status: 200 });
      }
      return realFetch(url as string, init);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    setConfig(loadConfig());
  });

  async function googleUser(phone: string) {
    const user = await makeUser({ phone });
    await integrations.upsert(user.id, 'google', { account: 'priya@example.com', scopes: ['gmail.modify'], accessTokenEnc: encrypt('tok'), refreshTokenEnc: encrypt('ref'), expiresAt: new Date(Date.now() + 3600_000) });
    return user;
  }

  it('holds an email until the user says yes, then sends exactly once', async () => {
    const user = await googleUser('+4915100000010');
    scriptedModel([
      { toolCalls: [{ name: 'email_send', input: { to: ['sam@example.com'], subject: 'Deck', body: 'Hi Sam, deck attached.' } }] },
      { text: 'Here’s the email to Sam. Send it?' },
    ]);
    await handleInbound(sms('+4915100000010', 'email sam that the deck is attached'));
    expect(gmailSends).toBe(0);
    const pending = await approvals.pending(user.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.summary).toContain('sam@example.com');
    expect(sent.at(-1)!.msg.buttons?.length).toBe(2);

    clearModel(); // the decision must not involve the model at all
    const yes = await handleInbound(sms('+4915100000010', 'yes'));
    expect(gmailSends).toBe(1);
    expect(yes.reply).toMatch(/^Done/);
    expect((await approvals.recent(user.id))[0]!.status).toBe('executed');

    // A second "yes" must not send again.
    scriptedModel([{ text: 'Anything else?' }]);
    await handleInbound(sms('+4915100000010', 'yes'));
    expect(gmailSends).toBe(1);
  });

  it('cancels on no', async () => {
    const user = await googleUser('+4915100000011');
    scriptedModel([{ toolCalls: [{ name: 'email_send', input: { to: ['a@b.com'], subject: 'x', body: 'y' } }] }, { text: 'Send it?' }]);
    await handleInbound(sms('+4915100000011', 'email a@b.com'));
    const no = await handleInbound(sms('+4915100000011', 'no'));
    expect(no.reply).toContain('cancelled');
    expect((await approvals.recent(user.id))[0]!.status).toBe('rejected');
  });

  it('treats "yes, but…" as a new instruction, not an approval', async () => {
    const user = await googleUser('+4915100000012');
    scriptedModel([{ toolCalls: [{ name: 'email_send', input: { to: ['a@b.com'], subject: 'x', body: 'y' } }] }, { text: 'Send it?' }]);
    await handleInbound(sms('+4915100000012', 'email a@b.com'));
    scriptedModel([{ text: 'Sure, changing the subject.' }]);
    const r = await handleInbound(sms('+4915100000012', 'yes but change the subject to Hello'));
    expect(r.reply).toBe('Sure, changing the subject.');
    expect((await approvals.pending(user.id))).toHaveLength(1);
  });
});

describe('channels and compliance', () => {
  it('honours STOP and ignores later messages', async () => {
    await makeUser({ phone: '+4915100000020' });
    const { calls } = scriptedModel([{ text: 'should not be called' }]);
    await handleInbound(sms('+4915100000020', 'STOP'));
    await handleInbound(sms('+4915100000020', 'hello?'));
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const id = await identities.find('sms', '+4915100000020');
    expect(id!.opted_out_at).not.toBeNull();
  });

  it('keeps WhatsApp to allowed countries', async () => {
    const { calls } = scriptedModel([{ text: 'nope' }]);
    await handleInbound({ channel: 'whatsapp', externalId: '+14155550123', text: 'hi', receivedAt: new Date().toISOString() });
    await handleInbound({ channel: 'whatsapp', externalId: '+14155550123', text: 'hi again', receivedAt: new Date().toISOString() });
    expect(calls).toHaveLength(0);
    expect(await users.byPhone('+14155550123')).toBeNull();
    expect(sent).toHaveLength(1); // told once, not on every message
  });

  it('requires an invite code in invite mode', async () => {
    setConfig(loadConfig({ ...process.env, SIGNUP_MODE: 'invite' }));
    try {
      await invites.create('EARLY1', 1);
      scriptedModel([{ text: 'Welcome!' }]);
      await handleInbound(sms('+4915100000030', 'hello'));
      expect(await users.byPhone('+4915100000030')).toBeNull();
      expect(sent.at(-1)!.msg.text).toContain('invite-only');
      await handleInbound(sms('+4915100000030', 'early1'));
      expect(await users.byPhone('+4915100000030')).not.toBeNull();
    } finally {
      setConfig(loadConfig());
    }
  });

  it('web chat stores messages without pushing anywhere', async () => {
    const user = await makeUser({ phone: '+4915100000040' });
    await identities.create(user.id, 'web', user.id, null, true);
    scriptedModel([{ text: 'Hello from the web' }]);
    const r = await handleInbound({ channel: 'web', externalId: user.id, text: 'hi', receivedAt: new Date().toISOString() });
    expect(r.reply).toBe('Hello from the web');
    expect(sent).toHaveLength(0);
  });
});

describe('scheduler', () => {
  it('fires a due reminder once and completes it', async () => {
    const user = await makeUser({ phone: '+4915100000050' });
    const r = await routines.create(user.id, { kind: 'reminder', title: 'Take the bins out', scheduleType: 'once', runAt: new Date(Date.now() - 1000), timezone: 'Europe/Berlin', nextRunAt: new Date(Date.now() - 1000) });
    const claimed = await routines.claimDue(10, () => null);
    expect(claimed.map((x) => x.id)).toContain(r.id);
    expect(await routines.claimDue(10, () => null)).toHaveLength(0);
    await runRoutine(r.id, user.id);
    expect(sent.at(-1)!.msg.text).toBe('⏰ Reminder: Take the bins out');
    expect((await routines.get(user.id, r.id))!.status).toBe('done');
  });

  it('moves a repeating routine to its next run', async () => {
    const user = await makeUser({ phone: '+4915100000051' });
    await routines.create(user.id, { kind: 'reminder', title: 'Stretch', scheduleType: 'cron', cron: '0 9 * * *', timezone: 'Europe/Berlin', nextRunAt: new Date(Date.now() - 1000) });
    const n = await schedulerTick().catch(() => -1); // enqueue may be unavailable in tests; claiming still happens
    void n;
    const [r] = await routines.byKind(user.id, 'reminder');
    expect(r!.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    expect(DateTime.fromJSDate(r!.next_run_at!).setZone('Europe/Berlin').toFormat('HH:mm')).toBe('09:00');
  });

  it('stays quiet when a check-in has nothing worth saying', async () => {
    const user = await makeUser({ phone: '+4915100000052', timezone: 'UTC' });
    await users.updateSettings(user.id, { quietHours: { start: '00:00', end: '00:01' } });
    const r = await routines.create(user.id, { kind: 'checkin', title: 'Check-in', scheduleType: 'cron', cron: '0 12 * * *', timezone: 'UTC', nextRunAt: new Date(), createdBy: 'system' });
    scriptedModel([{ text: 'NO_MESSAGE' }]);
    await runRoutine(r.id, user.id);
    expect(sent).toHaveLength(0);
  });

  it('sends the morning brief when the model has something to say', async () => {
    const user = await makeUser({ phone: '+4915100000053', timezone: 'UTC' });
    await users.updateSettings(user.id, { quietHours: { start: '00:00', end: '00:01' } });
    const r = await routines.create(user.id, { kind: 'brief', title: 'Morning brief', scheduleType: 'cron', cron: '30 7 * * *', timezone: 'UTC', nextRunAt: new Date(), createdBy: 'system' });
    const { calls } = scriptedModel([{ text: 'Morning! Two things today…' }]);
    await runRoutine(r.id, user.id);
    expect(sent.at(-1)!.msg.text).toContain('Two things today');
    expect(JSON.stringify(calls[0]!.prompt)).toContain('Task: morning brief');
  });
});

describe('voice', () => {
  it('answers a known caller without email tools and texts approvals', async () => {
    const { voiceCompletions } = await import('../src/voice/llm.js');
    const { Hono } = await import('hono');
    const user = await makeUser({ phone: '+4915100000060' });
    const { calls } = scriptedModel([{ text: 'You have two meetings today.' }]);
    const app = new Hono();
    app.post('/v', (c) => voiceCompletions(c));
    const res = await app.request('/v', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tarka-assistant', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: "what's on today?" }], extra_metadata: { telnyx_end_user_target: '+4915100000060' } }),
    });
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]!.message.content).toBe('You have two meetings today.');
    expect(calls[0]!.tools.some((t) => t.startsWith('email_'))).toBe(false);
    const rows = await messages.recent(user.id);
    expect(rows.map((r) => r.channel)).toEqual(['voice', 'voice']);
  });

  it('runs the concierge persona for outbound calls and keeps the transcript', async () => {
    const { voiceCompletions } = await import('../src/voice/llm.js');
    const { calls: callsRepo } = await import('../src/db/repo.js');
    const { Hono } = await import('hono');
    const user = await makeUser({ phone: '+4915100000061' });
    const call = await callsRepo.create(user.id, { direction: 'outbound', to: '+4930123456', objective: 'Book a table for 2 on Friday at 7pm', meta: { business: 'Café Luna' } });
    const { calls } = scriptedModel([{ text: 'Hello, I’m an AI assistant calling for Priya. Could I book a table for two on Friday at 7pm?' }]);
    const app = new Hono();
    app.post('/v', (c) => voiceCompletions(c));
    const res = await app.request('/v', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Café Luna, how can I help?' }], extra_metadata: { ta_call_id: call.id }, tools: [{ type: 'function', function: { name: 'hangup', description: 'End the call', parameters: { type: 'object', properties: {} } } }] }),
    });
    const text = await res.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('[DONE]');
    expect(JSON.stringify(calls[0]!.prompt)).toContain('Book a table for 2 on Friday at 7pm');
    expect(calls[0]!.tools).toContain('hangup');
    const updated = await callsRepo.get(call.id);
    expect(updated!.transcript).toContain('Business: Café Luna, how can I help?');
  });
});
