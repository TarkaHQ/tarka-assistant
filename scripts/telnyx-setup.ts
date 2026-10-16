/**
 * One-off Telnyx setup for Tarka Assistant. Reads TELNYX_API_KEY, PUBLIC_URL and VOICE_LLM_SECRET.
 *
 *   npx tsx --env-file=.env scripts/telnyx-setup.ts            # dry run: prints what it would do
 *   npx tsx --env-file=.env scripts/telnyx-setup.ts --apply    # creates the resources below
 *
 * It creates (or updates, matched by name):
 *   1. a messaging profile whose webhooks go to PUBLIC_URL/webhooks/telnyx/messaging;
 *   2. an integration secret holding VOICE_LLM_SECRET (Telnyx sends it as the custom LLM's key);
 *   3. two AI Assistants that use this app as their custom LLM (PUBLIC_URL/voice/v1):
 *      "Tarka Assistant (inbound)" answers calls to your number, and
 *      "Tarka Assistant (concierge)" places calls to businesses for users.
 *
 * It never buys a phone number. Buy one in the portal (or via the API), attach it to the messaging
 * profile and to the inbound assistant's TeXML app, then put its id/number in .env.
 */

const API = 'https://api.telnyx.com/v2';
const key = process.env.TELNYX_API_KEY;
const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
const secret = process.env.VOICE_LLM_SECRET;
const apply = process.argv.includes('--apply');

if (!key || !publicUrl.startsWith('https://') || !secret) {
  console.error('Set TELNYX_API_KEY, an https PUBLIC_URL and VOICE_LLM_SECRET first.');
  process.exit(1);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function step(what: string) {
  console.log(`${apply ? '•' : '(dry run)'} ${what}`);
}

const SECRET_ID = 'tarka-assistant-voice-llm';
const VOICE = 'Telnyx.KokoroTTS.af_heart';

const inboundInstructions =
  'You are a personal assistant answering a phone call from your user. Your real instructions and memory come from the connected model; keep replies short and spoken.';
const conciergeInstructions =
  'You are an AI assistant phoning a business on behalf of a client. Your real instructions come from the connected model.';

async function main() {
  // 1. Messaging profile
  const profiles = await call<{ data: { id: string; name: string }[] }>('GET', '/messaging_profiles?page[size]=250');
  const existing = profiles.data.find((p) => p.name === 'Tarka Assistant');
  const profileBody = {
    name: 'Tarka Assistant',
    enabled: true,
    webhook_url: `${publicUrl}/webhooks/telnyx/messaging`,
    webhook_api_version: '2',
    whitelisted_destinations: ['*'],
  };
  step(`${existing ? 'update' : 'create'} messaging profile → ${profileBody.webhook_url}`);
  let profileId = existing?.id;
  if (apply) {
    const r = existing
      ? await call<{ data: { id: string } }>('PATCH', `/messaging_profiles/${existing.id}`, profileBody)
      : await call<{ data: { id: string } }>('POST', '/messaging_profiles', profileBody);
    profileId = r.data.id;
  }

  // 2. Integration secret for the custom LLM
  step(`create integration secret "${SECRET_ID}" (bearer)`);
  if (apply) {
    await call('POST', '/integration_secrets', { identifier: SECRET_ID, type: 'bearer', token: secret }).catch((err) => {
      if (!String(err).includes('409') && !String(err).toLowerCase().includes('exist')) throw err;
      console.log('  secret already exists; leaving it');
    });
  }

  // 3. AI assistants
  const assistants = await call<{ data: { id: string; name: string }[] }>('GET', '/ai/assistants');
  const externalLlm = {
    base_url: `${publicUrl}/voice/v1`,
    model: 'tarka-assistant',
    llm_api_key_ref: SECRET_ID,
    authentication_method: 'token',
    forward_metadata: true,
  };
  const defs = [
    {
      name: 'Tarka Assistant (inbound)',
      instructions: inboundInstructions,
      greeting: 'Hi, it’s your assistant. What can I do for you?',
      env: 'TELNYX_VOICE_ASSISTANT_ID',
    },
    {
      name: 'Tarka Assistant (concierge)',
      instructions: conciergeInstructions,
      greeting: '',
      env: 'TELNYX_CONCIERGE_ASSISTANT_ID',
    },
  ];
  for (const d of defs) {
    const found = assistants.data.find((a) => a.name === d.name);
    const body = {
      name: d.name,
      model: 'tarka-assistant',
      instructions: d.instructions,
      greeting: d.greeting,
      external_llm: externalLlm,
      enabled_features: ['telephony'],
      voice_settings: { voice: VOICE },
      transcription: { model: 'openai/whisper-large-v3-turbo', language: 'auto' },
      tools: [{ type: 'hangup', hangup: { description: 'End the call once the conversation is finished or the objective is met.' } }],
      privacy_settings: { data_retention: false },
      ...(profileId ? { messaging_settings: { default_messaging_profile_id: profileId } } : {}),
    };
    step(`${found ? 'update' : 'create'} AI assistant "${d.name}" → custom LLM ${externalLlm.base_url}`);
    if (apply) {
      const r = found
        ? await call<{ id?: string; data?: { id: string } }>('POST', `/ai/assistants/${found.id}`, body)
        : await call<{ id?: string; data?: { id: string } }>('POST', '/ai/assistants', body);
      console.log(`  ${d.env}=${r.id ?? r.data?.id ?? found?.id}`);
    }
  }
  if (apply && profileId) console.log(`  TELNYX_MESSAGING_PROFILE_ID=${profileId}`);
  console.log(apply ? '\nDone. Copy the ids above into your environment.' : '\nNothing changed. Re-run with --apply to create these.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
