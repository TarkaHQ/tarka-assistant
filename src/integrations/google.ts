import { config } from '../config.js';
import { integrations } from '../db/repo.js';
import type { Integration } from '../db/types.js';
import { decrypt, encrypt } from '../util/crypto.js';
import { log } from '../log.js';

/**
 * Google Workspace over plain REST (Calendar, Gmail, Drive, People). Tokens are stored encrypted
 * per user and refreshed on demand.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];

export function redirectUri(): string {
  return `${config().publicUrl}/oauth/google/callback`;
}

export function authUrl(state: string): string {
  const cfg = config();
  const p = new URLSearchParams({
    client_id: cfg.google.clientId!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
  id_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const cfg = config();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.google.clientId!, client_secret: cfg.google.clientSecret!, ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as TokenResponse;
}

/** Completes the OAuth flow and stores the tokens for the user. */
export async function completeOAuth(userId: string, code: string): Promise<Integration> {
  const t = await tokenRequest({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  let account: string | null = null;
  try {
    const me = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (me.ok) account = ((await me.json()) as { email?: string }).email ?? null;
  } catch {
    /* optional */
  }
  return integrations.upsert(userId, 'google', {
    account,
    scopes: (t.scope ?? '').split(' ').filter(Boolean),
    accessTokenEnc: encrypt(t.access_token),
    refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : null,
    expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000),
  });
}

export class GoogleNotConnected extends Error {
  constructor() {
    super('Google is not connected. Offer the user a link with connect_google_link.');
  }
}

export class Google {
  constructor(private integ: Integration) {}

  static async forUser(userId: string): Promise<Google> {
    const integ = await integrations.get(userId, 'google');
    if (!integ || integ.status !== 'active') throw new GoogleNotConnected();
    return new Google(integ);
  }

  get account(): string | null {
    return this.integ.account;
  }

  hasScope(fragment: string): boolean {
    return this.integ.scopes.some((s) => s.includes(fragment));
  }

  private async accessToken(): Promise<string> {
    if (this.integ.access_token_enc && this.integ.expires_at && this.integ.expires_at.getTime() > Date.now() + 30_000) {
      return decrypt(this.integ.access_token_enc);
    }
    if (!this.integ.refresh_token_enc) throw new GoogleNotConnected();
    try {
      const t = await tokenRequest({ refresh_token: decrypt(this.integ.refresh_token_enc), grant_type: 'refresh_token' });
      const enc = encrypt(t.access_token);
      const expires = new Date(Date.now() + (t.expires_in - 60) * 1000);
      await integrations.updateTokens(this.integ.id, enc, expires);
      this.integ = { ...this.integ, access_token_enc: enc, expires_at: expires };
      return t.access_token;
    } catch (err) {
      if (String(err).includes('invalid_grant')) {
        await integrations.setStatus(this.integ.id, 'revoked');
        throw new GoogleNotConnected();
      }
      throw err;
    }
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      log.warn({ status: res.status, url: url.split('?')[0] }, 'google api error');
      throw new Error(`Google API ${res.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async requestText(url: string): Promise<string> {
    const token = await this.accessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Google API ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }

  // ---- Calendar ------------------------------------------------------------------------------

  async listEvents(opts: { timeMin: Date; timeMax: Date; query?: string; max?: number; calendarId?: string }): Promise<CalendarEvent[]> {
    const p = new URLSearchParams({
      timeMin: opts.timeMin.toISOString(),
      timeMax: opts.timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(opts.max ?? 25),
    });
    if (opts.query) p.set('q', opts.query);
    const body = await this.request<{ items?: GEvent[] }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(opts.calendarId ?? 'primary')}/events?${p}`);
    return (body.items ?? []).filter((e) => e.status !== 'cancelled').map(toEvent);
  }

  async getEvent(id: string): Promise<CalendarEvent> {
    return toEvent(await this.request<GEvent>(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`));
  }

  async createEvent(e: { summary: string; start: Date; end: Date; timezone: string; location?: string; description?: string; attendees?: string[]; addMeet?: boolean }): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {
      summary: e.summary,
      start: { dateTime: e.start.toISOString(), timeZone: e.timezone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timezone },
      location: e.location,
      description: e.description,
      attendees: e.attendees?.map((email) => ({ email })),
    };
    if (e.addMeet) body.conferenceData = { createRequest: { requestId: `ta-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    const sendUpdates = e.attendees?.length ? 'all' : 'none';
    return toEvent(
      await this.request<GEvent>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${sendUpdates}&conferenceDataVersion=1`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  async updateEvent(id: string, patch: { summary?: string; start?: Date; end?: Date; timezone: string; location?: string; description?: string; addAttendees?: string[] }, notify: boolean): Promise<CalendarEvent> {
    const body: Record<string, unknown> = {};
    if (patch.summary) body.summary = patch.summary;
    if (patch.start) body.start = { dateTime: patch.start.toISOString(), timeZone: patch.timezone };
    if (patch.end) body.end = { dateTime: patch.end.toISOString(), timeZone: patch.timezone };
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.addAttendees?.length) {
      const current = await this.getEvent(id);
      body.attendees = [...current.attendees.map((a) => ({ email: a.email })), ...patch.addAttendees.map((email) => ({ email }))];
    }
    return toEvent(
      await this.request<GEvent>(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${notify ? 'all' : 'none'}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    );
  }

  async deleteEvent(id: string, notify: boolean): Promise<void> {
    await this.request(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${notify ? 'all' : 'none'}`, { method: 'DELETE' });
  }

  async freeBusy(timeMin: Date, timeMax: Date): Promise<{ start: string; end: string }[]> {
    const body = await this.request<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: 'primary' }] }),
    });
    return body.calendars?.primary?.busy ?? [];
  }

  // ---- Gmail ---------------------------------------------------------------------------------

  async searchMail(query: string, max = 10): Promise<MailSummary[]> {
    const list = await this.request<{ messages?: { id: string; threadId: string }[] }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`,
    );
    const ids = list.messages ?? [];
    const out = await Promise.all(
      ids.map(async (m) => {
        const msg = await this.request<GMessage>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        return summarise(msg);
      }),
    );
    return out;
  }

  async readMail(id: string, maxChars = 8000): Promise<MailMessage> {
    const msg = await this.request<GMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    const base = summarise(msg);
    const body = extractBody(msg.payload).slice(0, maxChars);
    const h = headerMap(msg.payload?.headers);
    return { ...base, body, messageIdHeader: h['message-id'] ?? null, references: h['references'] ?? null, cc: h['cc'] ?? null };
  }

  async createDraft(m: OutgoingMail): Promise<{ draftId: string }> {
    const res = await this.request<{ id: string }>('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: buildRaw(m, this.account), threadId: m.threadId } }),
    });
    return { draftId: res.id };
  }

  async send(m: OutgoingMail): Promise<{ id: string; threadId: string }> {
    return this.request<{ id: string; threadId: string }>('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: buildRaw(m, this.account), threadId: m.threadId }),
    });
  }

  async archive(id: string): Promise<void> {
    await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
    });
  }

  // ---- Drive ---------------------------------------------------------------------------------

  async searchDrive(query: string, max = 10): Promise<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[]> {
    const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
    const body = await this.request<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[] }>(
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, pageSize: String(max), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', orderBy: 'modifiedTime desc' })}`,
    );
    return body.files ?? [];
  }

  async readDriveFile(id: string, maxChars = 15000): Promise<{ name: string; mimeType: string; text: string; truncated: boolean }> {
    const meta = await this.request<{ name: string; mimeType: string }>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name,mimeType`);
    let text: string;
    if (meta.mimeType === 'application/vnd.google-apps.document' || meta.mimeType === 'application/vnd.google-apps.presentation') {
      text = await this.requestText(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/plain`);
    } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
      text = await this.requestText(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/csv`);
    } else if (meta.mimeType.startsWith('text/') || meta.mimeType === 'application/json') {
      text = await this.requestText(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    } else {
      throw new Error(`Can't read ${meta.mimeType} files as text yet`);
    }
    return { name: meta.name, mimeType: meta.mimeType, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  // ---- Contacts ------------------------------------------------------------------------------

  async searchContacts(query: string): Promise<{ name: string; emails: string[]; phones: string[] }[]> {
    const mask = 'names,emailAddresses,phoneNumbers';
    const [main, other] = await Promise.allSettled([
      this.request<{ results?: { person: GPerson }[] }>(`https://people.googleapis.com/v1/people:searchContacts?${new URLSearchParams({ query, readMask: mask, pageSize: '10' })}`),
      this.request<{ results?: { person: GPerson }[] }>(`https://people.googleapis.com/v1/otherContacts:search?${new URLSearchParams({ query, readMask: 'names,emailAddresses,phoneNumbers', pageSize: '10' })}`),
    ]);
    const people = [
      ...(main.status === 'fulfilled' ? (main.value.results ?? []) : []),
      ...(other.status === 'fulfilled' ? (other.value.results ?? []) : []),
    ].map((r) => r.person);
    const seen = new Set<string>();
    return people
      .map((p) => ({
        name: p.names?.[0]?.displayName ?? '',
        emails: (p.emailAddresses ?? []).map((e) => e.value),
        phones: (p.phoneNumbers ?? []).map((n) => n.canonicalForm ?? n.value),
      }))
      .filter((p) => {
        const key = `${p.name}|${p.emails[0] ?? ''}`;
        if (seen.has(key) || (!p.name && p.emails.length === 0)) return false;
        seen.add(key);
        return true;
      });
  }
}

// ---- types and helpers -------------------------------------------------------------------------

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; responseStatus?: string; self?: boolean; displayName?: string; organizer?: boolean }[];
  organizer?: { email?: string; self?: boolean };
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  meetLink: string | null;
  attendees: { email: string; name: string | null; response: string | null; self: boolean }[];
  organizerIsUser: boolean;
  link: string | null;
}

function toEvent(e: GEvent): CalendarEvent {
  return {
    id: e.id,
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location ?? null,
    description: e.description ? e.description.slice(0, 1000) : null,
    meetLink: e.hangoutLink ?? null,
    attendees: (e.attendees ?? []).map((a) => ({ email: a.email, name: a.displayName ?? null, response: a.responseStatus ?? null, self: Boolean(a.self) })),
    organizerIsUser: Boolean(e.organizer?.self),
    link: e.htmlLink ?? null,
  };
}

interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GPart[];
}

interface GMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPart;
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  body: string;
  messageIdHeader: string | null;
  references: string | null;
  cc: string | null;
}

interface GPerson {
  names?: { displayName?: string }[];
  emailAddresses?: { value: string }[];
  phoneNumbers?: { value: string; canonicalForm?: string }[];
}

function headerMap(headers?: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function summarise(m: GMessage): MailSummary {
  const h = headerMap(m.payload?.headers);
  return {
    id: m.id,
    threadId: m.threadId,
    from: h['from'] ?? null,
    to: h['to'] ?? null,
    subject: h['subject'] ?? null,
    date: h['date'] ?? (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null),
    snippet: decodeEntities(m.snippet ?? ''),
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

function decodeEntities(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function extractBody(part?: GPart): string {
  if (!part) return '';
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GPart) => {
    if (p.mimeType === 'text/plain' && p.body?.data && !p.filename) plain.push(b64urlDecode(p.body.data));
    else if (p.mimeType === 'text/html' && p.body?.data && !p.filename) html.push(b64urlDecode(p.body.data));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  if (plain.length) return plain.join('\n').replace(/\r/g, '').trim();
  return html
    .join('\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string | null;
  references?: string | null;
}

function encodeHeader(value: string): string {
  // RFC 2047 for non-ASCII header values.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildRaw(m: OutgoingMail, from: string | null): string {
  const strip = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    ...(from ? [`From: ${strip(from)}`] : []),
    `To: ${m.to.map(strip).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(strip).join(', ')}`] : []),
    `Subject: ${encodeHeader(strip(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${strip(m.inReplyTo)}`, `References: ${strip(m.references ? `${m.references} ${m.inReplyTo}` : m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
