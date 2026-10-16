import { randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { identities, kv } from '../db/repo.js';
import type { ChannelName, User } from '../db/types.js';
import { sendToUser } from '../channels/deliver.js';
import { sendEmail } from '../integrations/email.js';
import { proactiveChannel } from '../proactive/scheduler.js';
import { keyedHash, randomToken } from '../util/crypto.js';

/**
 * Proof that the person in this browser is the account holder, for actions where a forwarded
 * sign-in link would otherwise be enough (connecting Google). A 6-digit code goes to the account's
 * own chat, phone or email, never into the conversation the model reads, and must be typed into
 * the same browser within 10 minutes (5 tries).
 */

const TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;
const MAX_SENDS_PER_HOUR = 5;

interface Pending {
  hash: string;
  exp: number;
  nonce: string;
}

export interface CodeSent {
  /** Where the code went, in words the person recognises ("your Telegram chat"). */
  where: string;
  /** Development only (DEV_LOGIN, no channel or email): the code itself, shown on the page. */
  devCode?: string;
}

const key = (purpose: string, userId: string) => `confirm:${purpose}:${userId}`;

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name!.slice(0, 1)}•••@${domain}`;
}

async function whereLabel(user: User, channel: ChannelName): Promise<string> {
  const id = (await identities.forUser(user.id)).find((i) => i.channel === channel);
  const tail = id ? id.external_id.slice(-4) : '';
  if (channel === 'telegram') return 'your Telegram chat';
  if (channel === 'whatsapp') return `your WhatsApp (…${tail})`;
  if (channel === 'sms') return `your phone (…${tail})`;
  return 'your chat';
}

export async function sendConfirmCode(user: User, purpose: string, action: string): Promise<CodeSent | { error: string }> {
  const cfg = config();
  const hour = new Date().toISOString().slice(0, 13);
  if ((await kv.incr(`confirm-sends:${user.id}:${hour}`)) > MAX_SENDS_PER_HOUR) {
    return { error: 'Too many codes in the last hour. Try again later.' };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const pending: Pending = { hash: keyedHash('confirm', `${purpose}:${user.id}:${code}`), exp: Date.now() + TTL_MS, nonce: randomToken(9) };
  await kv.set(key(purpose, user.id), pending);
  const text = `${code} is your code to ${action}. Type it in the browser where you asked for it. Never share it with anyone.`;

  const channel = await proactiveChannel(user);
  if (channel !== 'web') {
    // Not persisted: the code never enters the conversation (or the model's context).
    const sent = await sendToUser(user, text, { channel });
    if (sent.channel) return { where: await whereLabel(user, sent.channel) };
  }
  if (user.email && (await sendEmail(user.email, `Your ${cfg.product.productName} code`, text))) return { where: `your email (${maskEmail(user.email)})` };
  if (cfg.product.devLogin) return { where: 'this page (development mode)', devCode: code };
  return { error: 'There’s no chat, phone or email on this account to send a code to. Connect one first.' };
}

export async function checkConfirmCode(user: User, purpose: string, code: string): Promise<'ok' | 'wrong' | 'expired'> {
  const pending = await kv.get<Pending>(key(purpose, user.id));
  if (!pending || pending.exp < Date.now()) return 'expired';
  // Count the try before comparing (atomic), so parallel guesses can't exceed the limit.
  const tries = await kv.incr(`confirm-tries:${user.id}:${pending.nonce}`);
  if (tries > MAX_TRIES) return 'expired';
  const given = Buffer.from(keyedHash('confirm', `${purpose}:${user.id}:${code.replace(/\D/g, '')}`));
  const expected = Buffer.from(pending.hash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'wrong';
  await kv.set(key(purpose, user.id), { ...pending, exp: 0 });
  return 'ok';
}
