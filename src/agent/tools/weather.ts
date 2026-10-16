import { z } from 'zod';
import { defineTool, type ToolSpec } from './spec.js';

/** Weather from Open-Meteo (free, no key). */
const CODES: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};

export async function weather(place: string, days = 2, unit: 'celsius' | 'fahrenheit' = 'celsius') {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(place)}`, { signal: AbortSignal.timeout(10_000) });
  if (!geo.ok) throw new Error('Weather lookup failed');
  const g = (await geo.json()) as { results?: { name: string; country?: string; latitude: number; longitude: number; timezone?: string }[] };
  const loc = g.results?.[0];
  if (!loc) throw new Error(`I couldn't find a place called "${place}"`);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(loc.latitude));
  url.searchParams.set('longitude', String(loc.longitude));
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('forecast_days', String(Math.min(Math.max(days, 1), 7)));
  url.searchParams.set('timezone', loc.timezone ?? 'auto');
  url.searchParams.set('temperature_unit', unit);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Weather lookup failed');
  const w = (await res.json()) as {
    current?: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
    daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] };
  };
  const u = unit === 'celsius' ? '°C' : '°F';
  return {
    place: `${loc.name}${loc.country ? `, ${loc.country}` : ''}`,
    now: w.current ? `${Math.round(w.current.temperature_2m)}${u} (feels ${Math.round(w.current.apparent_temperature)}${u}), ${CODES[w.current.weather_code] ?? 'unknown'}` : null,
    days: (w.daily?.time ?? []).map((d, i) => ({
      date: d,
      summary: CODES[w.daily!.weather_code[i]!] ?? 'unknown',
      high: `${Math.round(w.daily!.temperature_2m_max[i]!)}${u}`,
      low: `${Math.round(w.daily!.temperature_2m_min[i]!)}${u}`,
      rain_chance: `${w.daily!.precipitation_probability_max[i] ?? 0}%`,
    })),
  };
}

export const weatherTools: ToolSpec[] = [
  defineTool({
    name: 'weather',
    label: 'Checking the weather',
    description: 'Current weather and a short forecast for a place (defaults to the user’s city when they have one).',
    input: z.object({
      place: z.string().optional().describe('City or place; omit to use the user’s city'),
      days: z.number().int().min(1).max(7).optional(),
      unit: z.enum(['celsius', 'fahrenheit']).optional(),
    }),
    run: async ({ place, days, unit }, ctx) => {
      const where = place ?? ctx.user.city;
      if (!where) throw new Error('No place given and the user’s city is unknown; ask them.');
      const defaultUnit = /^America\/(?!Sao_Paulo|Argentina|Bogota|Lima|Santiago|Caracas)/.test(ctx.user.timezone) ? 'fahrenheit' : 'celsius';
      return weather(where, days ?? 2, unit ?? defaultUnit);
    },
  }),
];
