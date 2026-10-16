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
| **Asks first** | Anything that sends, invites, deletes or calls is held as an approval. Only a short yes/no from the person's own channel, or a dashboard button, executes it. The model can't approve its own actions. |
| **Shows its work** | Each reply records model, tokens, cost, memory recall and tools. The "Under the hood" page shows this and lets people switch models. |

## How a message flows

```
 Telegram / SMS / WhatsApp / web / phone
            │ webhook or poll
            ▼
   inbound queue (pg-boss, FIFO per person)
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
```

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

* **Approval gate:** tools declare when they need approval (`approval()` in `src/agent/tools/*`). Held actions execute only on a deterministic yes/no from the user's own channel (`src/agent/approvals.ts`), never on the model's say-so. A second "yes" can't run an action twice.
* **Untrusted content:** web pages, emails and documents are marked as data in tool results and in the instructions.
* **Outbound fetches** from `web_read` refuse private, loopback, link-local and metadata addresses, re-checked on each redirect.
* **Secrets:** OAuth tokens are encrypted with AES-256-GCM keyed from `APP_SECRET`; card numbers, one-time codes and passwords are redacted before anything reaches memory.
* **Webhooks** are verified: Telnyx (Ed25519), Telegram (secret token), Stripe (signature).
* **Voice caller ID can be spoofed.** Phone calls can't approve actions, and the inbound phone agent gets no email or Drive tools.
* **Deletion:** "Forget everything" deletes the memory bank; deleting the account removes all rows (cascade) and the bank.

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

* Inbound phone calls identify the person by caller ID only.
* Reply streaming on the phone is sentence-chunked after generation, not token streaming.
* The memory model calls (fact extraction, profile refresh) are billed to the deployment, not shown per user yet.
* One shared process handles all users; the per-user isolated-instance design for privacy-sensitive customers is in Tarka's roadmap notes (`isolated-user-agents`).
