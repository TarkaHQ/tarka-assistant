import { identities, messages } from '../db/repo.js';
import type { ChannelName, Identity, User } from '../db/types.js';
import { log } from '../log.js';
import { adapterFor } from './registry.js';
import type { OutboundButton } from './types.js';

export interface SendOptions {
  /** Reply on this channel (e.g. where the user just wrote). Otherwise the best available. */
  channel?: ChannelName;
  buttons?: OutboundButton[];
  audio?: Uint8Array;
  proactive?: boolean;
  /** Also store the text in the conversation (for messages not written by runTurn). */
  persist?: { role: 'assistant' | 'event'; meta?: Record<string, unknown> };
}

const PUSH_ORDER: ChannelName[] = ['telegram', 'whatsapp', 'sms'];

function candidates(user: User, ids: Identity[], requested?: ChannelName): Identity[] {
  const usable = ids.filter((i) => !i.opted_out_at && adapterFor(i.channel)?.enabled());
  const order: ChannelName[] = [];
  if (requested) order.push(requested);
  if (user.settings.preferredChannel) order.push(user.settings.preferredChannel);
  if (user.last_channel) order.push(user.last_channel);
  order.push(...PUSH_ORDER);
  const seen = new Set<string>();
  const out: Identity[] = [];
  for (const ch of order) {
    for (const i of usable.filter((x) => x.channel === ch)) {
      if (!seen.has(i.id)) {
        seen.add(i.id);
        out.push(i);
      }
    }
  }
  return out;
}

/**
 * Delivers a message to the user. Web-only users (or a web reply) need no push: the dashboard
 * reads the conversation. Falls back across the user's channels if one fails.
 */
export async function sendToUser(user: User, text: string, opts: SendOptions = {}): Promise<{ channel: ChannelName | null }> {
  if (opts.persist) {
    await messages.add(user.id, opts.persist.role, opts.channel ?? user.last_channel ?? 'web', text, { ...(opts.persist.meta ?? {}), proactive: Boolean(opts.proactive) });
  }
  if (opts.channel === 'web' || opts.channel === 'cli') return { channel: opts.channel };
  const ids = await identities.forUser(user.id);
  for (const identity of candidates(user, ids, opts.channel)) {
    if (identity.channel === 'web') continue;
    const adapter = adapterFor(identity.channel)!;
    try {
      await adapter.send(identity, { text, buttons: opts.buttons, audio: opts.audio, proactive: opts.proactive });
      return { channel: identity.channel };
    } catch (err) {
      log.warn({ err: String(err), channel: identity.channel, user: user.id }, 'delivery failed; trying next channel');
    }
  }
  return { channel: null };
}
