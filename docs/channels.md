# Channels and integrations

Everything here is optional except a Tarka model key. Each channel plugs into the same agent; enabling one doesn't change the others.

| Channel | Needs | Lead time |
|---|---|---|
| Web chat | nothing | none |
| Telegram | a bot token | minutes |
| Phone calls | Telnyx number + two AI Assistants | an hour |
| SMS (US) | Telnyx number + 10DLC or toll-free verification | days to weeks |
| SMS (elsewhere) | Telnyx number; country rules vary | varies |
| WhatsApp (EEA only) | Telnyx WhatsApp sender + Meta business verification + one template | days |
| Google | OAuth client; verification for restricted scopes | test users now, weeks for verification |

## Telegram

1. In Telegram, message **@BotFather** → `/newbot` → pick a name and a username ending in `bot`.
2. Set `TELEGRAM_BOT_TOKEN` and a random `TELEGRAM_WEBHOOK_SECRET`.
3. In production the app registers `PUBLIC_URL/webhooks/telegram` itself on start. In development it long-polls (no public URL needed).
4. Optional, in BotFather: `/setdescription`, `/setuserpic`, and `/setcommands` with `dashboard - Open your dashboard`.

People can start straight from the bot (it signs them up), or link an existing web account from the dashboard ("Connect" under *Reach … on*), which opens `t.me/<bot>?start=<code>`.

## Telnyx: one number for SMS and calls

1. Buy a number in the Telnyx portal (a toll-free number is usually the fastest route to US texting).
2. Set `PUBLIC_URL`, `TELNYX_API_KEY` and a random `VOICE_LLM_SECRET`, then run:

   ```bash
   npx tsx --env-file=.env scripts/telnyx-setup.ts          # dry run
   npx tsx --env-file=.env scripts/telnyx-setup.ts --apply
   ```

   It creates a messaging profile (webhooks to `/webhooks/telnyx/messaging`), an integration secret for `VOICE_LLM_SECRET`, and two AI Assistants whose custom LLM is this app (`PUBLIC_URL/voice/v1`). It prints the ids to put in your environment. It never buys numbers.
3. In the portal, assign the number to the messaging profile, and to the **inbound** assistant's TeXML app so calls reach it.
4. Copy the portal's webhook public key (Keys & Credentials → Public Key) into `TELNYX_PUBLIC_KEY`. Unsigned webhooks are rejected in production.
5. Set `TELNYX_PHONE_NUMBER`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_VOICE_ASSISTANT_ID`, `TELNYX_CONCIERGE_ASSISTANT_ID`.

### US texting registration

US carriers block application-to-person texts from unregistered numbers.

* **Toll-free verification** (toll-free numbers): one form in the portal. Use case: *"Personal AI assistant. Users opt in by texting the number first or by entering their number on our site; the assistant replies to their requests and sends reminders they schedule. STOP/HELP supported."* Include the sign-up page URL and sample messages.
* **10DLC** (local numbers): register the brand (Tarka's legal name, EIN, address, website), then a campaign (use case *Mixed* or *Customer care*) with the same description, opt-in flow and samples.

STOP, UNSUBSCRIBE and similar words mark the number as opted out; nothing is sent until the person texts START.

### Phone calls

* **Calling it:** people ring the number; the inbound assistant answers and sends each turn to `/voice/v1/chat/completions` with the caller's number in `extra_metadata`. Known callers get their assistant with memory and tools (no email or Drive on calls, since caller ID can be spoofed). Anything that needs approval is texted to them to confirm.
* **It calls businesses:** the `call_business` tool (approval required) schedules a call from the concierge assistant. During the call this app plays the role of a polite AI caller with the objective, keeps the transcript, and when the call ends texts the user a summary.

## WhatsApp

Meta has barred general-purpose AI assistants from the WhatsApp Business Platform since 15 January 2026. The European Commission's interim measures (June 2026) restored access in the EEA, so this app only signs up WhatsApp users with EEA numbers (`WHATSAPP_ALLOWED_COUNTRIES`, default: the EEA). The order is preliminary; check its status before relying on it.

1. Portal → Messaging → WhatsApp → Connect WhatsApp Business Account (Meta Business Manager, business verification).
2. Use a Telnyx number with the messaging profile above; set `TELNYX_WHATSAPP_NUMBER`.
3. Create a *utility* template with one body variable (e.g. "Your assistant: {{1}}") and set `TELNYX_WHATSAPP_TEMPLATE`. It's used only for messages outside WhatsApp's 24-hour window (morning briefs, reminders); without it those go to another channel.

## Google (Gmail, Calendar, Drive, Contacts)

1. Google Cloud console → create a project → enable Gmail, Calendar, Drive and People APIs.
2. OAuth consent screen: external, app name, support email, scopes:
   `calendar`, `gmail.modify`, `drive.readonly`, `contacts.readonly`, `contacts.other.readonly` (+ `openid email profile`).
3. Credentials → OAuth client ID → Web application → redirect URI `PUBLIC_URL/oauth/google/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. While the app is in *testing*, add up to 100 test users. Publishing with `gmail.modify` and `drive.readonly` (restricted scopes) needs Google's verification and an annual security assessment; start early, or ship calendar-only first.

People connect from Settings or by asking the assistant ("connect my Google").

## Sign-in emails (Brevo)

Set `BREVO_API_KEY` and `EMAIL_FROM` (a sender verified in Brevo). Without it, sign-in links are only shown on the page when `DEV_LOGIN=true` (development only).

## Web search

Set one of `BRAVE_API_KEY`, `TAVILY_API_KEY` or `SEARXNG_URL`. Without a provider the assistant can still read pages people send it.

## Billing (Stripe)

1. Create a product with a monthly recurring price (e.g. $20) and set `STRIPE_PRICE_ID`.
2. Webhook endpoint `PUBLIC_URL/webhooks/stripe` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`; set `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_SECRET_KEY`. When billing is configured, a trial that has ended stops the assistant and sends an upgrade link.

## Code sandboxes

`run_python` uses Tarka sandboxes. Set `TARKA_ORG_ID`; the `TARKA_API_KEY` must include the `sandboxes` scope.
