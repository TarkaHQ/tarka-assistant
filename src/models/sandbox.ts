import { config } from '../config.js';

/**
 * Tarka code sandboxes (Control API). A tk_live_ key with the `sandboxes` scope can create a
 * sandbox from a template and execute code in it. We keep one short-lived sandbox per user and
 * reuse it while it is ready.
 */

interface Sandbox {
  id: string;
  status: string;
  expires_at?: string;
}

interface Execution {
  id: string;
  status: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms?: number;
  output_truncated?: boolean;
  error_code?: string;
}

const userSandboxes = new Map<string, { id: string; expiresAt: number }>();

function base(): string {
  const cfg = config();
  if (!cfg.tarka.orgId) throw new Error('TARKA_ORG_ID is not set, so code sandboxes are unavailable');
  return `${cfg.tarka.controlUrl}/control/v1/orgs/${cfg.tarka.orgId}/sandboxes`;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const key = config().models.apiKey;
  if (!key) throw new Error('TARKA_API_KEY is required for sandboxes');
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sandbox API ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export function sandboxesAvailable(): boolean {
  const cfg = config();
  return Boolean(cfg.tarka.orgId && cfg.models.apiKey);
}

async function readySandbox(userId: string): Promise<string> {
  const cached = userSandboxes.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.id;
  const created = await call<Sandbox>('', {
    method: 'POST',
    body: JSON.stringify({ template: config().tarka.sandboxTemplate, timeout_seconds: 900 }),
  });
  let sb = created;
  const deadline = Date.now() + 60_000;
  while (sb.status !== 'CODE_SANDBOX_STATUS_READY') {
    if (['CODE_SANDBOX_STATUS_FAILED', 'CODE_SANDBOX_STATUS_EXPIRED', 'CODE_SANDBOX_STATUS_DELETED', 'CODE_SANDBOX_STATUS_STOPPED'].includes(sb.status)) {
      throw new Error(`Sandbox did not start (${sb.status})`);
    }
    if (Date.now() > deadline) throw new Error('Sandbox took too long to start');
    await new Promise((r) => setTimeout(r, 1500));
    sb = await call<Sandbox>(`/${created.id}`, { method: 'GET' });
  }
  const expiresAt = sb.expires_at ? Date.parse(sb.expires_at) : Date.now() + 14 * 60_000;
  userSandboxes.set(userId, { id: sb.id, expiresAt });
  return sb.id;
}

export async function runCode(userId: string, code: string, timeoutSeconds = 60): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; durationMs: number | null }> {
  const id = await readySandbox(userId);
  let exec = await call<Execution>(`/${id}:execute`, {
    method: 'POST',
    body: JSON.stringify({ code, timeout_seconds: timeoutSeconds }),
  });
  const deadline = Date.now() + (timeoutSeconds + 30) * 1000;
  while (exec.status === 'EXECUTION_STATUS_RUNNING' || exec.status === 'EXECUTION_STATUS_UNSPECIFIED') {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
    exec = await call<Execution>(`/${id}/executions/${exec.id}`, { method: 'GET' });
  }
  return {
    ok: exec.status === 'EXECUTION_STATUS_SUCCEEDED',
    stdout: (exec.stdout ?? '').slice(0, 8000),
    stderr: (exec.stderr ?? exec.error_code ?? '').slice(0, 4000),
    exitCode: exec.exit_code ?? null,
    durationMs: exec.duration_ms ?? null,
  };
}
