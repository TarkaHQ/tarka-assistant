import { config } from '../config.js';
import { auth } from '../db/repo.js';
import type { User } from '../db/types.js';
import { randomToken, sealState } from '../util/crypto.js';

/** Pages a sign-in link may lead to. Anything else (another site, odd paths) goes to /app. */
const NEXT_ALLOWED = /^\/(app(\/[a-z-]*)?|oauth\/google\/connect|billing\/start)$/;

/** A same-site path to continue to after sign-in, or the fallback. */
export function safeNext(next: unknown, fallback = '/app'): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  try {
    const base = new URL(config().publicUrl);
    const u = new URL(next, base);
    if (u.origin !== base.origin || !NEXT_ALLOWED.test(u.pathname)) return fallback;
    return `${u.pathname}${u.search}`;
  } catch {
    return fallback;
  }
}

/** One-time sign-in link to the dashboard, safe to send over the user's own channel. */
export async function dashboardLink(user: User, ttlMinutes = 30, next?: string): Promise<string> {
  const token = randomToken(24);
  await auth.createLoginToken(token, user.email ?? `${user.id}@users.invalid`, user.id, ttlMinutes);
  const target = next ? safeNext(next) : null;
  return `${config().publicUrl}/auth/${token}${target && target !== '/app' ? `?next=${encodeURIComponent(target)}` : ''}`;
}

/**
 * Link for connecting Google from a chat: a one-time sign-in that continues straight into the
 * OAuth flow. The flow itself is tied to that browser session (see /oauth/google/*), so a
 * forwarded link can't attach someone else's Google account to this user.
 */
export async function connectGoogleLink(user: User): Promise<string> {
  return dashboardLink(user, 30, '/oauth/google/connect');
}

/** Starts Stripe Checkout for the $20 plan. */
export function upgradeLink(user: User): string {
  return `${config().publicUrl}/billing/checkout?s=${encodeURIComponent(sealState({ uid: user.id, p: 'checkout' }, 86400))}`;
}
