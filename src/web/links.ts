import { config } from '../config.js';
import { auth } from '../db/repo.js';
import type { User } from '../db/types.js';
import { randomToken, sealState } from '../util/crypto.js';

/** One-time sign-in link to the dashboard, safe to send over the user's own channel. */
export async function dashboardLink(user: User, ttlMinutes = 30): Promise<string> {
  const token = randomToken(24);
  await auth.createLoginToken(token, user.email ?? `${user.id}@users.invalid`, user.id, ttlMinutes);
  return `${config().publicUrl}/auth/${token}`;
}

/** Starts the Google OAuth flow for this user. */
export function connectGoogleLink(user: User): string {
  return `${config().publicUrl}/oauth/google/start?s=${encodeURIComponent(sealState({ uid: user.id, p: 'google' }, 3600))}`;
}

/** Starts Stripe Checkout for the $20 plan. */
export function upgradeLink(user: User): string {
  return `${config().publicUrl}/billing/checkout?s=${encodeURIComponent(sealState({ uid: user.id, p: 'checkout' }, 86400))}`;
}
