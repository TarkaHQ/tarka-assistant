# Tarka Assistant

**A personal assistant you text.** It remembers what you tell it, reminds you, keeps an eye on your calendar and email, answers questions, and will even phone a restaurant to book a table and tell you what they said. Nothing goes out — no email, no booking, no deletion, no call — until you say yes.

Tarka runs it as **Tarkendra** (invite-only for now). It is also open source under the MIT licence, so a developer can run their own copy for their own users, on a Tarka agent host or anywhere Docker runs.

## What it's like to use

- **Reach it where you already are.** The web, Telegram, SMS, WhatsApp, or a phone call. It's one conversation however you reach it: tell it something by text and it knows when you call.
- **Tell it things once.** "My sister's called Anya and she's allergic to peanuts." Months later it still knows. You can see everything it remembers and delete any of it.
- **Let it run your day.** A morning brief at 7:30, reminders ("remind me to call mum tomorrow at six"), repeating jobs ("every Monday at 8, send me my week"), a heads-up before meetings, and quiet hours so it never texts you at 3 am.
- **Connect Google.** It reads your calendar and mail, finds free slots, drafts replies, moves meetings, and looks things up in Drive.
- **Ask it to do things.** Look something up on the web, check the weather, keep a list, work out a sum exactly, or phone a business and report back.
- **Nothing goes out without you.** Sending an email, inviting someone, deleting something, placing a call or setting up a repeating job all wait for your yes. What you approve is shown to you as the software will do it, written by code rather than by the model, so it can't talk its way past you.
- **See what it costs.** An "Under the hood" page shows the model behind each reply, the tokens, the price and what it recalled. You can switch models.

## Privacy and safety, in plain words

- Your memories live in a memory bank that is yours alone. "Forget everything" empties it; deleting your account removes everything.
- The assistant never sees your sign-in links or your voice PIN. Code handles those.
- Someone who phones claiming to be you gets your assistant only if their carrier vouches for the number or they say your PIN. Otherwise they get a stranger-safe version that knows nothing about you and keeps nothing.
- Web pages and emails it reads are treated as untrusted. Instructions hidden in them can't send, delete, call or schedule anything, because those actions wait for your yes.
- Card numbers, one-time codes and passwords are removed before anything is remembered.

---

## For developers

The rest of this page is about running it yourself.

### What's in the box

One TypeScript service (web and worker, in one process or two), Postgres with pgvector, and [Hindsight](https://github.com/vectorize-io/hindsight) for long-term memory. Models, speech-to-text, OCR, text-to-speech and code sandboxes all come from Tarka. Many people share one deployment; their data is separated by user in Postgres and by memory bank in Hindsight.

```
 Telegram / SMS / WhatsApp / web / phone
            │ webhook or poll
            ▼
   inbound queue (pg-boss, one message at a time per person)
            │
            ▼
 identity → sign-up/onboarding → approval reply? ──yes/no──► execute held action
            │ no
            ▼
 media → text (Tarka speech-to-text, OCR)
            │
            ▼
 recall (Hindsight) ─┐
 profile, schedule ──┼─► agent turn (AI SDK, Tarka model, tools) ──► reply on the same channel
 recent history ─────┘                │
                                       ├─ approval-gated tools → held, ask for YES
                                       └─ retain exchange (Hindsight, async)

 worker: scheduler (reminders, tasks, brief, check-ins) · meeting nudges · call reports
```

### Run it locally

You need Docker and a Tarka API key (`tk_live_…`, from the Tarka console).

```bash
cp .env.example .env        # set TARKA_API_KEY, APP_SECRET, PUBLIC_URL=http://localhost:8080
docker compose up -d        # app, Postgres, Hindsight
open http://localhost:8080
```

For development with hot reload, run Postgres and Hindsight from `compose.yaml` and the app with `npm run dev`. Set `DEV_LOGIN=true` to sign in without an email provider (the sign-in link is shown on the page).

```bash
npm install
npm run dev            # web + worker
npm run chat           # talk to it in the terminal as a local test user (/brief, /checkin, /reset)
npm test               # unit + integration tests (needs Postgres on :5433, see vitest.config.ts)
npm run typecheck
npm run eval           # scenario evals against real Tarka models (see docs/evals.md)
```

### Deploy on a Tarka agent host

`deploy/tarka.compose.yaml` runs the whole thing — app, Postgres, Hindsight — as one custom Compose stack on a core-tier host. Inside the host no service needs a model key; the host's gateway adds the identity. Steps, variables and operating notes are in [docs/deploy-on-tarka.md](docs/deploy-on-tarka.md). The image is built by `.github/workflows/ci.yml` and published to `ghcr.io/tarkahq/tarka-assistant`. `compose.yaml` runs it anywhere with Docker.

### Channels and integrations

Setup for Telegram, SMS, WhatsApp, phone calls, Google, email sign-in, web search and billing is in [docs/channels.md](docs/channels.md). Two things take days, so start them first: **US SMS** needs 10DLC or toll-free verification before carriers deliver texts, and **Google** verification for Gmail and Drive scopes needs a security assessment (until then, up to 100 test users can be added to the OAuth consent screen).

Since 15 January 2026 Meta bars general-purpose AI assistants from the WhatsApp Business Platform; EU interim measures restored access in the EEA in June 2026, so the assistant only accepts WhatsApp users with EEA numbers (`WHATSAPP_ALLOWED_COUNTRIES`).

### How it does on Tarka's models

13 scenarios, each run twice per model, on 16 October 2026 (details and the memory bake-off in [docs/evals.md](docs/evals.md)):

| Model | Passed | Average time per scenario |
|---|---:|---:|
| deepseek-v4.1-flash | 24/24 | 2.5 s |
| glm-5.3-flash | 24/24 | 4.5 s |
| kimi-k3 | 21/24 | 6.4 s |

### Safety model

- **Approval gate.** Tools declare when they need approval (`approval()` in `src/agent/tools/*`): sending email, invitations, deletions, calls, and repeating tasks. A held action runs only on a deterministic decision in `src/agent/approvals.ts`, never on the model's say-so. The whole reply must be a yes or a no ("yes", "ok send it", "👍"); "yes, but…" or "yes I'm free Tuesday" is conversation. A bare yes counts only for the request in the assistant's newest message, sent after it, and only for things the person asked for; anything older, or raised by a scheduled task or the brief, needs its code ("yes K7PD"), a button, or the dashboard. The person sees the request as written by code (recipients, full email text, exact times, schedule); relative times are fixed when the request is made; requests never replace each other silently; scheduled tasks, the brief and check-ins can't create, change or cancel schedules without approval.
- **Untrusted content.** Web pages, emails and documents are marked as data in tool results and in the instructions.
- **Outbound fetches** from `web_read` only reach public addresses: private, loopback, link-local, metadata and IPv4-in-IPv6 forms are refused, the socket is pinned to the checked addresses (no DNS rebinding), and every redirect is checked again. The Hindsight API needs a key (`HINDSIGHT_API_KEY`).
- **Secrets.** OAuth tokens are encrypted with AES-256-GCM keyed from `APP_SECRET`; card numbers, one-time codes and passwords are redacted before anything reaches memory.
- **Webhooks** are verified: Telnyx (Ed25519), Telegram (secret token, derived from `APP_SECRET` when not set), Stripe (signature). Redelivered webhooks are queued once.
- **Sign-in links** are sent by code (the model never sees them) and open a confirmation page that names the account by its email, phone or chat, never its editable name; only its button uses the link (link previews can't), and it only continues to this site's own pages. Connecting Google needs a 6-digit code sent to the account's own chat, phone or email, typed in the same browser, and the OAuth callback only completes for that browser session. A channel address (a Telegram chat, a number) is never moved from one account to another.
- **Phone calls.** Caller ID can be faked, so a call gets the person's memory, schedule and tools only when the carrier vouches for the number (STIR/SHAKEN "A") or they say their voice PIN (6–8 digits, checked in code, never seen by the model; 3 tries per call, 5 wrong PINs a day, 10 a week; every wrong PIN is texted to the account holder; counted under a database lock). Otherwise a restricted assistant answers general questions and stores nothing. Calls never get email or Drive tools and can't approve anything: approvals are texted.
- **Limits.** Reminders repeat at most every 15 minutes, tasks at most hourly; per person, 60 scheduled items, 24 task runs and 48 reminder texts a day (`MAX_SCHEDULED_ITEMS`, `MAX_TASK_RUNS_PER_DAY`, `MAX_REMINDERS_PER_DAY`). Someone who picks a pricier model goes back to the default model for the rest of the month after a set spend (`MODEL_BUDGET_USD_PER_MONTH`, $8 by default).
- **Retries.** A message interrupted by a restart is retried once; if it was already answered it isn't answered again, and an aborted turn stops instead of apologising.
- **Deletion.** "Forget everything" deletes the memory bank; deleting the account cancels the subscription, then removes all rows (cascade) and the bank.

### Layout

```
src/agent/          turn runner, prompt, approvals, tools (memory, schedule, lists, web, weather,
                    settings, google, phone, code)
src/channels/       inbound pipeline, delivery, formatting, Telegram, Telnyx SMS/WhatsApp
src/voice/          OpenAI-compatible endpoint used by Telnyx AI Assistants (custom LLM)
src/memory/         Hindsight: bank per user, recall, retain, profile, forget
src/proactive/      scheduler, morning brief, check-ins, meeting nudges, call reports
src/integrations/   Google, Telnyx, email (Brevo)
src/web/            dashboard (Hono JSX), JSON API, sessions
src/models/         Tarka chat, speech, OCR and sandbox clients
migrations/         Postgres schema
deploy/             Tarka agent host compose
docs/               channels, deploy, evals
scripts/            Telnyx setup, evals
```

### Known limits

- A web page or email can still try to steer the model within a turn (for example, to put private details into a `web_read` URL). The actions that matter are gated; reading the web isn't.
- Reply streaming on the phone is sentence-chunked after generation, not token streaming.
- The memory model calls (fact extraction, profile refresh) are billed to the deployment, not shown per user yet.
- One shared process handles all users. A one-instance-per-user layout for privacy-sensitive deployments is planned but not built.

## Licence

MIT. See [LICENSE](LICENSE).
