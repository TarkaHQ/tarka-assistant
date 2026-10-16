-- Tarka Assistant: initial schema.
-- One shared database for every end user. Each user's rows hang off users.id and are
-- deleted with it (ON DELETE CASCADE). Long-term memory lives in Hindsight, one bank per user.

create table users (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  status                 text not null default 'onboarding'
                           check (status in ('onboarding', 'active', 'paused', 'deleted')),
  name                   text,
  email                  text unique,
  phone                  text unique,                 -- E.164
  timezone               text not null default 'UTC',
  locale                 text not null default 'en',
  city                   text,
  assistant_name         text,                        -- what the user calls their assistant
  plan                   text not null default 'trial'
                           check (plan in ('trial', 'pro', 'free', 'staff')),
  trial_ends_at          timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    text,
  model                  text,                        -- preferred model alias; null = default
  settings               jsonb not null default '{}'::jsonb,
  profile_summary        text,                        -- cached Hindsight mental model
  profile_refreshed_at   timestamptz,
  memory_bank            text,
  last_active_at         timestamptz,
  last_channel           text
);

create table identities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  channel          text not null,                     -- sms | whatsapp | telegram | web | voice | email
  external_id      text not null,                     -- E.164 number, Telegram chat id, email address
  display          text,
  verified_at      timestamptz,
  last_inbound_at  timestamptz,
  opted_out_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (channel, external_id)
);
create index identities_user_idx on identities (user_id);

create table messages (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  role        text not null check (role in ('user', 'assistant', 'event')),
  channel     text not null,
  content     text not null,
  meta        jsonb not null default '{}'::jsonb
);
create index messages_user_idx on messages (user_id, id desc);

create table routines (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  kind           text not null check (kind in ('reminder', 'task', 'brief', 'checkin', 'followup', 'watch')),
  title          text not null,
  instructions   text,
  schedule_type  text not null check (schedule_type in ('once', 'cron')),
  run_at         timestamptz,
  cron           text,                                -- 5-field cron, evaluated in `timezone`
  timezone       text not null default 'UTC',
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  status         text not null default 'active' check (status in ('active', 'paused', 'done', 'cancelled')),
  created_by     text not null default 'user' check (created_by in ('user', 'agent', 'system')),
  channel        text,
  meta           jsonb not null default '{}'::jsonb,
  run_count      int not null default 0,
  created_at     timestamptz not null default now()
);
create index routines_due_idx on routines (next_run_at) where status = 'active';
create index routines_user_idx on routines (user_id);

create table approvals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  short_code  text not null,
  tool        text not null,
  input       jsonb not null,
  summary     text not null,
  status      text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  channel     text,
  result      jsonb,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  decided_at  timestamptz
);
create index approvals_user_idx on approvals (user_id, status);

create table audit_log (
  id          bigserial primary key,
  user_id     uuid references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  actor       text not null,                          -- agent | user | system
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);
create index audit_user_idx on audit_log (user_id, id desc);

create table usage_events (
  id                   bigserial primary key,
  user_id              uuid references users(id) on delete cascade,
  created_at           timestamptz not null default now(),
  purpose              text not null,                 -- chat | proactive | onboarding | voice | utility
  model                text not null,
  input_tokens         int not null default 0,
  cached_input_tokens  int not null default 0,
  output_tokens        int not null default 0,
  cost_micro_usd       bigint not null default 0,
  latency_ms           int,
  steps                int
);
create index usage_user_idx on usage_events (user_id, created_at desc);

create table integrations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  provider           text not null,                   -- google
  account            text,
  scopes             text[] not null default '{}',
  access_token_enc   text,
  refresh_token_enc  text,
  expires_at         timestamptz,
  status             text not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, provider)
);

create table lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

create table list_items (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references lists(id) on delete cascade,
  text        text not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index list_items_list_idx on list_items (list_id);

create table login_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  user_id     uuid references users(id) on delete cascade,
  email       text,
  purpose     text not null,                          -- login
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  user_id       uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz
);

create table link_codes (
  code        text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table calls (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  direction         text not null check (direction in ('inbound', 'outbound')),
  to_number         text,
  from_number       text,
  objective         text,
  status            text not null default 'queued',
  provider_call_id  text,
  transcript        text,
  summary           text,
  created_at        timestamptz not null default now(),
  ended_at          timestamptz,
  meta              jsonb not null default '{}'::jsonb
);
create index calls_user_idx on calls (user_id, created_at desc);
create index calls_provider_idx on calls (provider_call_id);

create table nudges_sent (
  user_id     uuid not null references users(id) on delete cascade,
  key         text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, key)
);

create table invites (
  code        text primary key,
  max_uses    int not null default 1,
  uses        int not null default 0,
  note        text,
  created_at  timestamptz not null default now()
);

create table kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
