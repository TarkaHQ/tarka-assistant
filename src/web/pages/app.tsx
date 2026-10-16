import type { FC } from 'hono/jsx';
import { config } from '../../config.js';
import type { Approval, CallRow, Identity, MessageRow, Routine, User } from '../../db/types.js';
import type { MemoryItem } from '../../memory/hindsight.js';
import { formatUsd, modelInfo, type ModelInfo } from '../../models/tarka.js';
import { renderMarkdown } from '../../util/markdown.js';
import { describeCron, shortLocal } from '../../util/time.js';
import { Layout } from './layout.js';
import type { TurnTrace } from '../../agent/turn.js';

const SOURCE_LABEL: Record<string, string> = {
  brief: 'Morning brief',
  checkin: 'Check-in',
  routine: 'Scheduled task',
  reminder: 'Reminder',
  nudge: 'Heads-up',
  call: 'Call report',
  approval: 'Approval',
};

const CHANNEL_LABEL: Record<string, string> = { web: 'web', telegram: 'Telegram', sms: 'SMS', whatsapp: 'WhatsApp', voice: 'phone', email: 'email', cli: 'console' };

function money(n: number): string {
  return `$${n.toFixed(Number.isInteger(n * 100) ? 2 : 3)}`;
}

function time(d: Date, tz: string): string {
  return shortLocal(d, tz);
}

export const TraceView: FC<{ trace: TurnTrace }> = ({ trace }) => (
  <details class="trace">
    <summary>How this reply was made</summary>
    <dl>
      <dt>model</dt>
      <dd>{modelInfo(trace.model).label}</dd>
      <dt>tokens</dt>
      <dd>
        {trace.inputTokens.toLocaleString()} in{trace.cachedInputTokens ? ` (${trace.cachedInputTokens.toLocaleString()} cached)` : ''} · {trace.outputTokens.toLocaleString()} out
      </dd>
      <dt>cost</dt>
      <dd>{formatUsd(trace.costMicroUsd)}</dd>
      <dt>memory</dt>
      <dd>
        {trace.memoriesUsed} recalled in {trace.memoryMs} ms
      </dd>
      <dt>tools</dt>
      <dd>{trace.tools.length ? trace.tools.join(', ') : 'none'}</dd>
      <dt>time</dt>
      <dd>{(trace.latencyMs / 1000).toFixed(1)} s</dd>
    </dl>
  </details>
);

export const MessageView: FC<{ m: MessageRow; user: User; approvalsById?: Map<string, Approval> }> = ({ m, user, approvalsById }) => {
  const name = user.assistant_name || config().product.assistantName;
  const source = typeof m.meta.source === 'string' && m.meta.source !== 'message' ? SOURCE_LABEL[m.meta.source] : undefined;
  const trace = m.meta.trace as TurnTrace | undefined;
  const pending = ((m.meta.approvals as string[] | undefined) ?? []).map((id) => approvalsById?.get(id)).filter((a): a is Approval => Boolean(a && a.status === 'pending'));
  return (
    <div class={`msg ${m.role}`} data-id={m.id}>
      <div class="meta">
        <span class="who">{m.role === 'user' ? user.name ?? 'You' : m.role === 'event' ? 'Note' : name}</span>
        <span>{time(m.created_at, user.timezone)}</span>
        {m.channel !== 'web' ? <span>via {CHANNEL_LABEL[m.channel] ?? m.channel}</span> : null}
        {source ? <span class="tag">{source}</span> : null}
      </div>
      <div class="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
      {pending.length ? (
        <div class="approval-inline">
          {pending.map((a) => (
            <>
              <button class="btn small" data-approval={a.id} data-decision="approved" type="button">
                Yes, go ahead
              </button>
              <button class="btn small secondary" data-approval={a.id} data-decision="rejected" type="button">
                No
              </button>
            </>
          ))}
        </div>
      ) : null}
      {trace ? <TraceView trace={trace} /> : null}
    </div>
  );
};

export function messageHtml(m: MessageRow, user: User, approvalsById?: Map<string, Approval>): string {
  return String(<MessageView m={m} user={user} approvalsById={approvalsById} />);
}

export const ApprovalCard: FC<{ a: Approval; tz: string }> = ({ a, tz }) => (
  <li class="approval" data-approval-card={a.id}>
    <div class="summary">{a.summary}</div>
    <div class="sub">Asked {time(a.created_at, tz)} · expires {time(a.expires_at, tz)}</div>
    <div class="actions">
      <button class="btn small" data-approval={a.id} data-decision="approved" type="button">
        Yes, go ahead
      </button>
      <button class="btn small secondary" data-approval={a.id} data-decision="rejected" type="button">
        No
      </button>
    </div>
  </li>
);

function routineWhen(r: Routine, tz: string): string {
  const next = r.next_run_at ? time(r.next_run_at, tz) : 'not scheduled';
  return r.schedule_type === 'cron' && r.cron ? `${describeCron(r.cron)} · next ${next}` : next;
}

export const UpcomingList: FC<{ upcoming: Routine[]; tz: string }> = ({ upcoming, tz }) =>
  upcoming.length ? (
    <ul class="list">
      {upcoming.slice(0, 5).map((r) => (
        <li>
          <div class="title">{r.title}</div>
          <div class="sub">{routineWhen(r, tz)}</div>
        </li>
      ))}
    </ul>
  ) : (
    <p class="empty">No reminders yet. Try “remind me to call Mum on Sunday at 6pm”.</p>
  );

export interface HomeProps {
  user: User;
  messages: MessageRow[];
  approvals: Approval[];
  upcoming: Routine[];
  identities: Identity[];
  telegramReady: boolean;
  smsNumber: string | null;
  whatsappNumber: string | null;
  trialDaysLeft: number | null;
  canUpgrade: boolean;
  notice?: string;
}

export const HomePage: FC<HomeProps> = (p) => {
  const tz = p.user.timezone;
  const byId = new Map(p.approvals.map((a) => [a.id, a]));
  const has = (ch: string) => p.identities.some((i) => i.channel === ch && !i.opted_out_at);
  const name = p.user.assistant_name || config().product.assistantName;
  return (
    <Layout title={`${name} — chat`} user={p.user} active="/app" scripts>
      <main class="page shell">
        {p.notice ? <div class="notice ok">{p.notice}</div> : null}
        <div class="home">
          <section class="panel chat" aria-label="Conversation">
            <div class="chat-log" id="chat-log" data-last-id={p.messages.length ? p.messages[p.messages.length - 1]!.id : 0}>
              {p.messages.length === 0 ? (
                <p class="empty" id="chat-empty">
                  Say hello. {name} will ask your name and city, then it’s ready to help.
                </p>
              ) : (
                p.messages.map((m) => <MessageView m={m} user={p.user} approvalsById={byId} />)
              )}
            </div>
            <div class="chat-status" id="chat-status" aria-live="polite"></div>
            <form class="composer" id="composer">
              <label for="composer-input" class="visually-hidden">
                Message
              </label>
              <textarea id="composer-input" name="text" rows={1} placeholder={`Message ${name}`} required></textarea>
              <button class="btn" type="submit" id="composer-send">
                Send
              </button>
            </form>
          </section>

          <aside class="rail">
            <section class="panel">
              <div class="panel-head">
                <h2>Waiting for you</h2>
              </div>
              <div class="panel-body">
                <div data-approvals-list>
                {p.approvals.length ? (
                  <ul class="list">{p.approvals.map((a) => <ApprovalCard a={a} tz={tz} />)}</ul>
                ) : (
                  <p class="empty">Nothing needs your OK. Anything that sends, invites, deletes or calls will wait here.</p>
                )}
                </div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Coming up</h2>
                <a href="/app/schedule" class="hint">
                  All
                </a>
              </div>
              <div class="panel-body">
                <div data-upcoming-list>
                  <UpcomingList upcoming={p.upcoming} tz={tz} />
                </div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Reach {name} on</h2>
              </div>
              <div class="panel-body">
                <ul class="list">
                  <li class="channel-row">
                    <span>
                      <span class={`status-dot ${has('telegram') ? 'on' : ''}`}></span>Telegram
                    </span>
                    {has('telegram') ? (
                      <span class="sub">Connected</span>
                    ) : p.telegramReady ? (
                      <button class="btn small secondary" type="button" data-link-telegram>
                        Connect
                      </button>
                    ) : (
                      <span class="sub">Not available</span>
                    )}
                  </li>
                  <li class="channel-row">
                    <span>
                      <span class={`status-dot ${has('sms') ? 'on' : ''}`}></span>Text message
                    </span>
                    {p.smsNumber ? <span class="sub mono">{p.smsNumber}</span> : <span class="sub">Coming soon</span>}
                  </li>
                  {p.whatsappNumber ? (
                    <li class="channel-row">
                      <span>
                        <span class={`status-dot ${has('whatsapp') ? 'on' : ''}`}></span>WhatsApp (EU)
                      </span>
                      <span class="sub mono">{p.whatsappNumber}</span>
                    </li>
                  ) : null}
                </ul>
                <p class="hint" id="link-hint"></p>
              </div>
            </section>

            {p.trialDaysLeft !== null ? (
              <section class="panel">
                <div class="panel-body">
                  <p>
                    <strong>
                      {p.trialDaysLeft} day{p.trialDaysLeft === 1 ? '' : 's'} left
                    </strong>{' '}
                    in your free trial.
                  </p>
                  {p.canUpgrade ? (
                    <a class="btn small" style="margin-top:10px" href="/billing/start">
                      Keep it for {config().product.priceLabel}
                    </a>
                  ) : null}
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      </main>
    </Layout>
  );
};

export const MemoryPage: FC<{ user: User; profile: string | null; items: MemoryItem[]; total: number; q: string; offset: number; enabled: boolean }> = (p) => (
  <Layout title="Memory" user={p.user} active="/app/memory" scripts>
    <main class="page shell">
      <div class="page-head">
        <div>
          <h1>What it remembers</h1>
          <p>
            Facts are pulled from your conversations into a memory bank that belongs to you alone. Delete anything that is wrong or that you’d rather it
            forgot.
          </p>
        </div>
        <button class="btn danger small" type="button" data-forget-all>
          Forget everything
        </button>
      </div>
      {!p.enabled ? <div class="notice warn">Memory is switched off on this deployment.</div> : null}
      <section class="panel" style="margin-bottom:24px">
        <div class="panel-head">
          <h2>About you</h2>
          <span class="hint">Kept up to date from your memories</span>
        </div>
        <div class="panel-body">{p.profile ? <div class="profile">{p.profile}</div> : <p class="empty">Nothing yet. It fills in as you talk.</p>}</div>
      </section>
      <form class="toolbar" method="get" action="/app/memory">
        <label for="q" class="visually-hidden">
          Search memories
        </label>
        <input id="q" type="search" name="q" value={p.q} placeholder="Search memories" />
        <button class="btn secondary" type="submit">
          Search
        </button>
      </form>
      <section class="panel">
        {p.items.length ? (
          <table class="table">
            <thead>
              <tr>
                <th>Memory</th>
                <th>When</th>
                <th>
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {p.items.map((m) => (
                <tr data-memory-row={m.id}>
                  <td>{m.text}</td>
                  <td class="soft">{m.when ? new Date(m.when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</td>
                  <td style="text-align:right">
                    {m.type === 'observation' ? (
                      <span class="hint">Summary</span>
                    ) : (
                      <button class="btn small secondary" type="button" data-forget={m.id}>
                        Forget
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="panel-body">
            <p class="empty">{p.q ? 'No memories match that search.' : 'No memories yet.'}</p>
          </div>
        )}
      </section>
      <div class="row" style="margin-top:14px;justify-content:space-between">
        <span class="hint">
          {p.total.toLocaleString()} memor{p.total === 1 ? 'y' : 'ies'}
        </span>
        <span class="row">
          {p.offset > 0 ? (
            <a class="btn small secondary" href={`/app/memory?q=${encodeURIComponent(p.q)}&offset=${Math.max(0, p.offset - 50)}`}>
              Newer
            </a>
          ) : null}
          {p.offset + 50 < p.total ? (
            <a class="btn small secondary" href={`/app/memory?q=${encodeURIComponent(p.q)}&offset=${p.offset + 50}`}>
              Older
            </a>
          ) : null}
        </span>
      </div>
    </main>
  </Layout>
);

export const SchedulePage: FC<{ user: User; routines: Routine[] }> = ({ user, routines }) => {
  const tz = user.timezone;
  const kindLabel: Record<string, string> = { reminder: 'Reminder', task: 'Task', brief: 'Morning brief', checkin: 'Check-in', followup: 'Follow-up', watch: 'Watch' };
  return (
    <Layout title="Schedule" user={user} active="/app/schedule" scripts>
      <main class="page shell">
        <div class="page-head">
          <div>
            <h1>Schedule</h1>
            <p>Reminders you asked for, tasks it runs for you, and its own routines. To add one, just ask in chat.</p>
          </div>
        </div>
        <section class="panel">
          {routines.length ? (
            <table class="table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>When</th>
                  <th>Type</th>
                  <th>
                    <span class="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {routines.map((r) => (
                  <tr data-routine-row={r.id}>
                    <td>
                      {r.title}
                      {r.instructions ? <div class="hint">{r.instructions.slice(0, 160)}</div> : null}
                    </td>
                    <td class="soft">{routineWhen(r, tz)}</td>
                    <td class="soft">
                      {kindLabel[r.kind] ?? r.kind}
                      {r.status === 'paused' ? ' (paused)' : ''}
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                      {r.status === 'paused' ? (
                        <button class="btn small secondary" type="button" data-routine={r.id} data-action="resume">
                          Resume
                        </button>
                      ) : (
                        <button class="btn small secondary" type="button" data-routine={r.id} data-action="pause">
                          Pause
                        </button>
                      )}{' '}
                      <button class="btn small secondary" type="button" data-routine={r.id} data-action="cancel">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="panel-body">
              <p class="empty">Nothing scheduled. Ask “remind me…” or “every Monday at 8, send me my week”.</p>
            </div>
          )}
        </section>
      </main>
    </Layout>
  );
};

export interface ActivityEntry {
  at: Date;
  who: string;
  what: string;
  detail?: string;
}

export const ActivityPage: FC<{ user: User; entries: ActivityEntry[]; approvals: Approval[]; calls: CallRow[] }> = ({ user, entries, approvals, calls }) => {
  const tz = user.timezone;
  const statusLabel: Record<string, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Declined', expired: 'Expired', executed: 'Done', failed: 'Failed' };
  return (
    <Layout title="Activity" user={user} active="/app/activity" scripts>
      <main class="page shell">
        <div class="page-head">
          <div>
            <h1>Activity</h1>
            <p>Everything it did for you, and every request that needed your OK.</p>
          </div>
        </div>
        <section class="panel" style="margin-bottom:24px">
          <div class="panel-head">
            <h2>Requests for approval</h2>
          </div>
          {approvals.length ? (
            <table class="table">
              <tbody>
                {approvals.map((a) => (
                  <tr>
                    <td style="white-space:pre-wrap">{a.summary}</td>
                    <td class="soft">{time(a.created_at, tz)}</td>
                    <td class="soft">{statusLabel[a.status] ?? a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="panel-body">
              <p class="empty">No requests yet.</p>
            </div>
          )}
        </section>
        {calls.length ? (
          <section class="panel" style="margin-bottom:24px">
            <div class="panel-head">
              <h2>Calls</h2>
            </div>
            <table class="table">
              <tbody>
                {calls.map((c) => (
                  <tr>
                    <td>
                      {(c.meta.business as string | undefined) ?? c.to_number ?? c.from_number}
                      <div class="hint">{c.summary ?? c.objective}</div>
                    </td>
                    <td class="soft">{time(c.created_at, tz)}</td>
                    <td class="soft">{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        <section class="panel">
          <div class="panel-head">
            <h2>Log</h2>
          </div>
          {entries.length ? (
            <table class="table">
              <tbody>
                {entries.map((e) => (
                  <tr>
                    <td>
                      {e.what}
                      {e.detail ? <div class="hint">{e.detail}</div> : null}
                    </td>
                    <td class="soft">{e.who}</td>
                    <td class="soft">{time(e.at, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="panel-body">
              <p class="empty">Nothing yet.</p>
            </div>
          )}
        </section>
      </main>
    </Layout>
  );
};

export interface HoodProps {
  user: User;
  model: ModelInfo;
  models: ModelInfo[];
  last: TurnTrace | null;
  month: { messages: number; inputTokens: number; outputTokens: number; costMicroUsd: number; calls: number };
  latency: { p50: number | null; p90: number | null };
  daily: { day: string; tokens: number }[];
  memoryCount: number;
  memoryBank: string;
}

export const HoodPage: FC<HoodProps> = (p) => {
  const byDay = new Map(p.daily.map((d) => [d.day, d.tokens]));
  const slots = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, tokens: byDay.get(day) ?? 0 };
  });
  const max = Math.max(1, ...slots.map((d) => d.tokens));
  return (
    <Layout title="Under the hood" user={p.user} active="/app/hood" scripts>
      <main class="page shell">
        <div class="page-head">
          <div>
            <h1>Under the hood</h1>
            <p>Your assistant is an app running on Tarka. Here is what it uses to answer you, and what that costs.</p>
          </div>
        </div>

        <section class="hood" aria-label="How the last reply was made">
          <h2>Your last reply, step by step</h2>
          <p class="lead">Every message goes through the same path: recall what matters, think with a model, act with tools, then remember the exchange.</p>
          {p.last ? (
            <div class="flow">
              <div class="step">
                <div class="k">Recalled from memory</div>
                <div class="v">{p.last.memoriesUsed} facts</div>
                <div class="d">hindsight · {p.last.memoryMs} ms</div>
              </div>
              <div class="step">
                <div class="k">Thought with</div>
                <div class="v">{modelInfo(p.last.model).label}</div>
                <div class="d">
                  {p.last.inputTokens.toLocaleString()} in · {p.last.outputTokens.toLocaleString()} out
                </div>
              </div>
              <div class="step">
                <div class="k">Used tools</div>
                <div class="v">{p.last.tools.length}</div>
                <div class="d">{p.last.tools.length ? Array.from(new Set(p.last.tools)).join(', ') : 'none needed'}</div>
              </div>
              <div class="step">
                <div class="k">Replied in</div>
                <div class="v">{(p.last.latencyMs / 1000).toFixed(1)} s</div>
                <div class="d">cost {formatUsd(p.last.costMicroUsd)}</div>
              </div>
            </div>
          ) : (
            <p class="lead">Send a message first, then come back.</p>
          )}
        </section>

        <div class="stats">
          <div class="panel stat">
            <div class="n">{p.month.messages.toLocaleString()}</div>
            <div class="l">replies this month</div>
          </div>
          <div class="panel stat">
            <div class="n">{(p.month.inputTokens + p.month.outputTokens).toLocaleString()}</div>
            <div class="l">tokens this month</div>
          </div>
          <div class="panel stat">
            <div class="n">{formatUsd(p.month.costMicroUsd)}</div>
            <div class="l">model cost this month</div>
          </div>
          <div class="panel stat">
            <div class="n">{p.latency.p50 !== null ? `${(p.latency.p50 / 1000).toFixed(1)} s` : '—'}</div>
            <div class="l">typical reply time{p.latency.p90 !== null ? ` (slowest 10%: ${(p.latency.p90 / 1000).toFixed(1)} s)` : ''}</div>
          </div>
        </div>

        <div class="settings" style="margin-top:24px">
          <section class="panel">
            <div class="panel-head">
              <h2>Model</h2>
              <span class="hint">Served by Tarka</span>
            </div>
            <div class="panel-body">
              <form id="model-form" class="models">
                {p.models.map((m) => (
                  <label class="model-option">
                    <input type="radio" name="model" value={m.id} checked={m.id === p.model.id} />
                    <span>
                      <span class="name">{m.label}</span>
                      <br />
                      <span class="hint">{m.blurb}</span>
                      <br />
                      <span class="price">
                        {m.price.in === 0 && m.price.out === 0 ? 'included in your plan' : `${money(m.price.in)} in · ${money(m.price.out)} out per million tokens`}
                      </span>
                    </span>
                  </label>
                ))}
              </form>
              <p class="hint" id="model-status"></p>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h2>Usage, last 30 days</h2>
            </div>
            <div class="panel-body">
              {p.daily.length ? (
                <div class="bars" role="img" aria-label="Tokens per day for the last 30 days">
                  {slots.map((d) => (
                    <span style={`height:${d.tokens ? Math.max(4, Math.round((d.tokens / max) * 100)) : 2}%;${d.tokens ? '' : 'opacity:0.25'}`} title={`${d.day}: ${d.tokens.toLocaleString()} tokens`}></span>
                  ))}
                </div>
              ) : (
                <p class="empty">No usage yet.</p>
              )}
              <ul class="list" style="margin-top:16px">
                <li>
                  <div class="title">Memory</div>
                  <div class="sub">
                    {p.memoryCount.toLocaleString()} facts in your own bank <span class="mono">{p.memoryBank}</span>, stored with Hindsight (open source, by Vectorize)
                  </div>
                </li>
                <li>
                  <div class="title">Build your own</div>
                  <div class="sub">
                    This assistant is an open-source template. Developers can run it, or any agent, on <a href="https://tarkahq.com">Tarka</a>.
                  </div>
                </li>
              </ul>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  );
};

export interface SettingsProps {
  user: User;
  googleEnabled: boolean;
  googleAccount: string | null;
  identities: Identity[];
  billing: { enabled: boolean; plan: string; trialDaysLeft: number | null; status: string | null };
  voice: { enabled: boolean };
  notice?: string;
}

export const SettingsPage: FC<SettingsProps> = ({ user, googleEnabled, googleAccount, identities, billing, voice, notice }) => {
  const s = user.settings;
  const brief = s.briefTime === undefined ? '07:30' : s.briefTime;
  const q = s.quietHours ?? { start: '22:00', end: '07:30' };
  return (
    <Layout title="Settings" user={user} active="/app/settings" scripts>
      <main class="page shell">
        <div class="page-head">
          <div>
            <h1>Settings</h1>
            <p>You can also change any of this by asking in chat.</p>
          </div>
        </div>
        {notice ? <div class="notice ok">{notice}</div> : null}
        <div class="settings">
          <section class="panel">
            <div class="panel-head">
              <h2>You and your assistant</h2>
            </div>
            <div class="panel-body">
              <form id="settings-form">
                <div class="two">
                  <div class="field">
                    <label for="name">Your name</label>
                    <input id="name" name="name" type="text" value={user.name ?? ''} />
                  </div>
                  <div class="field">
                    <label for="assistant_name">Its name</label>
                    <input id="assistant_name" name="assistant_name" type="text" value={user.assistant_name ?? ''} placeholder={config().product.assistantName} />
                  </div>
                </div>
                <div class="two">
                  <div class="field">
                    <label for="city">City</label>
                    <input id="city" name="city" type="text" value={user.city ?? ''} />
                  </div>
                  <div class="field">
                    <label for="timezone">Timezone</label>
                    <input id="timezone" name="timezone" type="text" value={user.timezone} />
                    <p class="hint">For example Europe/Berlin or America/New_York</p>
                  </div>
                </div>
                <div class="two">
                  <div class="field">
                    <label for="brief_time">Morning brief</label>
                    <input id="brief_time" name="brief_time" type="time" value={brief ?? ''} />
                    <p class="hint">Leave empty to switch it off.</p>
                  </div>
                  <div class="field">
                    <label for="proactivity">How proactive</label>
                    <select id="proactivity" name="proactivity">
                      {(['off', 'low', 'normal', 'high'] as const).map((v) => (
                        <option value={v} selected={(s.proactivity ?? 'normal') === v}>
                          {{ off: 'Only when I ask', low: 'Brief and reminders only', normal: 'Normal', high: 'Check in often' }[v]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div class="two">
                  <div class="field">
                    <label for="quiet_start">Quiet from</label>
                    <input id="quiet_start" name="quiet_start" type="time" value={q.start} />
                  </div>
                  <div class="field">
                    <label for="quiet_end">Quiet until</label>
                    <input id="quiet_end" name="quiet_end" type="time" value={q.end} />
                  </div>
                </div>
                <div class="field">
                  <label class="row" style="font-weight:500">
                    <input type="checkbox" name="meeting_nudges" checked={s.meetingNudges !== false} /> Heads-up before meetings
                  </label>
                  <label class="row" style="font-weight:500">
                    <input type="checkbox" name="voice_replies" checked={Boolean(s.voiceReplies)} /> Reply with a voice note when I send one (Telegram)
                  </label>
                </div>
                <button class="btn" type="submit">
                  Save settings
                </button>
                <span class="hint" id="settings-status" style="margin-left:12px"></span>
              </form>
            </div>
          </section>

          <div class="rail">
            <section class="panel">
              <div class="panel-head">
                <h2>Google</h2>
              </div>
              <div class="panel-body">
                {!googleEnabled ? (
                  <p class="empty">Google isn’t set up on this deployment yet.</p>
                ) : googleAccount ? (
                  <div class="channel-row">
                    <span>
                      <span class="status-dot on"></span>
                      {googleAccount}
                    </span>
                    <button class="btn small secondary" type="button" data-google-disconnect>
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <>
                    <p>Connect Gmail, Calendar, Drive and Contacts so it can plan your day, draft replies and book time.</p>
                    <form method="post" action="/oauth/google/code" style="margin-top:12px">
                      <button class="btn small" type="submit">
                        Connect Google
                      </button>
                    </form>
                  </>
                )}
              </div>
            </section>
            {voice.enabled ? (
              <section class="panel">
                <div class="panel-head">
                  <h2>Phone calls</h2>
                </div>
                <div class="panel-body">
                  <p>
                    Caller ID can be faked, so when you call, your assistant only uses your calendar, memory and lists once it knows it’s you: your carrier
                    verifies your number, or you say your voice PIN.
                  </p>
                  <form id="voice-pin-form" style="margin-top:12px">
                    <div class="field">
                      <label for="voice_pin">{s.voicePin ? 'Change voice PIN' : 'Voice PIN'}</label>
                      <input id="voice_pin" name="voice_pin" type="password" inputmode="numeric" autocomplete="off" pattern="\d{6,8}" placeholder="6 to 8 digits" />
                      <p class="hint">{s.voicePin ? 'A PIN is set.' : 'No PIN yet.'} Never use your bank PIN.</p>
                    </div>
                    <label class="row" style="font-weight:500">
                      <input type="checkbox" name="voice_require_pin" checked={Boolean(s.voiceRequirePin)} /> Always ask for my PIN
                    </label>
                    <div class="row" style="margin-top:10px;gap:8px">
                      <button class="btn small" type="submit">
                        Save
                      </button>
                      {s.voicePin ? (
                        <button class="btn small secondary" type="button" data-voice-pin-remove>
                          Remove PIN
                        </button>
                      ) : null}
                      <span class="hint" id="voice-pin-status"></span>
                    </div>
                  </form>
                </div>
              </section>
            ) : null}
            <section class="panel">
              <div class="panel-head">
                <h2>Channels</h2>
              </div>
              <div class="panel-body">
                <ul class="list">
                  {identities
                    .filter((i) => i.channel !== 'web')
                    .map((i) => (
                      <li class="channel-row">
                        <span>
                          <span class={`status-dot ${i.opted_out_at ? '' : 'on'}`}></span>
                          {CHANNEL_LABEL[i.channel] ?? i.channel} <span class="mono hint">{i.display ?? i.external_id}</span>
                        </span>
                        <button class="btn small secondary" type="button" data-identity-remove={i.id}>
                          Remove
                        </button>
                      </li>
                    ))}
                </ul>
                {identities.filter((i) => i.channel !== 'web').length === 0 ? <p class="empty">Only the web so far. Connect Telegram from the chat page.</p> : null}
              </div>
            </section>
            <section class="panel">
              <div class="panel-head">
                <h2>Plan</h2>
              </div>
              <div class="panel-body">
                {billing.plan === 'pro' ? (
                  <>
                    <p>You’re on the {config().product.priceLabel} plan{billing.status ? ` (${billing.status})` : ''}.</p>
                    {billing.enabled ? (
                      <a class="btn small secondary" style="margin-top:12px" href="/billing/portal">
                        Manage billing
                      </a>
                    ) : null}
                  </>
                ) : billing.plan === 'trial' ? (
                  <>
                    <p>
                      Free trial{billing.trialDaysLeft !== null ? `, ${billing.trialDaysLeft} day${billing.trialDaysLeft === 1 ? '' : 's'} left` : ''}.
                    </p>
                    {billing.enabled ? (
                      <a class="btn small" style="margin-top:12px" href="/billing/start">
                        Subscribe for {config().product.priceLabel}
                      </a>
                    ) : null}
                  </>
                ) : (
                  <p>Plan: {billing.plan}</p>
                )}
              </div>
            </section>
            <section class="panel">
              <div class="panel-head">
                <h2>Delete account</h2>
              </div>
              <div class="panel-body">
                <p>Removes your conversations, memory bank, reminders, connections and settings. This can’t be undone.</p>
                <button class="btn danger small" style="margin-top:12px" type="button" data-delete-account>
                  Delete my account
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>
    </Layout>
  );
};
