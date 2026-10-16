import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', config().appSecret, 'tarka-assistant', purpose, 32));
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key('secrets'), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key('secrets'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Short human-friendly code (no ambiguous characters). */
export function shortCode(length = 6, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Approval codes have no vowels, so a code can never spell a word like YEAH or NOPE. */
export const APPROVAL_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Keyed hash (e.g. for voice PINs): useless without APP_SECRET. */
export function keyedHash(purpose: string, value: string): string {
  return createHmac('sha256', key(`hash:${purpose}`)).update(value).digest('base64url');
}

/** A stable UUID derived from a string (used as a job id so redelivered webhooks are queued once). */
export function stableUuid(input: string): string {
  const h = createHash('sha256').update(input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function sign(payload: string, purpose = 'state'): string {
  return createHmac('sha256', key(purpose)).update(payload).digest('base64url');
}

export function verifySignature(payload: string, signature: string, purpose = 'state'): boolean {
  const expected = Buffer.from(sign(payload, purpose));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Signed, expiring token: base64url(json).signature */
export function sealState(data: Record<string, unknown>, ttlSeconds = 900): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function openState<T extends Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !verifySignature(body, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}
