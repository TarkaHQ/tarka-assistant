import type { FC } from 'hono/jsx';
import { config } from '../../config.js';
import { Layout, Logo } from './layout.js';

export const Landing: FC<{ telegramUrl: string | null; smsNumber: string | null; whatsappNumber: string | null; phoneCalls: boolean }> = ({ telegramUrl, smsNumber, whatsappNumber, phoneCalls }) => {
  const cfg = config();
  return (
    <Layout title={`${cfg.product.productName} — a personal assistant you text`} ridge>
      <header class="shell" style="padding-top:22px;display:flex;justify-content:space-between;align-items:center">
        <Logo />
        <a href="/login" class="btn secondary small">
          Sign in
        </a>
      </header>
      <main class="shell">
        <section class="hero">
          <div>
            <h1>A personal assistant you text.</h1>
            <p class="lede">
              Tell it what you need in a message. It remembers your people and preferences, reminds you before things slip, keeps your lists and works
              through your calendar and email. It asks before it sends anything{phoneCalls ? ' or calls anyone' : ''}.
            </p>
            <div class="ctas">
              {telegramUrl ? (
                <a class="btn" href={telegramUrl}>
                  Message it on Telegram
                </a>
              ) : null}
              {smsNumber ? (
                <a class={telegramUrl ? 'btn secondary' : 'btn'} href={`sms:${smsNumber}`}>
                  Text {smsNumber}
                </a>
              ) : null}
              {whatsappNumber ? (
                <a class="btn secondary" href={`https://wa.me/${whatsappNumber.replace(/\D/g, '')}`}>
                  WhatsApp (EU)
                </a>
              ) : null}
              <a class={telegramUrl || smsNumber ? 'btn secondary' : 'btn'} href="/login">
                Use it on the web
              </a>
            </div>
            <p class="fine">
              Free for {cfg.product.trialDays} days, then {cfg.product.priceLabel}. Cancel any time.
            </p>
          </div>
          <div class="phone" role="img" aria-label="Example conversation with the assistant">
            <div class="bar">{cfg.product.assistantName}</div>
            <div class="bubble time">Mon 7:30 AM</div>
            <div class="bubble it">Morning, Priya. Dentist at 11:15 (leave by 10:50, it’s raining) and your call with Arun at 3. You still owe Sam the deck from Friday. Want me to draft the email?</div>
            <div class="bubble me">yes, and remind me to buy flowers for mum on the way home</div>
            <div class="bubble it">Draft is in your Gmail. Reminder set for 5:45 PM. Shall I send the email to Sam now?</div>
            <div class="bubble me">yes</div>
            <div class="bubble it">Sent.</div>
          </div>
        </section>

        <section class="points" aria-label="What it does">
          <div class="point">
            <h3>It remembers</h3>
            <p>Names, birthdays, the restaurant you didn’t like, what you promised whom. You can see everything it remembers, and delete any of it.</p>
          </div>
          <div class="point">
            <h3>It follows up</h3>
            <p>A short brief each morning, a heads-up before meetings, reminders when you ask, and the follow-ups it promised. Quiet hours are respected.</p>
          </div>
          <div class="point">
            <h3>It asks first</h3>
            <p>Anything that sends an email, invites people{phoneCalls ? ', calls a business' : ''} or deletes something waits for your yes. Every action is logged.</p>
          </div>
        </section>

        <section class="band price-line">
          <div>
            <h2>Runs on Tarka</h2>
            <p style="max-width:60ch;margin-top:6px">
              Open models served by Tarka, long-term memory kept separately for each person, and an isolated sandbox for exact calculations. Each reply shows
              the model, tokens and cost behind it. Developers can deploy their own version on{' '}
              <a href="https://tarkahq.com">Tarka</a>.
            </p>
          </div>
          <a class="btn" href="/login">
            Start your free trial
          </a>
        </section>
      </main>
      <footer class="foot shell">
        {cfg.product.productName} by Tarka · <a href="https://tarkahq.com">tarkahq.com</a>
      </footer>
    </Layout>
  );
};

export const LoginPage: FC<{ next?: string; error?: string; invite: boolean; email?: string }> = ({ next, error, invite, email }) => (
  <Layout title="Sign in" ridge>
    <header class="shell" style="padding-top:22px">
      <Logo />
    </header>
    <main class="shell auth">
      <h1>Sign in or start</h1>
      <p>We’ll email you a link. No password needed.</p>
      {error ? <div class="notice warn">{error}</div> : null}
      <form method="post" action="/login">
        <input type="hidden" name="next" value={next ?? '/app'} />
        <div class="field">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" required autocomplete="email" value={email ?? ''} />
        </div>
        {invite ? (
          <div class="field">
            <label for="invite">Invite code</label>
            <input id="invite" name="invite" type="text" autocomplete="off" />
            <p class="hint">Only needed the first time.</p>
          </div>
        ) : null}
        <button class="btn" type="submit">
          Email me a sign-in link
        </button>
      </form>
    </main>
  </Layout>
);

export const LoginSent: FC<{ email: string; devLink?: string | null }> = ({ email, devLink }) => (
  <Layout title="Check your email" ridge>
    <header class="shell" style="padding-top:22px">
      <Logo />
    </header>
    <main class="shell auth">
      <h1>Check your email</h1>
      <p>
        We sent a sign-in link to <strong>{email}</strong>. It works once, for 20 minutes.
      </p>
      {devLink ? (
        <div class="notice">
          Development mode: <a href={devLink}>sign in directly</a>
        </div>
      ) : null}
    </main>
  </Layout>
);

/**
 * Sign-in links open this page; the button (a POST) uses up the link. Link previews and mail
 * scanners only fetch pages, so they can't spend it, and the page says which account it is for.
 */
export const SignInConfirm: FC<{ token: string; next: string; account: string; connectGoogle: boolean; startUrl?: string }> = ({ token, next, account, connectGoogle, startUrl }) => (
  <Layout title="Sign in" ridge>
    <header class="shell" style="padding-top:22px">
      <Logo />
    </header>
    <main class="shell auth">
      <h1>{connectGoogle ? 'Connect Google' : 'Sign in'}</h1>
      <p>
        {connectGoogle ? 'You’re connecting Google to the assistant account of ' : 'You’re signing in as '}
        <strong>{account}</strong>.
      </p>
      {connectGoogle ? <p class="hint">Only continue if this is your account. Google will ask which of your Google accounts to use.</p> : null}
      <form method="post" action={startUrl ?? `/auth/${encodeURIComponent(token)}`}>
        <input type="hidden" name="next" value={next} />
        <button class="btn" type="submit">
          {connectGoogle ? 'Continue to Google' : 'Sign in'}
        </button>
      </form>
    </main>
  </Layout>
);

export const SimpleMessage: FC<{ title: string; body: string; href?: string; cta?: string }> = ({ title, body, href, cta }) => (
  <Layout title={title} ridge>
    <header class="shell" style="padding-top:22px">
      <Logo />
    </header>
    <main class="shell auth">
      <h1>{title}</h1>
      <p>{body}</p>
      {href ? (
        <a class="btn" href={href}>
          {cta ?? 'Continue'}
        </a>
      ) : null}
    </main>
  </Layout>
);
