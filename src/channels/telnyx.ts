import { config } from '../config.js';
import type { Identity } from '../db/types.js';
import { countryOf, downloadMedia, sendSms, sendWhatsAppTemplate, sendWhatsAppText } from '../integrations/telnyx.js';
import { formatFor, splitMessage } from './format.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';

/** SMS/MMS through Telnyx. US numbers need 10DLC or toll-free verification before traffic flows. */
export const smsAdapter: ChannelAdapter = {
  name: 'sms',
  maxLength: 1500,
  enabled: () => Boolean(config().telnyx.apiKey && config().telnyx.phoneNumber),
  async send(identity: Identity, msg: OutboundMessage) {
    let text = formatFor('sms', msg.text);
    if (msg.buttons?.length && !/\b(yes|no)\b/i.test(text)) text += '\n\nReply YES to go ahead or NO to cancel.';
    let id: string | undefined;
    for (const part of splitMessage(text, 1500)) id = await sendSms(identity.external_id, part);
    return { providerMessageId: id };
  },
  download: (m) => downloadMedia(m.url),
};

const WINDOW_MS = 24 * 3600_000;

/**
 * WhatsApp through Telnyx. Meta bars general-purpose AI assistants from the Business API outside
 * the EEA (since 15 Jan 2026; restored in the EEA by the EU's June 2026 interim measures), so
 * sign-ups are limited to WHATSAPP_ALLOWED_COUNTRIES. Free-form replies only inside the 24-hour
 * window; outside it a pre-approved template is required.
 */
export const whatsappAdapter: ChannelAdapter = {
  name: 'whatsapp',
  maxLength: 3500,
  enabled: () => Boolean(config().telnyx.apiKey && config().telnyx.whatsappNumber),
  async send(identity: Identity, msg: OutboundMessage) {
    let text = formatFor('whatsapp', msg.text);
    if (msg.buttons?.length && !/\b(yes|no)\b/i.test(text)) text += '\n\nReply *YES* to go ahead or *NO* to cancel.';
    const open = identity.last_inbound_at && Date.now() - identity.last_inbound_at.getTime() < WINDOW_MS;
    if (!open) {
      const template = config().telnyx.whatsappTemplate;
      if (!template) throw new WhatsAppWindowClosed();
      const id = await sendWhatsAppTemplate(identity.external_id, template, [text.slice(0, 900)]);
      return { providerMessageId: id };
    }
    let id: string | undefined;
    for (const part of splitMessage(text, 3500)) id = await sendWhatsAppText(identity.external_id, part);
    return { providerMessageId: id };
  },
  download: (m) => downloadMedia(m.url),
};

export class WhatsAppWindowClosed extends Error {
  constructor() {
    super('WhatsApp 24-hour window is closed and no template is configured');
  }
}

export function whatsappAllowed(e164: string): boolean {
  const c = countryOf(e164);
  return Boolean(c && config().telnyx.whatsappAllowedCountries.includes(c));
}

interface TelnyxMessagePayload {
  id?: string;
  type?: string; // SMS | MMS | whatsapp
  direction?: string;
  from?: { phone_number?: string } | string;
  to?: { phone_number?: string }[] | string;
  text?: string;
  media?: { url: string; content_type?: string }[];
  received_at?: string;
}

/** Normalises a Telnyx `message.received` webhook into an InboundMessage. */
export function parseTelnyxMessage(event: { data?: { event_type?: string; payload?: TelnyxMessagePayload } }): InboundMessage | null {
  const d = event.data;
  if (d?.event_type !== 'message.received' || !d.payload) return null;
  const p = d.payload;
  const from = typeof p.from === 'string' ? p.from : p.from?.phone_number;
  if (!from) return null;
  const channel = (p.type ?? '').toLowerCase() === 'whatsapp' ? 'whatsapp' : 'sms';
  const media = (p.media ?? []).map((m) => {
    const ct = m.content_type ?? 'application/octet-stream';
    const kind = ct.startsWith('image/') ? ('image' as const) : ct.startsWith('audio/') ? ('audio' as const) : ('file' as const);
    return { kind, mediaType: ct, url: m.url };
  });
  return {
    channel,
    externalId: from,
    text: p.text ?? '',
    media,
    providerMessageId: p.id,
    receivedAt: p.received_at ?? new Date().toISOString(),
    country: countryOf(from),
  };
}
