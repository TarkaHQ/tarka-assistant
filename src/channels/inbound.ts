import { config } from '../config.js';
import { auth, audit, identities, IdentityTaken, invites, kv, messages, users } from '../db/repo.js';
import type { ChannelName, Identity, User } from '../db/types.js';
import { log } from '../log.js';
import { memory } from '../memory/hindsight.js';
import { ocr, speak, transcribe } from '../models/tarka.js';
import { approvalButtons, clarifyMessage, decideApproval, decideApprovals, matchApprovalReply, withApprovalNotice } from '../agent/approvals.js';
import { runTurn, type TurnResult } from '../agent/turn.js';
import { dashboardLink, upgradeLink } from '../web/links.js';
import { sendToUser } from './deliver.js';
import { adapterFor } from './registry.js';
import { whatsappAllowed } from './telnyx.js';
import type { InboundMessage } from './types.js';

/** Carrier opt-out keywords. They apply to SMS and WhatsApp only (elsewhere "stop" is just a word). */
const STOP_WORDS = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i;
const START_WORDS = /^(start|unstop|subscribe)$/i;
const OPT_OUT_CHANNELS: ChannelName[] = ['sms', 'whatsapp'];

const COUNTRY_TZ: Record<string, string> = {
  DE: 'Europe/Berlin', GB: 'Europe/London', FR: 'Europe/Paris', IT: 'Europe/Rome', ES: 'Europe/Madrid', NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels', AT: 'Europe/Vienna', CH: 'Europe/Zurich', DK: 'Europe/Copenhagen', SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo', PL: 'Europe/Warsaw', IE: 'Europe/Dublin', FI: 'Europe/Helsinki', IN: 'Asia/Kolkata', NP: 'Asia/Kathmandu',
  SG: 'Asia/Singapore', AE: 'Asia/Dubai', NZ: 'Pacific/Auckland',
};

export interface InboundResult {
  userId?: string;
  reply?: string;
  turn?: TurnResult;
}

/** Sends a system reply to someone who may not have an account yet (no user row). */
async function replyToIdentity(msg: InboundMessage, text: string): Promise<void> {
  const adapter = adapterFor(msg.channel);
  if (!adapter || msg.channel === 'web') return;
  const fake: Identity = {
    id: 'anon', user_id: 'anon', channel: msg.channel, external_id: msg.externalId, display: null,
    verified_at: null, last_inbound_at: new Date(), opted_out_at: null, created_at: new Date(),
  };
  await adapter.send(fake, { text }).catch((err) => log.warn({ err: String(err) }, 'reply to unknown sender failed'));
}

/** Rate-limits replies to strangers so a number can't be used to make us spam someone. */
async function onceEvery(key: string, hours: number): Promise<boolean> {
  const last = await kv.get<number>(key);
  if (last && Date.now() - last < hours * 3600_000) return false;
  await kv.set(key, Date.now());
  return true;
}

async function createUserFrom(msg: InboundMessage): Promise<User> {
  const cfg = config();
  const isPhone = msg.channel === 'sms' || msg.channel === 'whatsapp';
  if (isPhone) {
    const existing = await users.byPhone(msg.externalId);
    if (existing) {
      await identities.create(existing.id, msg.channel, msg.externalId, msg.displayName, true);
      return existing;
    }
  }
  const user = await users.create({
    name: null,
    phone: isPhone ? msg.externalId : null,
    timezone: (msg.country && COUNTRY_TZ[msg.country]) || 'UTC',
    plan: 'trial',
    trialDays: cfg.product.trialDays,
    status: 'onboarding',
  });
  await identities.create(user.id, msg.channel, msg.externalId, msg.displayName, true);
  await audit.add(user.id, 'system', 'user.created', { channel: msg.channel });
  memory.ensureBank(user).catch((err) => log.warn({ err: String(err) }, 'memory bank creation failed'));
  return user;
}

function planAllows(user: User): boolean {
  if (!config().stripe.enabled) return true;
  if (user.plan !== 'trial') return true;
  return !user.trial_ends_at || user.trial_ends_at.getTime() > Date.now();
}

async function enrichWithMedia(msg: InboundMessage): Promise<{ text: string; hadVoice: boolean }> {
  const adapter = adapterFor(msg.channel);
  const parts: string[] = [];
  let hadVoice = false;
  for (const m of msg.media ?? []) {
    try {
      const bytes = m.data ?? (m.url && adapter?.download ? await adapter.download({ url: m.url }) : undefined);
      if (!bytes) continue;
      if (m.kind === 'audio') {
        hadVoice = true;
        const transcript = await transcribe(bytes, m.filename ?? 'audio.ogg', m.mediaType);
        parts.push(transcript ? `[Voice message, transcribed]\n${transcript}` : '[Voice message — I could not make out any words]');
      } else if (m.kind === 'image') {
        const text = await ocr(bytes, m.mediaType);
        parts.push(text ? `[Photo — text found in it]\n${text.slice(0, 6000)}` : '[Photo — no readable text in it]');
      } else {
        parts.push(`[File "${m.filename ?? 'attachment'}" (${m.mediaType}) — this type can't be read yet]`);
      }
    } catch (err) {
      log.warn({ err: String(err), kind: m.kind }, 'media processing failed');
      parts.push(`[${m.kind === 'audio' ? 'Voice message' : 'Attachment'} received, but I couldn't process it]`);
    }
  }
  const text = [msg.text.trim(), ...parts].filter(Boolean).join('\n\n');
  return { text, hadVoice };
}

/**
 * Handles one inbound message end to end: identity, sign-up, approvals, media, the agent turn and
 * the reply. Never throws (a failed job would block this conversation's queue).
 */
export async function handleInbound(msg: InboundMessage, opts: { onStatus?: (label: string) => void } = {}): Promise<InboundResult> {
  const cfg = config();
  try {
    let identity = await identities.find(msg.channel, msg.externalId);

    // Telegram deep link /start CODE, or "LINK CODE" on any channel: attach this address to an account.
    const linkCode = msg.command?.name === 'start' ? msg.command.arg : /^link\s+([a-z0-9]{6})$/i.exec(msg.text.trim())?.[1];
    if (linkCode) {
      const userId = await auth.consumeLinkCode(linkCode);
      if (userId) {
        try {
          identity = await identities.create(userId, msg.channel, msg.externalId, msg.displayName, true);
        } catch (err) {
          // Already someone else's address: never move it (that would hand over their conversation).
          if (!(err instanceof IdentityTaken)) throw err;
          await replyToIdentity(
            msg,
            `This ${channelLabel(msg.channel)} account is already connected to another ${cfg.product.productName} account. Remove it there first (Settings), then make a new link.`,
          );
          return { userId: identity?.user_id };
        }
        const user = (await users.get(userId))!;
        const name = user.assistant_name || cfg.product.assistantName;
        const reply = `You're connected${user.name ? `, ${user.name}` : ''}! This is ${name}. Message me here any time.`;
        await sendToUser(user, reply, { channel: msg.channel, persist: { role: 'assistant' } });
        await audit.add(userId, 'user', 'channel.linked', { channel: msg.channel });
        return { userId, reply };
      }
      if (!identity && msg.command?.name === 'start') {
        await replyToIdentity(msg, 'That link has expired. Open your dashboard and create a new one.');
        return {};
      }
    }

    // Opt-out handling (SMS/WhatsApp compliance; Telnyx also auto-responds to STOP).
    if (OPT_OUT_CHANNELS.includes(msg.channel) && STOP_WORDS.test(msg.text.trim())) {
      await identities.optOut(msg.channel, msg.externalId);
      if (identity) await audit.add(identity.user_id, 'user', 'channel.opted_out', { channel: msg.channel });
      // SMS opt-outs are confirmed by the carrier/Telnyx; WhatsApp gets one confirmation from us.
      if (identity && msg.channel === 'whatsapp') await replyToIdentity(msg, "You won't get messages here any more. Send START to turn them back on.");
      return { userId: identity?.user_id };
    }

    if (!identity) {
      if (msg.channel === 'whatsapp' && !whatsappAllowed(msg.externalId)) {
        if (await onceEvery(`deny:wa:${msg.externalId}`, 24)) {
          await replyToIdentity(msg, `Sorry, WhatsApp isn't available where you are yet. You can reach ${cfg.product.assistantName} on Telegram or at ${cfg.publicUrl}.`);
        }
        return {};
      }
      if (cfg.product.signupMode === 'closed') {
        if (await onceEvery(`deny:closed:${msg.channel}:${msg.externalId}`, 24)) await replyToIdentity(msg, `${cfg.product.productName} isn't accepting new sign-ups right now.`);
        return {};
      }
      if (cfg.product.signupMode === 'invite') {
        const code = msg.text.trim();
        if (!code || !/^[a-z0-9-]{4,24}$/i.test(code) || !(await invites.consume(code))) {
          if (await onceEvery(`invite:${msg.channel}:${msg.externalId}`, 12)) {
            await replyToIdentity(msg, `Hi! ${cfg.product.productName} is invite-only for now. Reply with your invite code to get started.`);
          }
          return {};
        }
        const user = await createUserFrom(msg);
        identity = (await identities.find(msg.channel, msg.externalId))!;
        msg = { ...msg, text: 'Hi! (I just joined with an invite code.)' };
        void user;
      } else {
        await createUserFrom(msg);
        identity = (await identities.find(msg.channel, msg.externalId))!;
        if (msg.command?.name === 'start' && !msg.text) msg = { ...msg, text: 'Hi!' };
      }
    }

    if (identity.opted_out_at && !START_WORDS.test(msg.text.trim())) return { userId: identity.user_id };
    await identities.markInbound(identity.id);
    let user = (await users.get(identity.user_id))!;
    if (user.status === 'deleted' || user.status === 'paused') return { userId: user.id };

    // Approval buttons and yes/no replies are decided deterministically, never by the model.
    if (msg.command?.name === 'approval' && msg.command.arg) {
      const [id, d] = msg.command.arg.split(':');
      const outcome = await decideApproval(user, id!, d === 'y' ? 'approved' : 'rejected', msg.channel);
      await sendToUser(user, outcome.message, { channel: msg.channel, persist: { role: 'assistant', meta: { source: 'approval' } } });
      return { userId: user.id, reply: outcome.message };
    }
    const match = await matchApprovalReply(user, msg.text);
    if (match?.kind === 'decision') {
      await messages.add(user.id, 'user', msg.channel, msg.text);
      const outcome = await decideApprovals(user, match.approvals, match.decision, msg.channel);
      await sendToUser(user, outcome.message, { channel: msg.channel, persist: { role: 'assistant', meta: { source: 'approval' } } });
      return { userId: user.id, reply: outcome.message };
    }
    if (match?.kind === 'clarify') {
      await messages.add(user.id, 'user', msg.channel, msg.text);
      const reply = clarifyMessage(match.pending, match.decision);
      await sendToUser(user, reply, { channel: msg.channel, persist: { role: 'assistant', meta: { source: 'approval', approvals: match.pending.map((a) => a.id) } } });
      return { userId: user.id, reply };
    }

    if (msg.command?.name === 'start' && msg.text === '' && user.status === 'active') {
      msg = { ...msg, text: 'Hi!' };
    }

    if (!planAllows(user)) {
      const reply = `Your free trial has ended. Keep me going for ${cfg.product.priceLabel}: ${upgradeLink(user)}`;
      if (await onceEvery(`trial-ended:${user.id}`, 6)) await sendToUser(user, reply, { channel: msg.channel, persist: { role: 'assistant' } });
      return { userId: user.id, reply };
    }

    if (/^\/?(dashboard|login)$/i.test(msg.text.trim())) {
      const reply = `Here's your dashboard (link works once, for 30 minutes):\n${await dashboardLink(user)}`;
      await sendToUser(user, reply, { channel: msg.channel, persist: { role: 'assistant' } });
      return { userId: user.id, reply };
    }

    const { text, hadVoice } = await enrichWithMedia(msg);
    if (!text) return { userId: user.id };

    const turn = await runTurn({
      user,
      channel: msg.channel,
      text,
      trigger: 'message',
      persistUserMessage: true,
      userMeta: { providerMessageId: msg.providerMessageId, media: (msg.media ?? []).map((m) => m.kind) },
      onStatus: opts.onStatus,
      progress: async (p) => {
        await sendToUser(user, p, { channel: msg.channel });
      },
    });
    user = (await users.get(user.id)) ?? user;

    let audio: Uint8Array | undefined;
    if (hadVoice && user.settings.voiceReplies && msg.channel === 'telegram') {
      audio = await speak(turn.text.slice(0, 1500)).catch(() => undefined);
    }
    // What the user approves is the code-written summary under the reply, not the model's wording.
    const outgoing = withApprovalNotice(turn.text, turn.approvals, msg.channel);
    await sendToUser(user, outgoing, { channel: msg.channel, buttons: approvalButtons(turn.approvals), audio });
    return { userId: user.id, reply: outgoing, turn };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.stack : String(err), channel: msg.channel }, 'inbound handling failed');
    const identity = await identities.find(msg.channel, msg.externalId).catch(() => null);
    const sorry = 'Sorry — something went wrong on my side. Please try again in a minute.';
    if (identity) {
      const user = await users.get(identity.user_id).catch(() => null);
      if (user) await sendToUser(user, sorry, { channel: msg.channel }).catch(() => {});
    }
    return { userId: identity?.user_id, reply: sorry };
  }
}

export function inboundKey(msg: Pick<InboundMessage, 'channel' | 'externalId'>): string {
  return `${msg.channel}:${msg.externalId}`;
}

function channelLabel(channel: ChannelName): string {
  return channel === 'sms' ? 'phone number' : channel === 'whatsapp' ? 'WhatsApp' : channel === 'telegram' ? 'Telegram' : channel;
}

export type { ChannelName };
