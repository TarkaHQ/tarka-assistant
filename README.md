# Tarka Assistant

A personal assistant people text. It remembers them, reminds them, works through their calendar and email, and phones businesses for them. It asks before it sends, invites, deletes or calls anything. It runs on Tarka: open models from Tarka's router, long-term memory from [Hindsight](https://github.com/vectorize-io/hindsight), and Tarka sandboxes for exact calculations.

It is built as the example a non-technical person can try in a minute (sign up, start texting, look under the hood) and as an open template a developer can deploy for their own users on a Tarka agent host.

## What it does

| | |
|---|---|
| **Reach it anywhere** | Web chat, Telegram (one shared bot), SMS and WhatsApp through Telnyx, and phone calls through Telnyx AI Assistants. One continuous conversation across all of them. |
| **Remembers** | One Hindsight memory bank per person. Every exchange is retained; relevant memories are recalled before each reply; a profile ("About you") is kept up to date. People can see and delete what it remembers. |
| **Reminds and follows up** | Reminders (one-off or repeating), scheduled tasks it runs itself ("every Monday at 8, send me my week"), a morning brief, check-ins, and meeting heads-ups. Quiet hours and a daily cap. |
| **Works through your accounts** | Google Calendar (list, free slots, create, move, delete), Gmail (search, read, draft, send), Drive (search, read Docs/Sheets/Slides) and Contacts. |
| **Acts in the world** | Web search and reading, weather, lists, exact calculations in a Tarka sandbox, and concierge phone calls to businesses with a report back. |
| **Asks first** | Anything that sends, invites, deletes or calls, and any repeating task, is held as an approval. The person sees a summary written by code (not the model) and only a plain YES, a button, or "yes CODE" executes it. The model can't approve its own actions. |
| **Shows its work** | Each reply records model, tokens, cost, memory recall and tools. The "Under the hood" page shows this and lets people switch models. |

## How a message flows

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

Everything is one TypeScript service (`ROLE=all`, or `web` and `worker` separately) plus Postgres (pgvector) and Hindsight. Users share the service; their data is separated by user id in Postgres and by memory bank in Hindsight.

## Run it locally

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
npm run eval           # scenario evals against real Tarka models (needs TARKA_API_KEY; see scripts/evals.ts)
```

## How it does on Tarka's models

`npm run eval` runs 13 scenarios through the real pipeline: sign-up, reminders, lists, calendar, email with approval, an injected instruction in an email, a repeating task, the morning brief, a quiet check-in and an unverified caller. Messages go to the real models; Google and the chat channels are faked.

Each scenario ran twice per model, on 16 October 2026:

| Model | Passed | Average time per scenario | Cost of the run |
|---|---:|---:|---:|
| qwen3.8-flash-next | 23/24 | 37.4 s | $0 (no charge today) |
| deepseek-v4.1-flash | 24/24 | 2.5 s | $0.032 |
| glm-5.3-flash | 24/24 | 4.5 s | $0.025 |
| kimi-k3 | 24/24 | 6.2 s | $0.31 |

- **Qwen:** its one miss was a check-in that hit the 150-second limit. Qwen generated about 28 tokens a second in these runs.
- **Kimi K3:** it needed the empty-reply retry in `src/agent/turn.ts` to get there.
- **Before the fixes found by the first run,** the same scenarios passed 18, 20, 19 and 13 times out of 24. The first run turned up:
  - a calendar bug: "tomorrow" was read as 9 AM to 9 AM;
  - Kimi's empty and garbled replies;
  - models asking "shall I send it?" before calling a tool that already asks.

## Deploy

* **Tarka agent host:** `deploy/tarka.compose.yaml` — see [docs/deploy-on-tarka.md](docs/deploy-on-tarka.md).
* **Anywhere with Docker:** `compose.yaml`.
* The image is built by `.github/workflows/ci.yml` and published to `ghcr.io/<owner>/tarka-assistant`.

## Channels and integrations

Setup steps for Telegram, SMS, WhatsApp, phone calls, Google, email sign-in, search and billing are in [docs/channels.md](docs/channels.md). Two things take days, so start them first:

* **US SMS** needs 10DLC or toll-free verification before carriers deliver texts.
* **Google** verification for Gmail and Drive scopes (restricted scopes need a security assessment). Until then, up to 100 test users can be added to the OAuth consent screen.

WhatsApp: since 15 January 2026 Meta bars general-purpose AI assistants from the WhatsApp Business Platform. EU interim measures restored access in the EEA (June 2026), so the assistant only accepts WhatsApp users with EEA numbers (`WHATSAPP_ALLOWED_COUNTRIES`).

## Safety model

* **Approval gate:** tools declare when they need approval (`approval()` in `src/agent/tools/*`): sending email, invitations, deletions, calls, and repeating tasks. A held action runs only on a deterministic decision (`src/agent/approvals.ts`), never on the model's say-so:
  * the whole reply must be a yes or a no ("yes", "ok send it", "👍"); "yes, but…", "yes I'm free Tuesday" or "yes?" are conversation;
  * a bare yes counts only for the request(s) in the assistant's newest message, only if it was sent after that message, and only for things the person asked for; anything older, or raised by a scheduled task or the brief, needs its code ("yes K7PD"), a button, or the dashboard;
  * under the model's reply, the person sees the request as written by code (recipients, full email text, exact times, schedule), so a model that misdescribes an action can't get it approved. Relative times ("tomorrow 1pm") are fixed when the request is made, so a later yes does exactly what was shown;
  * requests never replace each other silently; scheduled tasks, the brief and check-ins can't create, change or cancel schedules without approval.
* **Untrusted content:** web pages, emails and documents are marked as data in tool results and in the instructions.
* **Outbound fetches** from `web_read` only reach public addresses: private, loopback, link-local, metadata and IPv4-in-IPv6 forms are refused, the socket is pinned to the checked addresses (no DNS rebinding), and every redirect is checked again. The Hindsight API needs a key (`HINDSIGHT_API_KEY`).
* **Secrets:** OAuth tokens are encrypted with AES-256-GCM keyed from `APP_SECRET`; card numbers, one-time codes and passwords are redacted before anything reaches memory.
* **Webhooks** are verified: Telnyx (Ed25519), Telegram (secret token, derived from `APP_SECRET` when not set), Stripe (signature). Redelivered webhooks are queued once.
* **Sign-in links** are sent to the person by code (the model never sees them) and open a confirmation page that names the account by its email, phone or chat, never its editable name; only its button uses the link (link previews can't), and it only continues to this site's own pages. **Connecting Google** needs a 6-digit code sent to the account's own chat, phone or email, typed in the same browser, and the OAuth callback only completes for that browser session, so a forwarded link can't attach one person's Google account to another person's assistant. A channel address (a Telegram chat, a number) is never moved from one account to another.
* **Phone calls:** caller ID can be faked, so a call gets the person's memory, schedule and tools only when their carrier vouches for the number (STIR/SHAKEN "A") or they say their voice PIN (6–8 digits, checked in code, never seen by the model; 3 tries per call, 5 wrong PINs a day, 10 a week before it needs resetting; every wrong PIN is texted to the account holder; counted under a database lock so parallel calls get no extra tries). Otherwise a restricted assistant answers general questions and stores nothing (it doesn't even know the account holder's city or timezone). Calls never get email or Drive tools and can't approve anything: approvals are texted.
* **Limits:** reminders repeat at most every 15 minutes, tasks at most hourly; per person, 60 scheduled items, 24 task runs and 48 reminder texts a day (`MAX_SCHEDULED_ITEMS`, `MAX_TASK_RUNS_PER_DAY`, `MAX_REMINDERS_PER_DAY`). Someone who picks a pricier model in "Under the hood" goes back to the default model for the rest of the month after $8 of model spend (`MODEL_BUDGET_USD_PER_MONTH`), so the $20 plan keeps its margin.
* **Retries:** a message interrupted by a restart is retried once; if it was already answered it isn't answered again, and an aborted turn stops instead of apologising.
* **Deletion:** "Forget everything" deletes the memory bank; deleting the account cancels the subscription, then removes all rows (cascade) and the bank.

## Layout

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
scripts/            Telnyx setup
```

## Known limits

* Prompt injection: a web page or email can still try to steer the model within a turn (for example, to put private details into a `web_read` URL). Sending, inviting, deleting, calling and repeating tasks are gated, but reading the web isn't.
* Reply streaming on the phone is sentence-chunked after generation, not token streaming.
* The memory model calls (fact extraction, profile refresh) are billed to the deployment, not shown per user yet.
* One shared process handles all users; the per-user isolated-instance design for privacy-sensitive customers is in Tarka's roadmap notes (`isolated-user-agents`).
