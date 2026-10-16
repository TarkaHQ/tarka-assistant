import { createPublicKey, verify } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';

const API = 'https://api.telnyx.com/v2';

async function telnyx<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = config().telnyx.apiKey;
  if (!key) throw new Error('Telnyx is not configured');
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    log.warn({ status: res.status, path, body: text.slice(0, 300) }, 'telnyx api error');
    throw new Error(`Telnyx ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function sendSms(to: string, text: string, mediaUrls?: string[]): Promise<string | undefined> {
  const cfg = config().telnyx;
  const body: Record<string, unknown> = { from: cfg.phoneNumber, to, text };
  if (cfg.messagingProfileId) body.messaging_profile_id = cfg.messagingProfileId;
  if (mediaUrls?.length) body.media_urls = mediaUrls;
  const res = await telnyx<{ data?: { id?: string } }>('/messages', { method: 'POST', body: JSON.stringify(body) });
  return res.data?.id;
}

export async function sendWhatsAppText(to: string, text: string): Promise<string | undefined> {
  const cfg = config().telnyx;
  const res = await telnyx<{ data?: { id?: string } }>('/messages/whatsapp', {
    method: 'POST',
    body: JSON.stringify({ from: cfg.whatsappNumber, to, whatsapp_message: { type: 'text', text: { body: text, preview_url: true } } }),
  });
  return res.data?.id;
}

/** Template message for re-engaging outside WhatsApp's 24-hour customer-service window. */
export async function sendWhatsAppTemplate(to: string, template: string, params: string[], language = 'en_US'): Promise<string | undefined> {
  const cfg = config().telnyx;
  const res = await telnyx<{ data?: { id?: string } }>('/messages/whatsapp', {
    method: 'POST',
    body: JSON.stringify({
      from: cfg.whatsappNumber,
      to,
      whatsapp_message: {
        type: 'template',
        template: {
          name: template,
          language: { policy: 'deterministic', code: language },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p.slice(0, 1000) })) }],
        },
      },
    }),
  });
  return res.data?.id;
}

/**
 * Telnyx signs webhooks with Ed25519 over `${timestamp}|${rawBody}`. The public key from the
 * portal is the raw 32-byte key, base64-encoded.
 */
export function verifyTelnyxSignature(rawBody: string, signatureB64: string | undefined, timestamp: string | undefined, toleranceSeconds = 300): boolean {
  const pub = config().telnyx.publicKey;
  if (!pub) return !config().isProd; // unsigned webhooks accepted only in development
  if (!signatureB64 || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  try {
    const raw = Buffer.from(pub, 'base64');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export async function downloadMedia(url: string): Promise<Uint8Array> {
  // Inbound MMS media URLs are pre-signed; WhatsApp media may need the API key.
  const key = config().telnyx.apiKey;
  let res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if ((res.status === 401 || res.status === 403) && key) res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Media download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface ScheduledCall {
  scheduled_event_id?: string;
  conversation_id?: string;
  status?: string;
  errors?: string[];
}

/** Has a Telnyx AI Assistant place a phone call (used for concierge calls to businesses). */
export async function scheduleAssistantCall(opts: { assistantId: string; to: string; at: Date; metadata: Record<string, string> }): Promise<ScheduledCall> {
  const cfg = config().telnyx;
  const res = await telnyx<ScheduledCall | { data?: ScheduledCall }>(`/ai/assistants/${encodeURIComponent(opts.assistantId)}/scheduled_events`, {
    method: 'POST',
    body: JSON.stringify({
      telnyx_conversation_channel: 'phone_call',
      telnyx_agent_target: cfg.phoneNumber,
      telnyx_end_user_target: opts.to,
      scheduled_at_fixed_datetime: opts.at.toISOString(),
      conversation_metadata: opts.metadata,
    }),
  });
  return ('data' in res && res.data ? res.data : res) as ScheduledCall;
}

export async function getScheduledEvent(assistantId: string, eventId: string): Promise<ScheduledCall> {
  const res = await telnyx<ScheduledCall | { data?: ScheduledCall }>(`/ai/assistants/${encodeURIComponent(assistantId)}/scheduled_events/${encodeURIComponent(eventId)}`);
  return ('data' in res && res.data ? res.data : res) as ScheduledCall;
}

/** E.164 sanity check plus a rough country lookup for the prefixes we gate on. */
export function isE164(n: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(n);
}

const PREFIXES: [string, string][] = [
  ['+1', 'US'], ['+44', 'GB'], ['+49', 'DE'], ['+33', 'FR'], ['+39', 'IT'], ['+34', 'ES'], ['+31', 'NL'], ['+32', 'BE'],
  ['+43', 'AT'], ['+41', 'CH'], ['+45', 'DK'], ['+46', 'SE'], ['+47', 'NO'], ['+48', 'PL'], ['+351', 'PT'], ['+353', 'IE'],
  ['+358', 'FI'], ['+30', 'GR'], ['+420', 'CZ'], ['+421', 'SK'], ['+36', 'HU'], ['+40', 'RO'], ['+359', 'BG'], ['+385', 'HR'],
  ['+386', 'SI'], ['+372', 'EE'], ['+371', 'LV'], ['+370', 'LT'], ['+352', 'LU'], ['+356', 'MT'], ['+357', 'CY'], ['+354', 'IS'],
  ['+423', 'LI'], ['+91', 'IN'], ['+977', 'NP'], ['+61', 'AU'], ['+64', 'NZ'], ['+65', 'SG'], ['+971', 'AE'],
];

export function countryOf(e164: string): string | undefined {
  const match = PREFIXES.filter(([p]) => e164.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  return match?.[1];
}
