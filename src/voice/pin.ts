import { timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import type { User } from '../db/types.js';
import { keyedHash } from '../util/crypto.js';

/**
 * Voice PINs. Caller ID can be faked, so a call only gets the user's personal assistant when the
 * carrier vouches for the number (STIR/SHAKEN "A") or the caller says their PIN. The check is
 * done here in code, never by the model, and PIN utterances never reach the model or the
 * conversation history.
 *
 * Guessing is bounded per call, per day and per week, counted in the database under a per-user
 * lock (so parallel calls can't each get a fresh allowance), and the account holder is told about
 * every wrong PIN.
 */

export const PIN_MIN = 6;
export const PIN_MAX = 8;
/** Wrong attempts allowed within one call. */
export const MAX_WRONG_PER_CALL = 3;
/** Distinct wrong PINs per user per day before PIN access pauses for the day. */
export const MAX_WRONG_PER_DAY = 5;
/** Distinct wrong PINs per user per week before the PIN stops working until it is changed. */
export const MAX_WRONG_PER_WEEK = 10;

export interface StoredPin {
  hash: string;
  length: number;
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

export function hashPin(userId: string, pin: string): StoredPin {
  return { hash: keyedHash('voice-pin', `${userId}:${pin}`), length: pin.length };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const UNITS: Record<string, string> = { zero: '0', nought: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const TEENS: Record<string, string> = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS: Record<string, number> = { twenty: 2, thirty: 3, forty: 4, fifty: 5, sixty: 6, seventy: 7, eighty: 8, ninety: 9 };
/** Words that may surround a PIN without making the utterance about something else. */
const FILLER = new Set([
  'my', 'pin', 'pins', 'is', 'its', 'it', 'the', 'code', 'number', 'voice', 'passcode', 'password', 'um', 'uh', 'er', 'erm', 'hmm',
  'okay', 'ok', 'yes', 'yeah', 'sure', 'so', 'and', 'then', 'that', 'thats', 'i', 'think', 'please', 'here', 'goes', 'hi', 'hello',
]);

/**
 * The digits of an utterance that is ONLY a PIN ("471902", "my pin is four seven one nine oh
 * two", "forty-seven nineteen oh two"), or null when it says anything else ("my flight is 1234").
 */
export function pinAttempt(utterance: string): string | null {
  const tokens = utterance.toLowerCase().replace(/[’']/g, '').replace(/[-–—]/g, ' ').match(/[a-z]+|\d+/g) ?? [];
  let digits = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    const prev = tokens[i - 1];
    if (/^\d+$/.test(t)) digits += t;
    else if (UNITS[t]) digits += UNITS[t];
    else if (TEENS[t]) digits += TEENS[t];
    else if (TENS[t] !== undefined) {
      if (next && UNITS[next] && UNITS[next] !== '0') {
        digits += `${TENS[t]}${UNITS[next]}`;
        i++;
      } else digits += `${TENS[t]}0`;
    } else if ((t === 'double' || t === 'triple') && next && UNITS[next]) {
      digits += UNITS[next]!.repeat(t === 'double' ? 2 : 3);
      i++;
    } else if (t === 'oh' || t === 'o') {
      // "oh" is zero only between other digits ("four oh one nine"), not "oh, my pin is…".
      const isDigit = (w?: string) => Boolean(w && (/^\d+$/.test(w) || UNITS[w] || TEENS[w] || TENS[w] !== undefined));
      if (isDigit(prev) || isDigit(next)) digits += '0';
    } else if (!FILLER.has(t)) return null;
  }
  return digits.length >= PIN_MIN && digits.length <= PIN_MAX ? digits : null;
}

export interface CallerCheck {
  trusted: boolean;
  how: 'caller-id' | 'pin' | null;
  /** The newest utterance was a PIN attempt: answer it in code (`reply`), not with the model. */
  pinReply: string | null;
  /** What to tell the account holder (by text) about this call, if anything. */
  notify: string | null;
}

const untrusted: CallerCheck = { trusted: false, how: null, pinReply: null, notify: null };

/**
 * Replays this call's utterances (Telnyx sends the whole call on every turn, so nothing per call
 * needs storing) to decide whether the caller is the account holder.
 */
export async function checkCaller(user: User, utterances: string[], attestation: string | undefined): Promise<CallerCheck> {
  const settings = user.settings;
  if ((attestation ?? '').toUpperCase() === 'A' && !settings.voiceRequirePin) {
    return { trusted: true, how: 'caller-id', pinReply: null, notify: null };
  }
  const pin = settings.voicePin;
  if (!pin) return untrusted;
  const attempts = utterances.map((u, i) => ({ i, guess: pinAttempt(u) })).filter((a): a is { i: number; guess: string } => a.guess !== null);
  if (attempts.length === 0) return untrusted;

  return db().begin(async (tx) => {
    // One caller at a time per account, so every guess is counted before the next is compared.
    await tx`select pg_advisory_xact_lock(hashtext(${`voice-pin:${user.id}`}))`;
    const rows = await tx<{ guess_hash: string; recent: boolean }[]>`
      select guess_hash, created_at > now() - interval '1 day' as recent
      from voice_pin_failures where user_id = ${user.id} and created_at > now() - interval '7 days'`;
    const known = new Set(rows.map((r) => r.guess_hash));
    let day = rows.filter((r) => r.recent).length;
    let week = rows.length;
    let wrongInCall = 0;
    const newest = utterances.length - 1;
    const startDay = day;
    const startWeek = week;
    let newFailures = 0;
    // One text per turn to the account holder, saying what changed.
    const note = (): string | null => {
      if (week >= MAX_WRONG_PER_WEEK && startWeek < MAX_WRONG_PER_WEEK) {
        return 'Someone keeps saying wrong voice PINs on calls from your number, so voice PIN access is now off. Set a new PIN in Settings to turn it back on.';
      }
      if (day >= MAX_WRONG_PER_DAY && startDay < MAX_WRONG_PER_DAY) {
        return 'Someone said several wrong voice PINs on calls from your number today, so PIN access is paused for a day. Nothing personal was shared.';
      }
      if (newFailures === 0) return null;
      const what = newFailures === 1 ? 'a wrong voice PIN' : `${newFailures} wrong voice PINs`;
      return `Someone said ${what} on a call from your number. Nothing personal was shared. If it wasn’t you, consider changing the PIN in Settings.`;
    };

    for (const a of attempts) {
      const blocked = week >= MAX_WRONG_PER_WEEK ? 'week' : day >= MAX_WRONG_PER_DAY ? 'day' : wrongInCall >= MAX_WRONG_PER_CALL ? 'call' : null;
      if (blocked) {
        if (a.i === newest) {
          return {
            trusted: false,
            how: null,
            pinReply: blocked === 'week' ? 'Voice PIN access is switched off for this account until a new PIN is set. You can text me instead.' : "Sorry, I can't take more PIN attempts right now. You can text me instead.",
            notify: note(),
          };
        }
        continue;
      }
      if (a.guess.length === pin.length && same(hashPin(user.id, a.guess).hash, pin.hash)) {
        const name = user.name ? `, ${user.name}` : '';
        return { trusted: true, how: 'pin', pinReply: a.i === newest ? `Thanks${name}, you're verified. What can I do for you?` : null, notify: note() };
      }
      wrongInCall++;
      const h = keyedHash('voice-pin-guess', `${user.id}:${a.guess}`);
      if (!known.has(h)) {
        known.add(h);
        await tx`insert into voice_pin_failures (user_id, guess_hash) values (${user.id}, ${h}) on conflict do nothing`;
        day++;
        week++;
        newFailures++;
      }
      if (a.i === newest) {
        const noMore = wrongInCall >= MAX_WRONG_PER_CALL || day >= MAX_WRONG_PER_DAY || week >= MAX_WRONG_PER_WEEK;
        return {
          trusted: false,
          how: null,
          pinReply: noMore ? "Sorry, I can't take more PIN attempts right now. You can text me instead." : "That PIN didn't match. Want to try once more?",
          notify: note(),
        };
      }
    }
    return { ...untrusted, notify: note() };
  });
}

/** A new PIN starts with a clean slate. */
export async function clearPinFailures(userId: string): Promise<void> {
  await db()`delete from voice_pin_failures where user_id = ${userId}`;
}
