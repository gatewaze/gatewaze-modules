/**
 * VENDORED COPY of modules/newsletters/workers/weather-personalisation.ts —
 * kept in sync (edge runtime cannot import across the modules/ tree). Pure /
 * fetch-only, Deno-safe.
 */

 * bindings resolve weather identically (per spec-broadcasts-blocks §11.4).
 */

export const WEATHER_TOKENS = ['weather_emoji', 'weather_temp', 'weather_summary', 'weather_location'];

export function weatherEmoji(code: number): { emoji: string; summary: string } {
  if (code === 0) return { emoji: '☀️', summary: 'Clear sky' };
  if (code <= 2) return { emoji: '⛅', summary: 'Partly cloudy' };
  if (code === 3) return { emoji: '☁️', summary: 'Overcast' };
  if (code >= 45 && code <= 48) return { emoji: '🌫️', summary: 'Fog' };
  if (code >= 51 && code <= 67) return { emoji: '🌧️', summary: 'Rain' };
  if (code >= 71 && code <= 86) return { emoji: '🌨️', summary: 'Snow' };
  if (code >= 95) return { emoji: '⛈️', summary: 'Thunderstorm' };
  return { emoji: '🌡️', summary: 'Weather' };
}

export async function resolveWeather(
  city: string,
  country: string,
  units: 'celsius' | 'fahrenheit',
): Promise<Record<string, string>> {
  const blank = { weather_emoji: '', weather_temp: '', weather_summary: 'Weather unavailable for your location.', weather_location: '' };
  if (!city) return blank;
  try {
    const gp = new URLSearchParams({ name: city.trim(), count: '1', language: 'en', format: 'json' });
    if (country.trim()) gp.set('country', country.trim());
    const gres = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${gp}`);
    const gj = gres.ok ? (await gres.json()) as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> } : null;
    const hit = gj?.results?.[0]; if (!hit) return blank;
    const wp = new URLSearchParams({ latitude: String(hit.latitude), longitude: String(hit.longitude), current: 'temperature_2m,weather_code', temperature_unit: units });
    const wres = await fetch(`https://api.open-meteo.com/v1/forecast?${wp}`);
    const wj = wres.ok ? (await wres.json()) as { current?: { temperature_2m?: number; weather_code?: number } } : null;
    const t = wj?.current?.temperature_2m, c = wj?.current?.weather_code;
    if (typeof t !== 'number' || typeof c !== 'number') return blank;
    const { emoji, summary } = weatherEmoji(c);
    return { weather_emoji: emoji, weather_temp: `${Math.round(t)}${units === 'fahrenheit' ? '°F' : '°C'}`, weather_summary: summary, weather_location: `${hit.name}${hit.country ? `, ${hit.country}` : ''}` };
  } catch { return blank; }
}
