import { z } from 'zod';

/**
 * All configuration comes from the environment. Inside a Tarka agent host the platform
 * injects OPENAI_BASE_URL=http://tarka/v1 and a placeholder key (the in-host gateway adds
 * the host's identity), so the assistant reaches Tarka's models with no key of its own.
 */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number.parseInt(v, 10)));

const list = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

// European Economic Area: where Meta currently has to allow third-party AI assistants on the
// WhatsApp Business Platform (EU Commission interim measures, June 2026).
const EEA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

const schema = z.object({
  NODE_ENV: z.string().optional().default('development'),
  PORT: int(8080),
  PUBLIC_URL: z.string().optional().default('http://localhost:8080'),
  LOG_LEVEL: z.string().optional().default('info'),

  DATABASE_URL: z.string().default('postgres://assistant:dev@127.0.0.1:5433/assistant'),
  APP_SECRET: z.string().min(16).default('dev-only-secret-change-me-please-0123456789'),

  // Models (Tarka)
  TARKA_BASE_URL: opt,
  TARKA_API_KEY: opt,
  OPENAI_BASE_URL: opt,
  OPENAI_API_KEY: opt,
  TARKA_PRIMARY_MODEL: opt,
  DEFAULT_MODEL: opt,
  FALLBACK_MODEL: opt,
  ALLOWED_MODELS: list(['qwen3.8-flash-next', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k3']),
  MODEL_PRICES: opt, // JSON: {"model":{"in":0.3,"cached":0.006,"out":1.2}} per 1M tokens, USD
  STT_MODEL: z.string().default('whisper-large-v3'),
  TTS_MODEL: z.string().default('kokoro'),
  OCR_MODEL: z.string().default('glm-ocr'),
  MAX_AGENT_STEPS: int(10),

  // Memory (Hindsight)
  HINDSIGHT_URL: z.string().default('http://127.0.0.1:8888'),
  HINDSIGHT_API_KEY: opt,
  MEMORY_ENABLED: bool(true),
  MEMORY_RECALL_TIMEOUT_MS: int(6000),

  // Product
  ASSISTANT_NAME: z.string().default('Tarka'),
  PRODUCT_NAME: z.string().default('Tarka Assistant'),
  SIGNUP_MODE: z.enum(['open', 'invite', 'closed']).default('open'),
  TRIAL_DAYS: int(14),
  PRICE_LABEL: z.string().default('$20/month'),
  DEV_LOGIN: bool(false),

  // Proactivity
  PROACTIVE_ENABLED: bool(true),
  MAX_PROACTIVE_PER_DAY: int(4),
  SCHEDULER_INTERVAL_MS: int(20000),

  // Telegram
  TELEGRAM_BOT_TOKEN: opt,
  TELEGRAM_WEBHOOK_SECRET: opt,
  TELEGRAM_MODE: z.enum(['webhook', 'polling', 'off']).optional(),

  // Telnyx (SMS, WhatsApp, voice)
  TELNYX_API_KEY: opt,
  TELNYX_PUBLIC_KEY: opt, // base64 Ed25519 key from the Telnyx portal, for webhook signatures
  TELNYX_MESSAGING_PROFILE_ID: opt,
  TELNYX_PHONE_NUMBER: opt, // E.164, SMS + voice
  TELNYX_WHATSAPP_NUMBER: opt, // E.164, WhatsApp-enabled
  TELNYX_WHATSAPP_TEMPLATE: opt, // approved utility template for messages outside the 24h window
  WHATSAPP_ALLOWED_COUNTRIES: list(EEA),
  TELNYX_VOICE_ASSISTANT_ID: opt, // assistant used for inbound calls (custom LLM -> /voice/v1)
  TELNYX_CONCIERGE_ASSISTANT_ID: opt, // assistant used for outbound concierge calls
  TELNYX_CONNECTION_ID: opt, // TeXML / call-control application id for outbound calls
  VOICE_LLM_SECRET: opt, // shared secret Telnyx sends as the custom LLM API key

  // Google
  GOOGLE_CLIENT_ID: opt,
  GOOGLE_CLIENT_SECRET: opt,

  // Web search
  SEARCH_PROVIDER: z.enum(['brave', 'tavily', 'searxng', 'none']).optional(),
  BRAVE_API_KEY: opt,
  TAVILY_API_KEY: opt,
  SEARXNG_URL: opt,

  // Email (magic links)
  BREVO_API_KEY: opt,
  EMAIL_FROM: z.string().default('Tarka Assistant <assistant@tarkahq.com>'),

  // Billing
  STRIPE_SECRET_KEY: opt,
  STRIPE_WEBHOOK_SECRET: opt,
  STRIPE_PRICE_ID: opt,

  // Tarka platform extras (sandboxes)
  TARKA_CONTROL_URL: z.string().default('https://tarka.rest'),
  TARKA_ORG_ID: opt,
  SANDBOX_TEMPLATE: z.string().default('python-3.13'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  if (isProd && c.APP_SECRET.startsWith('dev-only')) {
    throw new Error('APP_SECRET must be set in production');
  }
  const baseURL = (c.TARKA_BASE_URL ?? c.OPENAI_BASE_URL ?? 'https://tarka.rest/v1').replace(/\/+$/, '');
  const apiKey = c.TARKA_API_KEY ?? c.OPENAI_API_KEY ?? '';
  const defaultModel = c.DEFAULT_MODEL ?? c.TARKA_PRIMARY_MODEL ?? 'qwen3.8-flash-next';
  const searchProvider =
    c.SEARCH_PROVIDER ??
    (c.BRAVE_API_KEY ? 'brave' : c.TAVILY_API_KEY ? 'tavily' : c.SEARXNG_URL ? 'searxng' : 'none');
  const telegramMode = c.TELEGRAM_MODE ?? (c.TELEGRAM_BOT_TOKEN ? (isProd ? 'webhook' : 'polling') : 'off');

  return {
    env: c.NODE_ENV,
    isProd,
    port: c.PORT,
    publicUrl: c.PUBLIC_URL.replace(/\/+$/, ''),
    logLevel: c.LOG_LEVEL,
    databaseUrl: c.DATABASE_URL,
    appSecret: c.APP_SECRET,
    models: {
      baseURL,
      apiKey,
      defaultModel,
      fallbackModel: c.FALLBACK_MODEL,
      allowed: Array.from(new Set([defaultModel, ...c.ALLOWED_MODELS])),
      pricesJson: c.MODEL_PRICES,
      stt: c.STT_MODEL,
      tts: c.TTS_MODEL,
      ocr: c.OCR_MODEL,
      maxSteps: c.MAX_AGENT_STEPS,
    },
    memory: {
      url: c.HINDSIGHT_URL.replace(/\/+$/, ''),
      apiKey: c.HINDSIGHT_API_KEY,
      enabled: c.MEMORY_ENABLED,
      recallTimeoutMs: c.MEMORY_RECALL_TIMEOUT_MS,
    },
    product: {
      assistantName: c.ASSISTANT_NAME,
      productName: c.PRODUCT_NAME,
      signupMode: c.SIGNUP_MODE,
      trialDays: c.TRIAL_DAYS,
      priceLabel: c.PRICE_LABEL,
      devLogin: c.DEV_LOGIN && !isProd,
    },
    proactive: {
      enabled: c.PROACTIVE_ENABLED,
      maxPerDay: c.MAX_PROACTIVE_PER_DAY,
      schedulerIntervalMs: c.SCHEDULER_INTERVAL_MS,
    },
    telegram: {
      token: c.TELEGRAM_BOT_TOKEN,
      webhookSecret: c.TELEGRAM_WEBHOOK_SECRET,
      mode: telegramMode as 'webhook' | 'polling' | 'off',
    },
    telnyx: {
      apiKey: c.TELNYX_API_KEY,
      publicKey: c.TELNYX_PUBLIC_KEY,
      messagingProfileId: c.TELNYX_MESSAGING_PROFILE_ID,
      phoneNumber: c.TELNYX_PHONE_NUMBER,
      whatsappNumber: c.TELNYX_WHATSAPP_NUMBER,
      whatsappTemplate: c.TELNYX_WHATSAPP_TEMPLATE,
      whatsappAllowedCountries: c.WHATSAPP_ALLOWED_COUNTRIES.map((s) => s.toUpperCase()),
      voiceAssistantId: c.TELNYX_VOICE_ASSISTANT_ID,
      conciergeAssistantId: c.TELNYX_CONCIERGE_ASSISTANT_ID,
      connectionId: c.TELNYX_CONNECTION_ID,
      voiceLlmSecret: c.VOICE_LLM_SECRET,
    },
    google: {
      clientId: c.GOOGLE_CLIENT_ID,
      clientSecret: c.GOOGLE_CLIENT_SECRET,
      enabled: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
    },
    search: {
      provider: searchProvider as 'brave' | 'tavily' | 'searxng' | 'none',
      braveKey: c.BRAVE_API_KEY,
      tavilyKey: c.TAVILY_API_KEY,
      searxngUrl: c.SEARXNG_URL,
    },
    email: { brevoKey: c.BREVO_API_KEY, from: c.EMAIL_FROM },
    stripe: {
      secretKey: c.STRIPE_SECRET_KEY,
      webhookSecret: c.STRIPE_WEBHOOK_SECRET,
      priceId: c.STRIPE_PRICE_ID,
      enabled: Boolean(c.STRIPE_SECRET_KEY && c.STRIPE_PRICE_ID),
    },
    tarka: {
      controlUrl: c.TARKA_CONTROL_URL.replace(/\/+$/, ''),
      orgId: c.TARKA_ORG_ID,
      sandboxTemplate: c.SANDBOX_TEMPLATE,
    },
  };
}

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** For tests: replace the cached configuration. */
export function setConfig(next: Config): void {
  cached = next;
}
