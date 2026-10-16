import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { audit, users } from '../db/repo.js';
import type { User } from '../db/types.js';
import { log } from '../log.js';

/** Minimal Stripe over REST: Checkout for the monthly plan, and the webhook that flips the plan. */

async function stripe<T>(path: string, form: Record<string, string>, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
  const key = config().stripe.secretKey;
  if (!key) throw new Error('Stripe is not configured');
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe: ${body.error?.message ?? res.status}`);
  return body;
}

export async function checkoutUrl(user: User): Promise<string> {
  const cfg = config();
  const form: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': cfg.stripe.priceId!,
    'line_items[0][quantity]': '1',
    success_url: `${cfg.publicUrl}/app/settings?billing=success`,
    cancel_url: `${cfg.publicUrl}/app/settings?billing=cancelled`,
    client_reference_id: user.id,
    'metadata[user_id]': user.id,
    'subscription_data[metadata][user_id]': user.id,
    allow_promotion_codes: 'true',
  };
  if (user.stripe_customer_id) form.customer = user.stripe_customer_id;
  else if (user.email) form.customer_email = user.email;
  const session = await stripe<{ url: string }>('/checkout/sessions', form);
  return session.url;
}

/** Ends the subscription now (account deletion). A subscription already gone is fine. */
export async function cancelSubscription(user: User): Promise<void> {
  if (!user.stripe_subscription_id || !config().stripe.secretKey) return;
  try {
    await stripe(`/subscriptions/${encodeURIComponent(user.stripe_subscription_id)}`, {}, 'DELETE');
  } catch (err) {
    const msg = String(err);
    if (!/No such subscription|canceled/i.test(msg)) throw err;
  }
}

export async function portalUrl(user: User): Promise<string | null> {
  if (!user.stripe_customer_id) return null;
  const s = await stripe<{ url: string }>('/billing_portal/sessions', { customer: user.stripe_customer_id, return_url: `${config().publicUrl}/app/settings` });
  return s.url;
}

/** Verifies the Stripe-Signature header (v1 scheme, 5-minute tolerance). */
export function verifyStripeSignature(raw: string, header: string | undefined): boolean {
  const secret = config().stripe.webhookSecret;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const sig = Buffer.from(p.slice(3));
      const exp = Buffer.from(expected);
      return sig.length === exp.length && timingSafeEqual(sig, exp);
    });
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

export async function handleStripeEvent(event: StripeEvent): Promise<void> {
  const o = event.data.object;
  const meta = (o.metadata ?? {}) as Record<string, string>;
  const userId = (o.client_reference_id as string | undefined) ?? meta.user_id;
  // Events for accounts that no longer exist (deleted, or another environment) are acknowledged
  // and ignored, so Stripe doesn't retry them for days.
  if (userId && !(/^[0-9a-f-]{36}$/i.test(userId) && (await users.get(userId)))) {
    log.info({ type: event.type }, 'stripe event for an unknown user ignored');
    return;
  }
  switch (event.type) {
    case 'checkout.session.completed': {
      if (!userId) return;
      await users.update(userId, {
        plan: 'pro',
        stripe_customer_id: (o.customer as string | null) ?? null,
        stripe_subscription_id: (o.subscription as string | null) ?? null,
        subscription_status: 'active',
      });
      await audit.add(userId, 'system', 'billing.subscribed', {});
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (!userId) return;
      const status = String(o.status ?? 'canceled');
      const active = event.type === 'customer.subscription.updated' && ['active', 'trialing', 'past_due'].includes(status);
      await users.update(userId, { subscription_status: status, plan: active ? 'pro' : 'trial', trial_ends_at: active ? undefined : new Date() });
      await audit.add(userId, 'system', `billing.${status}`, {});
      break;
    }
    default:
      log.debug({ type: event.type }, 'stripe event ignored');
  }
}
