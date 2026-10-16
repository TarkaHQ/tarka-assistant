import { kv } from '../db/repo.js';
import type { User } from '../db/types.js';
import { keyedHash } from '../util/crypto.js';

/**
 * Voice PINs. Caller ID can be faked, so a call only gets the user's personal assistant when the
 * carrier vouches for the number (STIR/SHAKEN "A") or the caller says their PIN. The check is
 * done here in code, never by the model, and PIN utterances never reach the model or the
 * conversation history.
 */

export const PIN_MIN = 4;
export const PIN_MAX = 8;
/** Wrong attempts allowed within one call. */
export const MAX_WRONG_PER_CALL = 3;
/** Distinct wrong PINs per user per day before PIN access pauses. */
export const MAX_WRONG_PER_DAY = 5;

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

const UNITS: Record<string, string> = { zero: '0', nought: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const TEENS: Record<string, string> = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS: Record<string, number> = { twenty: 2, thirty: 3, forty: 4, fifty: 5, sixty: 6, seventy: 7, eighty: 8, ninety: 9 };
/** Words that may surround a PIN without making the utterance about something else. */
const FILLER = new Set([
  'my', 'pin', 'pins', 'is', 'its', 'it', 'the', 'code', 'number', 'voice', 'passcode', 'password', 'um', 'uh', 'er', 'erm', 'hmm',
  'okay', 'ok', 'yes', 'yeah', 'sure', 'so', 'and', 'then', 'that', 'thats', 'i', 'think', 'please', 'here', 'goes', 'hi', 'hello',
]);

/**
 * The digits of an utterance that is ONLY a PIN ("4719", "my pin is four seven one nine",
 * "forty-seven nineteen"), or null when it says anything else ("my flight is 1234").
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

interface FailLog {
  [guessHash: string]: number;
}

const failKey = (userId: string) => `voicepin:fails:${userId}`;

async function recentFailures(userId: string): Promise<FailLog> {
  const log = (await kv.get<FailLog>(failKey(userId))) ?? {};
  const cutoff = Date.now() - 24 * 3600_000;
  return Object.fromEntries(Object.entries(log).filter(([, at]) => at > cutoff));
}

export async function pinLocked(userId: string): Promise<boolean> {
  return Object.keys(await recentFailures(userId)).length >= MAX_WRONG_PER_DAY;
}

/** Counts distinct wrong guesses (Telnyx resends the whole call each turn, so repeats are free). */
export async function recordWrongPin(userId: string, guess: string): Promise<{ lockedNow: boolean }> {
  const log = await recentFailures(userId);
  const h = keyedHash('voice-pin-guess', `${userId}:${guess}`);
  if (log[h]) return { lockedNow: false };
  const before = Object.keys(log).length;
  log[h] = Date.now();
  await kv.set(failKey(userId), log);
  return { lockedNow: before < MAX_WRONG_PER_DAY && before + 1 >= MAX_WRONG_PER_DAY };
}

export interface CallerCheck {
  trusted: boolean;
  how: 'caller-id' | 'pin' | null;
  /** The newest utterance was a PIN attempt: answer it in code (`reply`), not with the model. */
  pinReply: string | null;
  /** Someone just used up the day's wrong attempts: tell the account holder. */
  lockedNow: boolean;
}

/**
 * Replays this call's utterances (Telnyx sends the whole call on every turn, so nothing per call
 * needs storing) to decide whether the caller is the account holder.
 */
export async function checkCaller(user: User, utterances: string[], attestation: string | undefined): Promise<CallerCheck> {
  const settings = user.settings;
  if ((attestation ?? '').toUpperCase() === 'A' && !settings.voiceRequirePin) {
    return { trusted: true, how: 'caller-id', pinReply: null, lockedNow: false };
  }
  const pin = settings.voicePin;
  if (!pin) return { trusted: false, how: null, pinReply: null, lockedNow: false };

  const locked = await pinLocked(user.id);
  let wrong = 0;
  let lockedNow = false;
  for (let i = 0; i < utterances.length; i++) {
    const guess = pinAttempt(utterances[i]!);
    if (!guess) continue;
    const isNewest = i === utterances.length - 1;
    const right = guess.length === pin.length && hashPin(user.id, guess).hash === pin.hash;
    if (right && !locked && wrong < MAX_WRONG_PER_CALL) {
      const name = user.name ? `, ${user.name}` : '';
      return { trusted: true, how: 'pin', pinReply: isNewest ? `Thanks${name}, you're verified. What can I do for you?` : null, lockedNow };
    }
    if (!right) {
      wrong++;
      const r = await recordWrongPin(user.id, guess);
      lockedNow ||= r.lockedNow;
    }
    if (isNewest) {
      const noMore = locked || lockedNow || wrong >= MAX_WRONG_PER_CALL;
      return {
        trusted: false,
        how: null,
        pinReply: noMore ? "Sorry, I can't take more PIN attempts right now. You can text me instead." : "That PIN didn't match. Want to try once more?",
        lockedNow,
      };
    }
  }
  return { trusted: false, how: null, pinReply: null, lockedNow };
}
