-- Where an approval request came from: a person's own message (a bare YES may answer it) or an
-- unprompted turn such as a scheduled task or the morning brief (it needs its code or a button).
alter table approvals add column origin text not null default 'message';

-- Wrong voice PINs, one row per distinct guess (Telnyx resends the whole call each turn, so the
-- same guess must count once). Checked and written under a per-user advisory lock.
create table voice_pin_failures (
  user_id uuid not null references users (id) on delete cascade,
  guess_hash text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, guess_hash)
);
create index voice_pin_failures_recent on voice_pin_failures (user_id, created_at);
