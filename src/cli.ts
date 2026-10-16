import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { db, closeDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { identities, routines, users } from './db/repo.js';
import { handleInbound } from './channels/inbound.js';
import { runTurn } from './agent/turn.js';
import { formatUsd, modelInfo } from './models/tarka.js';
import { syncSystemRoutines } from './proactive/system-routines.js';

/**
 * Talk to the assistant from a terminal, as a local test user, with real models and memory.
 *   npm run chat               chat as the local test user
 *   /brief  /checkin           run a proactive routine now
 *   /reset                     start over as a brand-new user
 */
const EXTERNAL_ID = process.env.CLI_USER ?? 'local';

await migrate(db());

async function localUser() {
  const id = await identities.find('cli', EXTERNAL_ID);
  if (id) return (await users.get(id.user_id))!;
  const u = await users.create({ status: 'onboarding', plan: 'staff' });
  await identities.create(u.id, 'cli', EXTERNAL_ID, 'terminal', true);
  return u;
}

const rl = createInterface({ input, output });
console.log('Tarka Assistant — terminal chat. Ctrl+C to quit. /brief, /checkin, /reset\n');
for (;;) {
  const text = (await rl.question('you › ')).trim();
  if (!text) continue;
  if (text === '/reset') {
    const id = await identities.find('cli', EXTERNAL_ID);
    if (id) await users.delete(id.user_id);
    console.log('(new user)\n');
    continue;
  }
  const started = Date.now();
  if (text === '/brief' || text === '/checkin') {
    const user = await localUser();
    await syncSystemRoutines(user);
    const kind = text === '/brief' ? 'brief' : 'checkin';
    const [r] = await routines.byKind(user.id, kind);
    const turn = await runTurn({ user, channel: 'cli', text: r?.title ?? kind, title: r?.title, trigger: kind });
    console.log(`\n${user.assistant_name ?? 'tarka'} › ${turn.silent ? '(nothing worth sending)' : turn.text}\n`);
    continue;
  }
  await localUser();
  const res = await handleInbound(
    { channel: 'cli', externalId: EXTERNAL_ID, text, receivedAt: new Date().toISOString() },
    { onStatus: (label) => output.write(`  … ${label}\n`) },
  );
  console.log(`\ntarka › ${res.reply ?? '(no reply)'}`);
  const t = res.turn?.trace;
  if (t) {
    console.log(
      `  [${modelInfo(t.model).label} · ${t.inputTokens} in / ${t.outputTokens} out · ${formatUsd(t.costMicroUsd)} · memory ${t.memoriesUsed} in ${t.memoryMs}ms · tools: ${t.tools.join(', ') || 'none'} · ${((Date.now() - started) / 1000).toFixed(1)}s]`,
    );
  }
  console.log('');
}

process.on('SIGINT', async () => {
  await closeDb();
  process.exit(0);
});
