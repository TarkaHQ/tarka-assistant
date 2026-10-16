import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { config } from '../config.js';

/**
 * Tarka speaks the OpenAI API. Outside a Tarka agent host we call https://tarka.rest/v1 with a
 * tk_live_ key; inside one, OPENAI_BASE_URL=http://tarka/v1 and the host's gateway adds identity.
 */
let provider: ReturnType<typeof createOpenAICompatible> | undefined;

export function tarka() {
  const cfg = config();
  provider ??= createOpenAICompatible({
    name: 'tarka',
    baseURL: cfg.models.baseURL,
    apiKey: cfg.models.apiKey || 'tarka-local',
    includeUsage: true,
    headers: { 'X-Tarka-Client': 'tarka-assistant/0.1' },
  });
  return provider;
}

let modelOverride: ((id: string) => LanguageModel) | undefined;

/** Tests (and evals) can swap in a scripted or alternative model. */
export function setModelOverride(fn: ((id: string) => LanguageModel) | undefined): void {
  modelOverride = fn;
}

export function chatModel(id: string): LanguageModel {
  return modelOverride ? modelOverride(id) : tarka().chatModel(id);
}

export interface ModelInfo {
  id: string;
  label: string;
  blurb: string;
  tier: 'standard' | 'premium';
  /** USD per million tokens */
  price: { in: number; cached: number; out: number };
}

/** Display metadata. Prices are what Tarka charges (October 2026: the provider's price plus 10%); override with MODEL_PRICES. */
const KNOWN: Record<string, Omit<ModelInfo, 'id'>> = {
  'qwen3.8-flash-next': {
    label: 'Qwen 3.8 Flash',
    blurb: 'Runs on Tarka’s own GPUs. Replies can be slow at busy times.',
    tier: 'standard',
    price: { in: 0, cached: 0, out: 0 },
  },
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash',
    blurb: 'Quick, and dependable with tools. Low cost.',
    tier: 'standard',
    price: { in: 0.33, cached: 0.0066, out: 1.32 },
  },
  'glm-5.3-flash': {
    label: 'GLM 5.3 Flash',
    blurb: 'The cheapest option, and dependable for everyday tasks.',
    tier: 'standard',
    price: { in: 0.1485, cached: 0.0297, out: 0.495 },
  },
  'kimi-k3': {
    label: 'Kimi K3',
    blurb: 'The largest model here. Slower, and about ten times the price of DeepSeek.',
    tier: 'premium',
    price: { in: 2.97, cached: 0.297, out: 14.85 },
  },
};

let overrides: Record<string, { in: number; cached?: number; out: number }> | undefined;
function priceOverrides() {
  if (overrides) return overrides;
  const raw = config().models.pricesJson;
  try {
    overrides = raw ? (JSON.parse(raw) as typeof overrides) : {};
  } catch {
    overrides = {};
  }
  return overrides!;
}

export function modelInfo(id: string): ModelInfo {
  const base = KNOWN[id] ?? { label: id, blurb: '', tier: 'standard' as const, price: { in: 0, cached: 0, out: 0 } };
  const o = priceOverrides()[id];
  return { id, ...base, price: o ? { in: o.in, cached: o.cached ?? o.in, out: o.out } : base.price };
}

export function availableModels(): ModelInfo[] {
  return config().models.allowed.map(modelInfo);
}

/** Cost in micro-USD (1e-6 dollars). */
export function costMicroUsd(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number {
  const p = modelInfo(model).price;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  return uncached * p.in + cachedTokens * p.cached + outputTokens * p.out; // tokens * $/1M = micro-dollars
}

export function formatUsd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------
// Utility models: speech-to-text, text-to-speech, OCR (same router, same credentials)
// ---------------------------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const key = config().models.apiKey || 'tarka-local';
  return { Authorization: `Bearer ${key}` };
}

export async function transcribe(audio: Uint8Array, filename: string, mediaType: string, language?: string): Promise<string> {
  const cfg = config();
  const form = new FormData();
  form.append('file', new Blob([audio as BlobPart], { type: mediaType }), filename);
  form.append('model', cfg.models.stt);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  const res = await fetch(`${cfg.models.baseURL}/audio/transcriptions`, { method: 'POST', headers: authHeaders(), body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? '').trim();
}

export async function speak(text: string, voice = 'af_heart', format: 'mp3' | 'opus' = 'opus'): Promise<Uint8Array> {
  const cfg = config();
  const res = await fetch(`${cfg.models.baseURL}/audio/speech`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.models.tts, input: text.slice(0, 4000), voice, response_format: format }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Speech failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function ocr(image: Uint8Array, mediaType: string, prompt?: string): Promise<string> {
  const cfg = config();
  const dataUrl = `data:${mediaType};base64,${Buffer.from(image).toString('base64')}`;
  const res = await fetch(`${cfg.models.baseURL}/ocr`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.models.ocr, image: dataUrl, output_format: 'markdown', ...(prompt ? { prompt } : {}) }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`OCR failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? '').trim();
}
