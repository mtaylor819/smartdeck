import type { Config } from './config.js';
import { cmd } from './protocol.js';

// WMO weather interpretation codes (the firmware uses the same codes for its icons).
const WMO: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers',
  81: 'Rain showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail',
};
export const describeWmo = (code: number) => WMO[code] ?? 'Unknown';

/** Fetch current weather from Open-Meteo (no API key) and build the deck's WEATHER line. */
export async function weatherLine(
  w: NonNullable<Config['weather']>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!(Math.abs(w.lat) <= 90) || !(Math.abs(w.lon) <= 180)) throw new Error('weather lat/lon out of range');
  const celsius = w.celsius ?? true;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}` +
    `&current=temperature_2m,weather_code,is_day&temperature_unit=${celsius ? 'celsius' : 'fahrenheit'}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const cur = ((await r.json()) as any).current;
  if (!cur || typeof cur.temperature_2m !== 'number') throw new Error('unexpected Open-Meteo response');
  return cmd.weather(cur.temperature_2m, cur.weather_code, cur.is_day === 1, celsius, describeWmo(cur.weather_code), w.city ?? '');
}
