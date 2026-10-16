import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.js';
import { auth, identities, users } from '../db/repo.js';
import type { User } from '../db/types.js';
import { randomToken } from '../util/crypto.js';

export const SESSION_COOKIE = 'ta_session';

export type AppEnv = { Variables: { user: User } };

export async function startSession(c: Context, user: User): Promise<void> {
  const token = randomToken(32);
  await auth.createSession(token, user.id, 30);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config().isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 86400,
  });
  // Every signed-in user can chat on the web.
  await identities.create(user.id, 'web', user.id, null, true);
}

export async function endSession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await auth.deleteSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function currentUser(c: Context): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return auth.sessionUser(token);
}

/** Pages: redirect to /login. */
export const requirePage: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  c.set('user', user);
  await next();
};

/**
 * JSON APIs: session + a custom header. Browsers won't send custom headers cross-site without a
 * CORS preflight (which we never grant), so this doubles as CSRF protection.
 */
export const requireApi: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.header('x-requested-with') !== 'fetch') return c.json({ error: 'bad request' }, 400);
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'not signed in' }, 401);
  c.set('user', user);
  await next();
};

export async function refreshUser(c: Context<AppEnv>): Promise<User> {
  const fresh = await users.get(c.get('user').id);
  if (fresh) c.set('user', fresh);
  return c.get('user');
}

/** Tiny in-memory rate limiter for login and other abuse-prone endpoints. */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > limit;
}
