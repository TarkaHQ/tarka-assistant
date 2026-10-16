import { db } from './index.js';
import type {
  Approval,
  CallRow,
  ChannelName,
  Identity,
  Integration,
  MessageRow,
  Routine,
  RoutineKind,
  UsageRow,
  User,
  UserSettings,
} from './types.js';
import { APPROVAL_CODE_ALPHABET, shortCode, sha256 } from '../util/crypto.js';

type Json = Parameters<ReturnType<typeof db>['json']>[0];
const j = (v: unknown) => db().json(v as Json);

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

export interface NewUser {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  timezone?: string;
  locale?: string;
  plan?: User['plan'];
  trialDays?: number;
  settings?: UserSettings;
  status?: User['status'];
}

export const users = {
  async create(input: NewUser): Promise<User> {
    const sql = db();
    const trialEnds = input.trialDays ? new Date(Date.now() + input.trialDays * 86_400_000) : null;
    const [row] = await sql<User[]>`
      insert into users (name, email, phone, timezone, locale, plan, trial_ends_at, settings, status)
      values (${input.name ?? null}, ${input.email?.toLowerCase() ?? null}, ${input.phone ?? null},
              ${input.timezone ?? 'UTC'}, ${input.locale ?? 'en'}, ${input.plan ?? 'trial'}, ${trialEnds},
              ${j(input.settings ?? {})}, ${input.status ?? 'onboarding'})
      returning *`;
    return row!;
  },

  async get(id: string): Promise<User | null> {
    const [row] = await db()<User[]>`select * from users where id = ${id}`;
    return row ?? null;
  },

  async byEmail(email: string): Promise<User | null> {
    const [row] = await db()<User[]>`select * from users where email = ${email.toLowerCase()}`;
    return row ?? null;
  },

  async byPhone(phone: string): Promise<User | null> {
    const [row] = await db()<User[]>`select * from users where phone = ${phone}`;
    return row ?? null;
  },

  async update(id: string, patch: Partial<Omit<User, 'id' | 'created_at' | 'settings'>>): Promise<User> {
    const sql = db();
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return (await users.get(id))!;
    const values = Object.fromEntries(entries);
    const [row] = await sql<User[]>`
      update users set ${sql(values as Record<string, string>, Object.keys(values))}, updated_at = now()
      where id = ${id} returning *`;
    return row!;
  },

  /** Shallow-merges settings. */
  async updateSettings(id: string, patch: Partial<UserSettings>): Promise<User> {
    const [row] = await db()<User[]>`
      update users set settings = settings || ${j(patch)}, updated_at = now() where id = ${id} returning *`;
    return row!;
  },

  async touch(id: string, channel: ChannelName): Promise<void> {
    await db()`update users set last_active_at = now(), last_channel = ${channel} where id = ${id}`;
  },

  async listActive(limit = 500, afterId?: string): Promise<User[]> {
    return db()<User[]>`
      select * from users where status = 'active' and (${afterId ?? null}::uuid is null or id > ${afterId ?? null}::uuid)
      order by id limit ${limit}`;
  },

  async delete(id: string): Promise<void> {
    await db()`delete from users where id = ${id}`;
  },
};

// ---------------------------------------------------------------------------------------------
// Identities (one per channel address)
// ---------------------------------------------------------------------------------------------

export class IdentityTaken extends Error {
  constructor(public channel: ChannelName) {
    super(`This ${channel} address is already connected to another account`);
  }
}

export const identities = {
  async find(channel: ChannelName, externalId: string): Promise<Identity | null> {
    const [row] = await db()<Identity[]>`
      select * from identities where channel = ${channel} and external_id = ${externalId}`;
    return row ?? null;
  },

  /**
   * Attaches a channel address to a user. An address that already belongs to someone else is never
   * moved (that would hand their conversation to another account): it throws IdentityTaken.
   */
  async create(userId: string, channel: ChannelName, externalId: string, display?: string | null, verified = true): Promise<Identity> {
    const [row] = await db()<Identity[]>`
      insert into identities (user_id, channel, external_id, display, verified_at)
      values (${userId}, ${channel}, ${externalId}, ${display ?? null}, ${verified ? new Date() : null})
      on conflict (channel, external_id) do update set display = coalesce(excluded.display, identities.display),
        verified_at = coalesce(identities.verified_at, excluded.verified_at)
      where identities.user_id = excluded.user_id
      returning *`;
    if (!row) throw new IdentityTaken(channel);
    return row;
  },

  async forUser(userId: string): Promise<Identity[]> {
    return db()<Identity[]>`select * from identities where user_id = ${userId} order by created_at`;
  },

  async markInbound(id: string): Promise<void> {
    await db()`update identities set last_inbound_at = now(), opted_out_at = null where id = ${id}`;
  },

  async optOut(channel: ChannelName, externalId: string): Promise<void> {
    await db()`update identities set opted_out_at = now() where channel = ${channel} and external_id = ${externalId}`;
  },

  async remove(userId: string, id: string): Promise<void> {
    await db()`delete from identities where id = ${id} and user_id = ${userId}`;
  },
};

// ---------------------------------------------------------------------------------------------
// Conversation (one continuous thread per user, across channels)
// ---------------------------------------------------------------------------------------------

export const messages = {
  async add(userId: string, role: MessageRow['role'], channel: ChannelName, content: string, meta: Record<string, unknown> = {}): Promise<MessageRow> {
    const [row] = await db()<MessageRow[]>`
      insert into messages (user_id, role, channel, content, meta)
      values (${userId}, ${role}, ${channel}, ${content}, ${j(meta)}) returning *`;
    return row!;
  },

  /** Most recent messages, oldest first. */
  async recent(userId: string, limit = 40): Promise<MessageRow[]> {
    const rows = await db()<MessageRow[]>`
      select * from messages where user_id = ${userId} order by id desc limit ${limit}`;
    return rows.reverse();
  },

  async page(userId: string, beforeId: number | null, limit = 50): Promise<MessageRow[]> {
    const rows = await db()<MessageRow[]>`
      select * from messages where user_id = ${userId} and (${beforeId}::bigint is null or id < ${beforeId}::bigint)
      order by id desc limit ${limit}`;
    return rows.reverse();
  },

  async countSince(userId: string, since: Date, role?: MessageRow['role']): Promise<number> {
    const [row] = await db()<{ n: number }[]>`
      select count(*)::int as n from messages where user_id = ${userId} and created_at >= ${since}
      and (${role ?? null}::text is null or role = ${role ?? null})`;
    return row?.n ?? 0;
  },

  /** The newest assistant-written message (what the user is most likely replying to). */
  async lastAssistant(userId: string): Promise<MessageRow | null> {
    const [row] = await db()<MessageRow[]>`
      select * from messages where user_id = ${userId} and role = 'assistant' order by id desc limit 1`;
    return row ?? null;
  },

  async proactiveCountSince(userId: string, since: Date): Promise<number> {
    const [row] = await db()<{ n: number }[]>`
      select count(*)::int as n from messages where user_id = ${userId} and created_at >= ${since}
      and role = 'assistant' and (meta->>'proactive')::boolean is true and coalesce(meta->>'source', '') <> 'reminder'`;
    return row?.n ?? 0;
  },
};

// ---------------------------------------------------------------------------------------------
// Routines: reminders, scheduled tasks, the morning brief
// ---------------------------------------------------------------------------------------------

export interface NewRoutine {
  kind: RoutineKind;
  title: string;
  instructions?: string | null;
  scheduleType: 'once' | 'cron';
  runAt?: Date | null;
  cron?: string | null;
  timezone: string;
  nextRunAt: Date | null;
  createdBy?: Routine['created_by'];
  channel?: ChannelName | null;
  meta?: Record<string, unknown>;
}

export const routines = {
  async create(userId: string, r: NewRoutine): Promise<Routine> {
    const [row] = await db()<Routine[]>`
      insert into routines (user_id, kind, title, instructions, schedule_type, run_at, cron, timezone, next_run_at, created_by, channel, meta)
      values (${userId}, ${r.kind}, ${r.title}, ${r.instructions ?? null}, ${r.scheduleType}, ${r.runAt ?? null}, ${r.cron ?? null},
              ${r.timezone}, ${r.nextRunAt}, ${r.createdBy ?? 'user'}, ${r.channel ?? null}, ${j(r.meta ?? {})})
      returning *`;
    return row!;
  },

  async get(userId: string, id: string): Promise<Routine | null> {
    const [row] = await db()<Routine[]>`select * from routines where id = ${id} and user_id = ${userId}`;
    return row ?? null;
  },

  async forUser(userId: string, includeInactive = false): Promise<Routine[]> {
    return db()<Routine[]>`
      select * from routines where user_id = ${userId}
      and (${includeInactive} or status in ('active', 'paused'))
      order by coalesce(next_run_at, created_at)`;
  },

  /** Active or paused items the user (or the agent) created: what the per-user cap counts. */
  async countOwn(userId: string): Promise<number> {
    const [row] = await db()<{ n: number }[]>`
      select count(*)::int as n from routines where user_id = ${userId} and created_by <> 'system' and status in ('active', 'paused')`;
    return row?.n ?? 0;
  },

  async byKind(userId: string, kind: RoutineKind): Promise<Routine[]> {
    return db()<Routine[]>`select * from routines where user_id = ${userId} and kind = ${kind} and status in ('active', 'paused')`;
  },

  async setStatus(userId: string, id: string, status: Routine['status']): Promise<Routine | null> {
    const [row] = await db()<Routine[]>`
      update routines set status = ${status} where id = ${id} and user_id = ${userId} returning *`;
    return row ?? null;
  },

  async update(userId: string, id: string, patch: { title?: string; instructions?: string | null; scheduleType?: Routine['schedule_type']; cron?: string | null; runAt?: Date | null; nextRunAt?: Date | null; timezone?: string; status?: Routine['status'] }): Promise<Routine | null> {
    const [row] = await db()<Routine[]>`
      update routines set
        title = coalesce(${patch.title ?? null}, title),
        schedule_type = coalesce(${patch.scheduleType ?? null}, schedule_type),
        instructions = case when ${patch.instructions !== undefined} then ${patch.instructions ?? null} else instructions end,
        cron = case when ${patch.cron !== undefined} then ${patch.cron ?? null} else cron end,
        run_at = case when ${patch.runAt !== undefined} then ${patch.runAt ?? null}::timestamptz else run_at end,
        next_run_at = case when ${patch.nextRunAt !== undefined} then ${patch.nextRunAt ?? null}::timestamptz else next_run_at end,
        timezone = coalesce(${patch.timezone ?? null}, timezone),
        status = coalesce(${patch.status ?? null}, status)
      where id = ${id} and user_id = ${userId} returning *`;
    return row ?? null;
  },

  /**
   * Claims due routines: moves next_run_at forward (or completes one-shots) in the same statement,
   * so two schedulers never fire the same occurrence.
   */
  async claimDue(limit: number, computeNext: (r: Routine) => Date | null): Promise<Routine[]> {
    const sql = db();
    return sql.begin(async (tx) => {
      const due = await tx<Routine[]>`
        select * from routines where status = 'active' and next_run_at <= now()
        order by next_run_at limit ${limit} for update skip locked`;
      for (const r of due) {
        const next = r.schedule_type === 'once' ? null : computeNext(r);
        await tx`
          update routines set last_run_at = now(), run_count = run_count + 1, next_run_at = ${next},
            status = case when ${next === null} then 'done' else status end
          where id = ${r.id}`;
      }
      return due;
    });
  },
};

// ---------------------------------------------------------------------------------------------
// Approvals: anything that sends, buys or calls on the user's behalf waits for a yes
// ---------------------------------------------------------------------------------------------

export const approvals = {
  async create(userId: string, tool: string, input: Record<string, unknown>, summary: string, channel: ChannelName | null): Promise<Approval> {
    const sql = db();
    // Short codes are unique among the user's pending approvals.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = shortCode(4, APPROVAL_CODE_ALPHABET);
      const [clash] = await sql`select 1 from approvals where user_id = ${userId} and status = 'pending' and short_code = ${code}`;
      if (clash) continue;
      const [row] = await sql<Approval[]>`
        insert into approvals (user_id, short_code, tool, input, summary, channel)
        values (${userId}, ${code}, ${tool}, ${j(input)}, ${summary}, ${channel}) returning *`;
      return row!;
    }
    throw new Error('Could not allocate an approval code');
  },

  async pending(userId: string): Promise<Approval[]> {
    return db()<Approval[]>`
      select * from approvals where user_id = ${userId} and status = 'pending' and expires_at > now()
      order by created_at`;
  },

  async get(userId: string, id: string): Promise<Approval | null> {
    const [row] = await db()<Approval[]>`select * from approvals where id = ${id} and user_id = ${userId}`;
    return row ?? null;
  },

  /** Atomically moves a pending approval to approved/rejected. Returns null if it was not pending. */
  async decide(userId: string, id: string, decision: 'approved' | 'rejected'): Promise<Approval | null> {
    const [row] = await db()<Approval[]>`
      update approvals set status = ${decision}, decided_at = now()
      where id = ${id} and user_id = ${userId} and status = 'pending' and expires_at > now()
      returning *`;
    return row ?? null;
  },

  async finish(id: string, status: 'executed' | 'failed', result: unknown): Promise<void> {
    await db()`update approvals set status = ${status}, result = ${j(result ?? null)} where id = ${id}`;
  },

  async expireOld(): Promise<number> {
    const rows = await db()`update approvals set status = 'expired' where status = 'pending' and expires_at <= now() returning id`;
    return rows.length;
  },

  async recent(userId: string, limit = 50): Promise<Approval[]> {
    return db()<Approval[]>`select * from approvals where user_id = ${userId} order by created_at desc limit ${limit}`;
  },
};

// ---------------------------------------------------------------------------------------------
// Audit log and usage
// ---------------------------------------------------------------------------------------------

export const audit = {
  async add(userId: string | null, actor: 'agent' | 'user' | 'system', action: string, detail: Record<string, unknown> = {}): Promise<void> {
    await db()`insert into audit_log (user_id, actor, action, detail) values (${userId}, ${actor}, ${action}, ${j(detail)})`;
  },

  async recent(userId: string, limit = 100): Promise<{ id: number; created_at: Date; actor: string; action: string; detail: Record<string, unknown> }[]> {
    return db()`select id, created_at, actor, action, detail from audit_log where user_id = ${userId} order by id desc limit ${limit}` as never;
  },
};

export interface UsageInput {
  userId: string | null;
  purpose: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  latencyMs?: number;
  steps?: number;
}

export const usage = {
  async add(u: UsageInput): Promise<void> {
    await db()`
      insert into usage_events (user_id, purpose, model, input_tokens, cached_input_tokens, output_tokens, cost_micro_usd, latency_ms, steps)
      values (${u.userId}, ${u.purpose}, ${u.model}, ${u.inputTokens}, ${u.cachedInputTokens}, ${u.outputTokens},
              ${Math.round(u.costMicroUsd)}, ${u.latencyMs ?? null}, ${u.steps ?? null})`;
  },

  async summary(userId: string, since: Date): Promise<UsageRow[]> {
    return db()<UsageRow[]>`
      select model, purpose, sum(input_tokens)::int as input_tokens, sum(cached_input_tokens)::int as cached_input_tokens,
             sum(output_tokens)::int as output_tokens, sum(cost_micro_usd)::bigint as cost_micro_usd, count(*)::int as calls
      from usage_events where user_id = ${userId} and created_at >= ${since}
      group by model, purpose order by sum(cost_micro_usd) desc`;
  },

  async costSince(userId: string, since: Date): Promise<number> {
    const [row] = await db()<{ c: number | null }[]>`
      select sum(cost_micro_usd)::bigint as c from usage_events where user_id = ${userId} and created_at >= ${since}`;
    return Number(row?.c ?? 0);
  },

  async daily(userId: string, days = 30): Promise<{ day: string; tokens: number; cost_micro_usd: number; calls: number }[]> {
    return db()`
      select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
             sum(input_tokens + output_tokens)::int as tokens, sum(cost_micro_usd)::bigint as cost_micro_usd, count(*)::int as calls
      from usage_events where user_id = ${userId} and created_at >= now() - make_interval(days => ${days})
      group by 1 order by 1` as never;
  },

  async latency(userId: string, since: Date): Promise<{ p50: number | null; p90: number | null }> {
    const [row] = await db()<{ p50: number | null; p90: number | null }[]>`
      select percentile_cont(0.5) within group (order by latency_ms)::int as p50,
             percentile_cont(0.9) within group (order by latency_ms)::int as p90
      from usage_events where user_id = ${userId} and created_at >= ${since} and latency_ms is not null and purpose in ('chat', 'onboarding')`;
    return row ?? { p50: null, p90: null };
  },
};

// ---------------------------------------------------------------------------------------------
// Integrations (OAuth tokens are encrypted by the caller)
// ---------------------------------------------------------------------------------------------

export const integrations = {
  async upsert(userId: string, provider: Integration['provider'], data: { account: string | null; scopes: string[]; accessTokenEnc: string | null; refreshTokenEnc: string | null; expiresAt: Date | null }): Promise<Integration> {
    const [row] = await db()<Integration[]>`
      insert into integrations (user_id, provider, account, scopes, access_token_enc, refresh_token_enc, expires_at, status)
      values (${userId}, ${provider}, ${data.account}, ${data.scopes}, ${data.accessTokenEnc}, ${data.refreshTokenEnc}, ${data.expiresAt}, 'active')
      on conflict (user_id, provider) do update set account = excluded.account, scopes = excluded.scopes,
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = coalesce(excluded.refresh_token_enc, integrations.refresh_token_enc),
        expires_at = excluded.expires_at, status = 'active', updated_at = now()
      returning *`;
    return row!;
  },

  async get(userId: string, provider: Integration['provider']): Promise<Integration | null> {
    const [row] = await db()<Integration[]>`select * from integrations where user_id = ${userId} and provider = ${provider}`;
    return row ?? null;
  },

  async forUser(userId: string): Promise<Integration[]> {
    return db()<Integration[]>`select * from integrations where user_id = ${userId}`;
  },

  async updateTokens(id: string, accessTokenEnc: string, expiresAt: Date | null): Promise<void> {
    await db()`update integrations set access_token_enc = ${accessTokenEnc}, expires_at = ${expiresAt}, updated_at = now() where id = ${id}`;
  },

  async setStatus(id: string, status: string): Promise<void> {
    await db()`update integrations set status = ${status}, updated_at = now() where id = ${id}`;
  },

  async remove(userId: string, provider: Integration['provider']): Promise<void> {
    await db()`delete from integrations where user_id = ${userId} and provider = ${provider}`;
  },
};

// ---------------------------------------------------------------------------------------------
// Lists (groceries, packing, to-dos): precise CRUD that memory alone can't give
// ---------------------------------------------------------------------------------------------

export const lists = {
  normalise(name: string): string {
    return name.trim().toLowerCase().replace(/\s+list$/, '').replace(/\s+/g, ' ') || 'list';
  },

  async getOrCreate(userId: string, name: string): Promise<{ id: string; name: string }> {
    const n = lists.normalise(name);
    const [row] = await db()<{ id: string; name: string }[]>`
      insert into lists (user_id, name) values (${userId}, ${n})
      on conflict (user_id, name) do update set name = excluded.name returning id, name`;
    return row!;
  },

  async all(userId: string): Promise<{ id: string; name: string; open: number }[]> {
    return db()`
      select l.id, l.name, count(i.id) filter (where not i.done)::int as open
      from lists l left join list_items i on i.list_id = l.id
      where l.user_id = ${userId} group by l.id order by l.name` as never;
  },

  async items(userId: string, name: string): Promise<{ id: string; text: string; done: boolean }[]> {
    return db()`
      select i.id, i.text, i.done from list_items i join lists l on l.id = i.list_id
      where l.user_id = ${userId} and l.name = ${lists.normalise(name)} order by i.done, i.created_at` as never;
  },

  async add(userId: string, name: string, items: string[]): Promise<number> {
    const list = await lists.getOrCreate(userId, name);
    const existing = new Set((await lists.items(userId, name)).filter((i) => !i.done).map((i) => i.text.toLowerCase()));
    const fresh: string[] = [];
    for (const raw of items) {
      const item = raw.trim();
      if (!item || existing.has(item.toLowerCase())) continue;
      existing.add(item.toLowerCase());
      fresh.push(item);
    }
    if (fresh.length === 0) return 0;
    await db()`insert into list_items ${db()(fresh.map((text) => ({ list_id: list.id, text })))}`;
    return fresh.length;
  },

  /**
   * Removes (or ticks off) items, case-insensitively. An exact match wins; otherwise a partial match
   * counts only when it is the only one ("milk" never takes "oat milk" and "milk chocolate" too).
   */
  async remove(userId: string, name: string, items: string[], tick = false): Promise<string[]> {
    const wanted = items.map((s) => s.trim().toLowerCase()).filter(Boolean);
    const current = (await lists.items(userId, name)).filter((i) => !tick || !i.done);
    const hits = new Map<string, { id: string; text: string }>();
    for (const w of wanted) {
      const exact = current.filter((i) => i.text.toLowerCase() === w);
      const partial = exact.length ? [] : current.filter((i) => i.text.toLowerCase().includes(w));
      for (const h of exact.length ? exact : partial.length === 1 ? partial : []) hits.set(h.id, h);
    }
    if (hits.size === 0) return [];
    const ids = [...hits.keys()];
    if (tick) await db()`update list_items set done = true where id in ${db()(ids)}`;
    else await db()`delete from list_items where id in ${db()(ids)}`;
    return [...hits.values()].map((h) => h.text);
  },

  async clear(userId: string, name: string): Promise<void> {
    await db()`delete from lists where user_id = ${userId} and name = ${lists.normalise(name)}`;
  },
};

// ---------------------------------------------------------------------------------------------
// Web sign-in: magic links and sessions; channel linking codes
// ---------------------------------------------------------------------------------------------

export const auth = {
  async createLoginToken(token: string, email: string, userId: string | null, ttlMinutes = 20): Promise<void> {
    await db()`
      insert into login_tokens (token_hash, email, user_id, purpose, expires_at)
      values (${sha256(token)}, ${email.toLowerCase()}, ${userId}, 'login', now() + make_interval(mins => ${ttlMinutes}))`;
  },

  /** Checks a sign-in link without using it up (link previews and scanners only GET pages). */
  async peekLoginToken(token: string): Promise<{ email: string | null; user_id: string | null } | null> {
    const [row] = await db()<{ email: string | null; user_id: string | null }[]>`
      select email, user_id from login_tokens where token_hash = ${sha256(token)} and used_at is null and expires_at > now()`;
    return row ?? null;
  },

  async consumeLoginToken(token: string): Promise<{ email: string | null; user_id: string | null } | null> {
    const [row] = await db()<{ email: string | null; user_id: string | null }[]>`
      update login_tokens set used_at = now()
      where token_hash = ${sha256(token)} and used_at is null and expires_at > now()
      returning email, user_id`;
    return row ?? null;
  },

  async createSession(token: string, userId: string, days = 30): Promise<void> {
    await db()`
      insert into sessions (token_hash, user_id, expires_at) values (${sha256(token)}, ${userId}, now() + make_interval(days => ${days}))`;
  },

  async sessionUser(token: string): Promise<User | null> {
    const [row] = await db()<User[]>`
      update sessions s set last_seen_at = now() from users u
      where s.token_hash = ${sha256(token)} and s.expires_at > now() and u.id = s.user_id and u.status <> 'deleted'
      returning u.*`;
    return row ?? null;
  },

  async deleteSession(token: string): Promise<void> {
    await db()`delete from sessions where token_hash = ${sha256(token)}`;
  },

  async createLinkCode(userId: string, ttlMinutes = 30): Promise<string> {
    const code = shortCode(6);
    await db()`insert into link_codes (code, user_id, expires_at) values (${code}, ${userId}, now() + make_interval(mins => ${ttlMinutes}))`;
    return code;
  },

  async consumeLinkCode(code: string): Promise<string | null> {
    const [row] = await db()<{ user_id: string }[]>`
      update link_codes set used_at = now() where code = ${code.toUpperCase()} and used_at is null and expires_at > now()
      returning user_id`;
    return row?.user_id ?? null;
  },
};

export const invites = {
  async consume(code: string): Promise<boolean> {
    const rows = await db()`
      update invites set uses = uses + 1 where code = ${code.trim().toUpperCase()} and uses < max_uses returning code`;
    return rows.length > 0;
  },
  async create(code: string, maxUses = 1, note?: string): Promise<void> {
    await db()`insert into invites (code, max_uses, note) values (${code.toUpperCase()}, ${maxUses}, ${note ?? null}) on conflict do nothing`;
  },
};

// ---------------------------------------------------------------------------------------------
// Calls, nudges, key-value
// ---------------------------------------------------------------------------------------------

export const calls = {
  async create(userId: string, c: { direction: CallRow['direction']; to?: string | null; from?: string | null; objective?: string | null; status?: string; meta?: Record<string, unknown> }): Promise<CallRow> {
    const [row] = await db()<CallRow[]>`
      insert into calls (user_id, direction, to_number, from_number, objective, status, meta)
      values (${userId}, ${c.direction}, ${c.to ?? null}, ${c.from ?? null}, ${c.objective ?? null}, ${c.status ?? 'queued'}, ${j(c.meta ?? {})})
      returning *`;
    return row!;
  },

  async get(id: string): Promise<CallRow | null> {
    const [row] = await db()<CallRow[]>`select * from calls where id = ${id}`;
    return row ?? null;
  },

  async byProviderId(providerCallId: string): Promise<CallRow | null> {
    const [row] = await db()<CallRow[]>`select * from calls where provider_call_id = ${providerCallId}`;
    return row ?? null;
  },

  async update(id: string, patch: { status?: string; providerCallId?: string; transcript?: string; summary?: string; ended?: boolean; meta?: Record<string, unknown> }): Promise<CallRow | null> {
    const [row] = await db()<CallRow[]>`
      update calls set
        status = coalesce(${patch.status ?? null}, status),
        provider_call_id = coalesce(${patch.providerCallId ?? null}, provider_call_id),
        transcript = coalesce(${patch.transcript ?? null}, transcript),
        summary = coalesce(${patch.summary ?? null}, summary),
        ended_at = case when ${patch.ended ?? false} then now() else ended_at end,
        meta = meta || ${j(patch.meta ?? {})}
      where id = ${id} returning *`;
    return row ?? null;
  },

  async recent(userId: string, limit = 20): Promise<CallRow[]> {
    return db()<CallRow[]>`select * from calls where user_id = ${userId} order by created_at desc limit ${limit}`;
  },
};

export const nudges = {
  /** True the first time a key is seen for a user; false afterwards. */
  async mark(userId: string, key: string): Promise<boolean> {
    const rows = await db()`insert into nudges_sent (user_id, key) values (${userId}, ${key}) on conflict do nothing returning key`;
    return rows.length > 0;
  },
};

export const kv = {
  async get<T>(key: string): Promise<T | null> {
    const [row] = await db()<{ value: T }[]>`select value from kv where key = ${key}`;
    return row?.value ?? null;
  },
  async set(key: string, value: unknown): Promise<void> {
    await db()`insert into kv (key, value) values (${key}, ${j(value)}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  },
  /** Atomic counter; returns the new value. */
  async incr(key: string, by = 1): Promise<number> {
    const [row] = await db()<{ n: number }[]>`
      insert into kv (key, value) values (${key}, to_jsonb(${by}::int))
      on conflict (key) do update set value = to_jsonb(coalesce((kv.value #>> '{}')::int, 0) + ${by}::int), updated_at = now()
      returning (value #>> '{}')::int as n`;
    return row?.n ?? by;
  },
};
