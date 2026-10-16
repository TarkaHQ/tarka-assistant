import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, closeDb } from '../src/db/index.js';
import { integrations, users } from '../src/db/repo.js';
import { loadConfig, setConfig } from '../src/config.js';
import { createApp } from '../src/web/server.js';
import { connectGoogleLink, dashboardLink } from '../src/web/links.js';
import { captureChannels, makeUser, resetDb } from './helpers.js';

const sent = captureChannels();
const realFetch = globalThis.fetch;
let stripeOk = true;
const stripeCalls: string[] = [];

function testConfig(extra: Record<string, string> = {}) {
  setConfig(
    loadConfig({
      ...process.env,
      PUBLIC_URL: 'http://localhost:8080',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_PRICE_ID: 'price_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      MEMORY_ENABLED: 'false',
      ...extra,
    }),
  );
}

beforeAll(async () => {
  await resetDb();
  testConfig();
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid email' });
    if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: 'priya@gmail.com' });
    if (u.startsWith('https://api.stripe.com/v1/subscriptions/')) {
      stripeCalls.push(`${init?.method} ${u}`);
      return stripeOk ? Response.json({ id: 'sub_1', status: 'canceled' }) : Response.json({ error: { message: 'Stripe is down' } }, { status: 500 });
    }
    return realFetch(url as string, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  setConfig(loadConfig());
  await closeDb();
});
beforeEach(async () => {
  sent.length = 0;
  stripeOk = true;
  stripeCalls.length = 0;
  await db().unsafe('truncate users cascade; truncate login_tokens; truncate kv;');
});

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

describe('sign-in links', () => {
  it('are not used up by opening them (link previews), only by the button', async () => {
    const app = createApp();
    const user = await makeUser({ phone: '+4915100000200' });
    const path = new URL(await dashboardLink(user)).pathname;
    for (let i = 0; i < 2; i++) {
      const page = await app.request(path);
      expect(page.status).toBe(200);
      const html = await page.text();
      // Named by something its owner can't edit, not by the free-text name.
      expect(html).toContain('the phone number ending 0200');
      expect(html).not.toContain('Priya');
    }
    const signIn = await app.request(path, form({ next: '/app' }));
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get('location')).toBe('/app');
    expect(cookiesOf(signIn)).toContain('ta_session=');
    expect((await app.request(path, form({ next: '/app' }))).status).toBe(400);
  });

  it('only continue to our own pages', async () => {
    const app = createApp();
    const user = await makeUser({ phone: '+4915100000201' });
    const path = new URL(await dashboardLink(user)).pathname;
    const page = await (await app.request(`${path}?next=${encodeURIComponent('https://evil.example/x')}`)).text();
    expect(page).toContain('value="/app"');
    const res = await app.request(path, form({ next: '//evil.example' }));
    expect(res.headers.get('location')).toBe('/app');
  });

  it('refuse a cross-site form post in production (login CSRF)', async () => {
    testConfig({ NODE_ENV: 'production', APP_SECRET: 'p'.repeat(48) });
    try {
      const app = createApp();
      const user = await makeUser({ phone: '+4915100000202' });
      const path = new URL(await dashboardLink(user)).pathname;
      const evil = await app.request(path, { ...form({ next: '/app' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' } });
      expect(evil.status).toBe(403);
      const ok = await app.request(path, { ...form({ next: '/app' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost:8080' } });
      expect(ok.status).toBe(302);
    } finally {
      testConfig();
    }
  });
});

describe('connecting Google', () => {
  async function startFromChatLink(app: ReturnType<typeof createApp>, phone: string) {
    const user = await makeUser({ phone });
    const link = new URL(await connectGoogleLink(user));
    const page = await (await app.request(link.pathname + link.search)).text();
    expect(page).toContain('Connect Google');
    const signIn = await app.request(link.pathname, form({ next: '/oauth/google/connect' }));
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain('Confirm it’s you');
    const session = cookiesOf(signIn);
    // The code went to the account's own chat (here: SMS), not to the page.
    const msg = sent.at(-1)!;
    expect(msg.to).toBe(phone);
    const code = /\d{6}/.exec(msg.msg.text)![0];
    const res = await app.request('/oauth/google/start', { ...form({ code }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session } });
    expect(res.status).toBe(302);
    const google = new URL(res.headers.get('location')!);
    expect(google.origin).toBe('https://accounts.google.com');
    return { user, cookies: [session, cookiesOf(res)].filter(Boolean).join('; '), state: google.searchParams.get('state')! };
  }

  it('needs the code from the account’s own chat, so a forwarded link is not enough', async () => {
    const app = createApp();
    const attacker = await makeUser({ phone: '+4915100000213' });
    const link = new URL(await connectGoogleLink(attacker));
    // The victim opens the forwarded link and clicks through…
    const signIn = await app.request(link.pathname, form({ next: '/oauth/google/connect' }));
    const html = await signIn.text();
    expect(html).not.toMatch(/\b\d{6}\b/); // the code is not on the page
    expect(sent.at(-1)!.to).toBe('+4915100000213'); // it went to the account holder's own phone
    // …but without that code nothing starts.
    const res = await app.request('/oauth/google/start', { ...form({ code: '000000' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookiesOf(signIn) } });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('completes for the browser that started it', async () => {
    const app = createApp();
    const { user, cookies, state } = await startFromChatLink(app, '+4915100000210');
    expect(cookies).toContain('ta_oauth=');
    const cb = await app.request(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=abc`, { headers: { Cookie: cookies } });
    expect(cb.status).toBe(200);
    expect((await integrations.get(user.id, 'google'))?.account).toBe('priya@gmail.com');
  });

  it('refuses a callback from another browser or another account', async () => {
    const app = createApp();
    const victim = await startFromChatLink(app, '+4915100000211');
    const attacker = await startFromChatLink(app, '+4915100000212');
    const url = `/oauth/google/callback?state=${encodeURIComponent(victim.state)}&code=abc`;
    // No session at all (the link was forwarded and opened elsewhere).
    expect((await app.request(url)).status).toBe(400);
    // Someone else's session.
    expect((await app.request(url, { headers: { Cookie: attacker.cookies } })).status).toBe(400);
    // The right session but not the browser that started this flow (nonce differs).
    const sessionOnly = victim.cookies.split('; ').filter((c) => c.startsWith('ta_session=')).join('; ');
    expect((await app.request(url, { headers: { Cookie: `${sessionOnly}; ta_oauth=forged` } })).status).toBe(400);
    expect(await integrations.get(victim.user.id, 'google')).toBeNull();
    expect(await integrations.get(attacker.user.id, 'google')).toBeNull();
  });

  it('can only be started with a session', async () => {
    const app = createApp();
    const res = await app.request('/oauth/google/start', form({}));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/login/);
  });
});

describe('billing and account deletion', () => {
  async function signedIn(app: ReturnType<typeof createApp>, phone: string) {
    const user = await makeUser({ phone });
    const path = new URL(await dashboardLink(user)).pathname;
    const res = await app.request(path, form({ next: '/app' }));
    return { user, cookie: cookiesOf(res) };
  }

  it('cancels the subscription before deleting the account', async () => {
    const app = createApp();
    const { user, cookie } = await signedIn(app, '+4915100000220');
    await users.update(user.id, { plan: 'pro', stripe_subscription_id: 'sub_1', subscription_status: 'active' });
    const del = { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'fetch' } };

    stripeOk = false;
    expect((await app.request('/api/account/delete', del)).status).toBe(502);
    expect(await users.get(user.id)).not.toBeNull();

    stripeOk = true;
    expect((await app.request('/api/account/delete', del)).status).toBe(200);
    expect(stripeCalls.at(-1)).toBe('DELETE https://api.stripe.com/v1/subscriptions/sub_1');
    expect(await users.get(user.id)).toBeNull();
  });

  it('acknowledges webhooks for accounts that no longer exist', async () => {
    const app = createApp();
    const body = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { status: 'canceled', metadata: { user_id: '00000000-0000-4000-8000-000000000000' } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_x').update(`${t}.${body}`).digest('hex');
    const res = await app.request('/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body });
    expect(res.status).toBe(200);
  });
});

describe('telegram webhook', () => {
  it('rejects updates without the secret, even when none was configured', async () => {
    testConfig({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_MODE: 'webhook' });
    try {
      const app = createApp();
      const update = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 9, type: 'private' }, text: 'hi' } });
      const res = await app.request('/webhooks/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: update });
      expect(res.status).toBe(401);
    } finally {
      testConfig();
    }
  });
});
