import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DateTime } from 'luxon';
import { parseWhen, parseRangeEdge, nextCronRun, repeatToCron, describeCron, isQuiet, endOfQuiet, isValidTimezone, minCronGapMinutes } from '../src/util/time.js';
import { toPlain, toTelegramHtml, splitMessage, stripThinking, toWhatsApp, hasLeakedTokens, usableReply } from '../src/channels/format.js';
import { renderMarkdown } from '../src/util/markdown.js';
import { encrypt, decrypt, sealState, openState, shortCode, APPROVAL_CODE_ALPHABET, stableUuid } from '../src/util/crypto.js';
import { parseTelnyxMessage } from '../src/channels/telnyx.js';
import { buildRaw, extractBody } from '../src/integrations/google.js';
import { historyToMessages } from '../src/agent/turn.js';
import { redactSecrets } from '../src/memory/hindsight.js';
import { assertPublicUrl, isPrivate, pinnedLookup, v6Groups } from '../src/util/net.js';
import { pinAttempt } from '../src/voice/pin.js';
import { safeNext } from '../src/web/links.js';
import { loadConfig } from '../src/config.js';
import { countryOf } from '../src/integrations/telnyx.js';
import type { MessageRow } from '../src/db/types.js';

const tz = 'America/Los_Angeles';
// Friday 16 Oct 2026, 09:00 in Los Angeles (16:00 UTC)
const now = new Date('2026-10-16T16:00:00Z');

describe('time parsing', () => {
  it('reads ISO without offset in the user zone', () => {
    const d = parseWhen('2026-10-17T09:30', tz, now)!;
    expect(DateTime.fromJSDate(d).setZone(tz).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-17 09:30');
  });
  it('respects an explicit offset', () => {
    expect(parseWhen('2026-10-17T09:30:00Z', tz, now)!.toISOString()).toBe('2026-10-17T09:30:00.000Z');
  });
  it('handles relative times', () => {
    const d = parseWhen('in 20 minutes', tz, now)!;
    expect(Math.round((d.getTime() - now.getTime()) / 60000)).toBe(20);
  });
  it('handles "tomorrow at 9am" in the user zone', () => {
    const d = parseWhen('tomorrow at 9am', tz, now)!;
    expect(DateTime.fromJSDate(d).setZone(tz).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-17 09:00');
  });
  it('defaults date-only phrases to 9am', () => {
    const d = parseWhen('next Monday', tz, now)!;
    const local = DateTime.fromJSDate(d).setZone(tz);
    expect(local.weekday).toBe(1);
    expect(local.toFormat('HH:mm')).toBe('09:00');
  });
  it('crosses the DST change correctly', () => {
    // US DST ends 1 Nov 2026: 9am on 2 Nov is 17:00 UTC (PST), not 16:00.
    const d = parseWhen('2026-11-02T09:00', tz, now)!;
    expect(d.toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });
  it('returns null for nonsense', () => {
    expect(parseWhen('whenever you like', tz, now)).toBeNull();
  });
  it('validates timezones', () => {
    expect(isValidTimezone('Asia/Kathmandu')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
  it('reads a bare day as the whole day at either end of a range', () => {
    const local = (d: Date | null) => DateTime.fromJSDate(d!).setZone(tz).toFormat('yyyy-LL-dd HH:mm');
    // The calendar returned nothing for from "tomorrow" to "tomorrow": both used to mean 9am.
    expect(local(parseRangeEdge('tomorrow', tz, 'start', now))).toBe('2026-10-17 00:00');
    expect(local(parseRangeEdge('tomorrow', tz, 'end', now))).toBe('2026-10-17 23:59');
    expect(local(parseRangeEdge('2026-10-17', tz, 'end', now))).toBe('2026-10-17 23:59');
    expect(local(parseRangeEdge('today', tz, 'start', now))).toBe('2026-10-16 00:00');
    expect(local(parseRangeEdge('tomorrow at 3pm', tz, 'end', now))).toBe('2026-10-17 15:00');
    expect(local(parseRangeEdge('2026-10-17T08:30', tz, 'start', now))).toBe('2026-10-17 08:30');
    expect(local(parseRangeEdge('in 2 hours', tz, 'end', now))).toBe('2026-10-16 11:00');
    expect(parseRangeEdge('whenever', tz, 'start', now)).toBeNull();
  });
});

describe('cron', () => {
  it('turns repeat words into cron at the local time', () => {
    const first = DateTime.fromISO('2026-10-19T08:15', { zone: tz });
    expect(repeatToCron('weekdays', first)).toBe('15 8 * * 1-5');
    expect(repeatToCron('weekly', first)).toBe('15 8 * * 1');
    expect(repeatToCron('monthly', first)).toBe('15 8 19 * *');
    expect(repeatToCron('0 7 * * *', first)).toBe('0 7 * * *');
    expect(repeatToCron('every blue moon', first)).toBeNull();
  });
  it('computes the next run in the zone', () => {
    const next = nextCronRun('30 7 * * *', 'Asia/Kathmandu', new Date('2026-10-16T00:00:00Z'))!;
    // 07:30 NPT = 01:45 UTC
    expect(next.toISOString()).toBe('2026-10-16T01:45:00.000Z');
  });
  it('describes common schedules', () => {
    expect(describeCron('30 7 * * *')).toBe('every day at 7:30 AM');
    expect(describeCron('0 9 * * 1-5')).toBe('weekdays at 9:00 AM');
    expect(describeCron('0 18 * * 5')).toBe('every Friday at 6:00 PM');
  });
});

describe('quiet hours', () => {
  const user = { timezone: tz, settings: { quietHours: { start: '22:00', end: '07:30' } } };
  it('detects quiet time across midnight', () => {
    expect(isQuiet(user, new Date('2026-10-16T06:00:00Z'))).toBe(true); // 23:00 LA
    expect(isQuiet(user, new Date('2026-10-16T16:00:00Z'))).toBe(false); // 09:00 LA
  });
  it('finds the end of quiet time', () => {
    const end = endOfQuiet(user, new Date('2026-10-16T06:00:00Z'));
    expect(DateTime.fromJSDate(end).setZone(tz).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-16 07:30');
  });
});

describe('formatting', () => {
  it('strips leaked reasoning', () => {
    expect(stripThinking('<think>secret plan</think>Hello')).toBe('Hello');
  });
  it('never shows a reply with leaked chat-template tokens', () => {
    // What Kimi K3 sent as text once, instead of a tool call.
    const kimi = '<|open|>tools<|sep|><|open|>call tool="email_read" index="1"<|sep|><|open|>argument key="id" type="string"<|sep|>m1<|close|>argument<|sep|>';
    expect(hasLeakedTokens(kimi)).toBe(true);
    expect(usableReply(kimi)).toBe('');
    expect(hasLeakedTokens('Sure.<|im_end|>')).toBe(true);
    expect(hasLeakedTokens('<｜tool▁calls▁begin｜>')).toBe(true);
    expect(hasLeakedTokens('<tool_call>{"name":"x"}</tool_call>')).toBe(true);
    for (const ok of ['a <b> c', 'x || y', 'pipe | and <| alone', '5 < 6 > 4', 'Order #1042 — <3']) expect(hasLeakedTokens(ok)).toBe(false);
    expect(usableReply('<think>hmm</think> Hi there')).toBe('Hi there');
  });
  it('converts markdown to plain SMS text', () => {
    expect(toPlain('**Bold** and [the site](https://x.com)\n- one\n- two')).toBe('Bold and the site (https://x.com)\n• one\n• two');
  });
  it('escapes HTML for Telegram and keeps formatting', () => {
    expect(toTelegramHtml('**hi** <script> `x<y`')).toBe('<b>hi</b> &lt;script&gt; <code>x&lt;y</code>');
  });
  it('uses WhatsApp emphasis', () => {
    expect(toWhatsApp('**Done**')).toBe('*Done*');
  });
  it('splits long messages on boundaries', () => {
    const parts = splitMessage(`${'a'.repeat(60)}. ${'b'.repeat(60)}.\n\n${'c'.repeat(50)}`, 70);
    expect(parts.every((p) => p.length <= 70)).toBe(true);
    expect(parts.join('')).toContain('c'.repeat(50));
  });
});

describe('markdown renderer', () => {
  it('escapes HTML and renders links safely', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [ok](https://tarkahq.com) [bad](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://tarkahq.com"');
    expect(html).not.toContain('href="javascript');
  });
  it('renders lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });
});

describe('crypto', () => {
  it('round-trips secrets', () => {
    const blob = encrypt('refresh-token-123');
    expect(blob).not.toContain('refresh');
    expect(decrypt(blob)).toBe('refresh-token-123');
  });
  it('rejects tampered state', () => {
    const s = sealState({ uid: 'u1', p: 'google' });
    expect(openState<{ uid: string }>(s)?.uid).toBe('u1');
    expect(openState(s.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
  });
});

describe('telnyx', () => {
  it('verifies Ed25519 webhook signatures', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    process.env.TELNYX_PUBLIC_KEY = Buffer.from(raw).toString('base64');
    const { loadConfig, setConfig } = await import('../src/config.js');
    setConfig(loadConfig());
    const { verifyTelnyxSignature } = await import('../src/integrations/telnyx.js');
    const body = '{"data":{"event_type":"message.received"}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
    expect(verifyTelnyxSignature(body, sig, ts)).toBe(true);
    expect(verifyTelnyxSignature(body + ' ', sig, ts)).toBe(false);
    expect(verifyTelnyxSignature(body, sig, String(Number(ts) - 3600))).toBe(false);
    delete process.env.TELNYX_PUBLIC_KEY;
    setConfig(loadConfig());
  });
  it('parses inbound SMS and WhatsApp', () => {
    const sms = parseTelnyxMessage({ data: { event_type: 'message.received', payload: { id: 'x', type: 'SMS', from: { phone_number: '+14155550100' }, text: 'hi', media: [] } } });
    expect(sms).toMatchObject({ channel: 'sms', externalId: '+14155550100', text: 'hi', country: 'US' });
    const wa = parseTelnyxMessage({ data: { event_type: 'message.received', payload: { type: 'whatsapp', from: '+4915112345678', text: 'hallo' } } });
    expect(wa).toMatchObject({ channel: 'whatsapp', country: 'DE' });
    expect(parseTelnyxMessage({ data: { event_type: 'message.sent', payload: {} } })).toBeNull();
  });
  it('maps country codes by longest prefix', () => {
    expect(countryOf('+9779812345678')).toBe('NP');
    expect(countryOf('+353861234567')).toBe('IE');
  });
});

describe('google helpers', () => {
  it('builds RFC 2822 messages with encoded subjects and no header injection', () => {
    const raw = buildRaw({ to: ['a@b.com'], subject: 'Grüße\r\nBcc: evil@x.com', body: 'Hi' }, 'me@x.com');
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    expect(text).toContain('Subject: =?UTF-8?B?');
    expect(text).not.toMatch(/^Bcc:/m);
  });
  it('extracts plain text bodies, falling back to HTML', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(extractBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi <b>there</b></p>') } }] })).toBe('Hi there');
    expect(extractBody({ mimeType: 'text/plain', body: { data: b64('plain') } })).toBe('plain');
  });
});

describe('history', () => {
  const row = (id: number, role: MessageRow['role'], content: string): MessageRow => ({ id, user_id: 'u', created_at: new Date(), role, channel: 'sms', content, meta: {} });
  it('merges same-role runs, notes events and starts with the user', () => {
    const out = historyToMessages([row(1, 'assistant', 'Hi!'), row(2, 'user', 'a'), row(3, 'user', 'b'), row(4, 'event', 'Sent email'), row(5, 'assistant', 'Done')]);
    expect(out[0]).toEqual({ role: 'user', content: 'a\n\nb' });
    expect(out[1]).toEqual({ role: 'assistant', content: '[note] Sent email\n\nDone' });
  });
});

describe('safety helpers', () => {
  it('redacts secrets before they reach memory', () => {
    expect(redactSecrets('my card is 4242 4242 4242 4242 and the code is 123456')).toBe('my card is [redacted] and the [redacted]');
  });
  it('blocks private addresses', () => {
    expect(isPrivate('10.0.0.1')).toBe(true);
    expect(isPrivate('169.254.169.254')).toBe(true);
    expect(isPrivate('::1')).toBe(true);
    expect(isPrivate('8.8.8.8')).toBe(false);
  });
  it('sees IPv4 hidden inside IPv6, and other special ranges', () => {
    for (const a of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1',
      '2002:7f00:1::', '0.0.0.0', '::', 'fd00::1', 'fe80::1%eth0', '100.100.100.200', '198.18.0.1', 'not-an-ip', '1::2::3', '::ffff:0:a00:1',
    ]) {
      expect([a, isPrivate(a)]).toEqual([a, true]);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '64:ff9b::808:808', '2a00:1450:4001::200e']) {
      expect([a, isPrivate(a)]).toEqual([a, false]);
    }
  });
  it('expands IPv6 groups', () => {
    expect(v6Groups('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(v6Groups('64:ff9b::1.2.3.4')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
    expect(v6Groups('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(v6Groups('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
  it('refuses odd ports, credentials and internal names before any lookup', async () => {
    await expect(assertPublicUrl('http://user:pw@example.com/')).rejects.toThrow(/credentials/);
    await expect(assertPublicUrl('http://example.com:22/')).rejects.toThrow(/port/);
    await expect(assertPublicUrl('http://tarka/v1/models')).rejects.toThrow(/not reachable/);
    await expect(assertPublicUrl('http://metadata.google.internal/')).rejects.toThrow(/not reachable/);
    await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).rejects.toThrow(/not reachable/);
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow(/not reachable/); // 127.0.0.1 written as a number
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
  });
  it('pins the connection to checked addresses (DNS rebinding)', async () => {
    const result = await new Promise<{ err: Error | null; addr: unknown }>((resolve) => {
      pinnedLookup('127.0.0.1', { all: true }, (err, addr) => resolve({ err, addr }));
    });
    expect(result.err?.message).toMatch(/not reachable/);
    const ok = await new Promise<{ err: Error | null; addr: unknown }>((resolve) => {
      pinnedLookup('93.184.215.14', {}, (err, addr) => resolve({ err, addr }));
    });
    expect(ok).toEqual({ err: null, addr: '93.184.215.14' });
  });
});

describe('approval codes', () => {
  it('never contain vowels, so they can’t spell yes/no words', () => {
    for (let i = 0; i < 200; i++) expect(shortCode(4, APPROVAL_CODE_ALPHABET)).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
  });
  it('derives stable UUIDs', () => {
    expect(stableUuid('telegram:1:2')).toBe(stableUuid('telegram:1:2'));
    expect(stableUuid('telegram:1:2')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('voice PIN parsing', () => {
  it('reads PINs said in many ways', () => {
    expect(pinAttempt('471902')).toBe('471902');
    expect(pinAttempt('My PIN is 4 7 1 9 0 2.')).toBe('471902');
    expect(pinAttempt('four seven one nine zero two')).toBe('471902');
    expect(pinAttempt('forty-seven nineteen oh two')).toBe('471902');
    expect(pinAttempt('four oh one nine one one')).toBe('401911');
    expect(pinAttempt('double four one nine oh two')).toBe('441902');
    expect(pinAttempt('Oh, um, it’s 471902')).toBe('471902');
  });
  it('ignores sentences that merely contain numbers, and short or run-together numbers', () => {
    expect(pinAttempt('my flight is 123456')).toBeNull();
    expect(pinAttempt('call me at 5')).toBeNull();
    expect(pinAttempt('what is on today')).toBeNull();
    expect(pinAttempt('4719')).toBeNull(); // PINs are at least six digits
    expect(pinAttempt('471902 471903')).toBeNull(); // several guesses in one breath aren't a PIN
  });
});

describe('sign-in redirects', () => {
  it('only continues to our own pages', () => {
    expect(safeNext('/app/memory')).toBe('/app/memory');
    expect(safeNext('/oauth/google/connect')).toBe('/oauth/google/connect');
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', '/\t/evil.example', '/%09/evil.example', '/app/../../x', 'javascript:alert(1)', '/webhooks/stripe', undefined, 42]) {
      expect(safeNext(bad)).toBe('/app');
    }
  });
});

describe('cron frequency', () => {
  it('finds the shortest gap between runs', () => {
    expect(minCronGapMinutes('0 9 * * *', 'Europe/Berlin')).toBe(24 * 60);
    expect(minCronGapMinutes('*/5 * * * *', 'UTC')).toBe(5);
    expect(minCronGapMinutes('0,5 9 * * *', 'UTC')).toBe(5);
  });
});

describe('telegram webhook secret', () => {
  it('is derived from APP_SECRET when not set, in Telegram’s allowed alphabet', () => {
    const c = loadConfig({ APP_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv);
    expect(c.telegram.webhookSecret).toMatch(/^[A-Za-z0-9_-]{20,256}$/);
    expect(loadConfig({ APP_SECRET: 'y'.repeat(40) } as NodeJS.ProcessEnv).telegram.webhookSecret).not.toBe(c.telegram.webhookSecret);
    expect(loadConfig({ APP_SECRET: 'x'.repeat(40), TELEGRAM_WEBHOOK_SECRET: 'mine' } as NodeJS.ProcessEnv).telegram.webhookSecret).toBe('mine');
  });
});
