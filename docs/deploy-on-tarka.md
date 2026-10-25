# Deploy on a Tarka agent host

The whole assistant (app, Postgres with pgvector, Hindsight) runs as one custom Compose stack on a core-tier agent host: `deploy/tarka.compose.yaml`.

## What the stack uses

| Service | Image | CPU limit | Memory limit | Volume |
|---|---|---:|---:|---|
| app (web + worker) | `ghcr.io/tarkahq/tarka-assistant` | 1.0 | 1 GiB | none |
| db (Postgres 17 + pgvector) | `pgvector/pgvector:pg17` | 1.0 | 1.5 GiB | `db-data` 10 GiB |
| hindsight (memory) | `ghcr.io/vectorize-io/hindsight-api:1.0.0` | 1.5 | 3 GiB | `hf-cache` 4 GiB |
| volume-init | `busybox` | 0.05 | 32 MiB | both |

Totals: 3.55 vCPU and about 5.5 GiB of limits, inside the core tier.

* **Models need no key.** Every service reaches `http://tarka/v1`; the host's gateway adds the identity. `app` is listed under the runtime's platform services, so it also receives `TARKA_PRIMARY_MODEL` and the speech-to-text, OCR and speech models. Hindsight's own model calls (fact extraction, profile refresh) go through the same gateway.
* **Which model answers.** Replies use `default_model_alias` (as `TARKA_PRIMARY_MODEL`) unless `DEFAULT_MODEL` is set.
  - The template uses `deepseek-v4.1-flash-eu`: 24 of 24 scenarios in the October 2026 evals at 2.5 s a scenario, and the model the 25 Oct memory bake-off ran on. `glm-5.3-flash-eu` is the cheaper alternative (24 of 24 at 4.5 s).
  - `qwen3.8-flash-next` was retired on 23 Oct 2026 and answered at about 4 tokens a second; don't point anything at it.
  - Hindsight's fact extraction and reflection use `HINDSIGHT_API_LLM_MODEL`, set to the same DeepSeek alias. Expect roughly $0.20 of extraction per 125k tokens of conversation stored.
  - `ALLOWED_MODELS` is what the model picker offers. Kimi K3 is left out until the router's empty-reply fixes land.
  - See the README's eval table for the numbers.
* **No capabilities.** Postgres starts as user 999 rather than switching user from root; `volume-init` opens the fresh volumes so it can create its data directory.
* **One database.** Hindsight keeps its tables in the `hindsight` schema of the app's database.

## Steps

1. **Publish the image.** Push this repository to GitHub (e.g. `TarkaHQ/tarka-assistant`). The `ci` workflow tests it and pushes `ghcr.io/tarkahq/tarka-assistant:latest` and `:<sha>`. Either make the package public, or give the host a GitHub username and a classic PAT with `read:packages` (the agent host's *GitHub registry credentials*). Pin the `:<sha>` tag in the compose file for production.
2. **Free a host slot.** Organisations have two active agent hosts by default.
3. **Create the host** in the console (Agent Hosts → Custom Compose) or with the Control API, `POST /control/v1/orgs/{org_id}/agent-hosts` with `compose_yaml`, `variables` and `runtime.platform_services: ["app"]`. Required variables: `APP_SECRET` (`openssl rand -base64 48`), `POSTGRES_PASSWORD` (letters and digits), `HINDSIGHT_API_KEY` (`openssl rand -hex 32`; only the app can then use the memory API), and `PUBLIC_URL`.
4. **Set `PUBLIC_URL`.** The address (`https://<name>-<id>.tarka.site`) exists only after the host is created. Copy it into `PUBLIC_URL` and redeploy. Sign-in links, OAuth redirects and the Telegram webhook use it.
5. **Add channels** with the variables in [channels.md](channels.md). Telegram registers its webhook on start; Telnyx and Stripe webhooks are configured on their side to point at `PUBLIC_URL/webhooks/…`.
6. **Check it:** `PUBLIC_URL/healthz` returns `{"ok":true,"memory":true,…}` once Hindsight has downloaded its models (first start takes a few minutes).

## Operating notes

* **Limits:** `MAX_SCHEDULED_ITEMS` (60) and `MAX_TASK_RUNS_PER_DAY` (24) per person; `PROACTIVE_ENABLED=false` stops every agent-initiated turn (briefs, check-ins, tasks) while reminders still fire.
* **Restarts:** a stopping worker waits 25 seconds for running turns; anything still running is retried once after the restart. Inbound messages are handled one at a time per person, and a failed one never holds back the next.
* **Invites:** `SIGNUP_MODE=invite` by default. Add codes with SQL: `insert into invites (code, max_uses, note) values ('EARLY1', 50, 'friends');`
* **Logs:** open a terminal on the `app` service from the console; logs are JSON lines.
* **Backups:** back up the `db-data` volume; it holds conversations, schedules, encrypted tokens and every memory bank.
* **Scaling:** run `ROLE=web` and `ROLE=worker` as separate services when one process is no longer enough. Inbound messages are handled one at a time per person by the queue, so several workers are safe.
* **Per-user isolation:** this stack serves many users from one process. The roadmap's isolated-instance design (one sandboxed pod per user) would run this same image once per person with `MEMORY_ENABLED` pointing at a shared Hindsight.
