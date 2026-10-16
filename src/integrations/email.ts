import { config } from '../config.js';
import { log } from '../log.js';

/** Transactional email through Brevo (Tarka's existing sender). */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const cfg = config().email;
  if (!cfg.brevoKey) {
    log.info({ to, subject }, 'email not configured; skipped');
    return false;
  }
  const m = /^(.*)<([^>]+)>\s*$/.exec(cfg.from);
  const sender = m ? { name: m[1]!.trim(), email: m[2]!.trim() } : { email: cfg.from };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, ...(html ? { htmlContent: html } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'email send failed');
    return false;
  }
  return true;
}
