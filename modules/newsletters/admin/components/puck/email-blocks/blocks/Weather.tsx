/**
 * Weather email block — inserts per-recipient weather based on the
 * recipient's `people.city` and `people.country` fields.
 *
 * Two render paths share one component:
 *
 *   - **Editor preview** (`editMode === true`): Puck's `resolveData`
 *     hook hits open-meteo for the configured `sample_city` /
 *     `sample_country` when the block is inserted or those fields
 *     change. The resolved values land in `previewWeather` and the
 *     Component renders them so the canvas shows realistic content.
 *
 *   - **Publish** (`editMode === false`): the Component emits Mustache
 *     placeholders (`{{weather_emoji}}`, `{{weather_temp}}`,
 *     `{{weather_summary}}`, `{{weather_location}}`) — newsletter-send
 *     substitutes them per recipient before delivery. If the
 *     recipient has no city/country or open-meteo fails at send time,
 *     the send pipeline substitutes `fallback_text` instead.
 *
 * Why Mustache for personalisation rather than `resolveData`:
 * `resolveData` is a Puck-editor hook only — it does not run in the
 * send pipeline, and personalisation needs to happen per recipient
 * server-side. The placeholder approach matches the existing
 * `{{unsubscribe_url}}` substitution path in
 * `newsletter-send/index.ts`.
 */

import { Section, Text } from '@react-email/components';
import type {
  EmailBlockEntry,
  EmailBlockResolveData,
} from '../registry-types.js';

interface WeatherProps extends Record<string, unknown> {
  intro_text: string;
  units: 'celsius' | 'fahrenheit';
  sample_city: string;
  sample_country: string;
  fallback_text: string;
  // Derived in the editor by `resolveData`. Not user-editable; the
  // field config marks these as type 'text' but readOnly is set on
  // every resolve so Puck disables the inputs.
  preview_emoji?: string;
  preview_temp?: string;
  preview_summary?: string;
  preview_location?: string;
}

// ---------------------------------------------------------------------------
// open-meteo helpers (editor-side preview only)
// ---------------------------------------------------------------------------
//
// Send-time fetching lives in newsletter-send/index.ts. These run in
// the Puck editor against the same free open-meteo endpoints; no API
// key required.

interface GeocodeHit {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
}

async function geocode(city: string, country: string): Promise<GeocodeHit | null> {
  const params = new URLSearchParams({
    name: city.trim(),
    count: '1',
    language: 'en',
    format: 'json',
  });
  if (country.trim()) params.set('country', country.trim());
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: GeocodeHit[] };
    return json.results?.[0] ?? null;
  } catch {
    return null;
  }
}

interface CurrentWeather {
  temperature: number;
  weatherCode: number;
}

async function currentWeather(
  hit: GeocodeHit,
  units: 'celsius' | 'fahrenheit',
): Promise<CurrentWeather | null> {
  const params = new URLSearchParams({
    latitude: String(hit.latitude),
    longitude: String(hit.longitude),
    current: 'temperature_2m,weather_code',
    temperature_unit: units,
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const t = json.current?.temperature_2m;
    const c = json.current?.weather_code;
    if (typeof t !== 'number' || typeof c !== 'number') return null;
    return { temperature: t, weatherCode: c };
  } catch {
    return null;
  }
}

// open-meteo WMO weather codes → emoji + short description.
// https://open-meteo.com/en/docs#weathervariables
export function weatherCodeToEmoji(code: number): { emoji: string; summary: string } {
  if (code === 0) return { emoji: '☀️', summary: 'Clear sky' };
  if (code === 1) return { emoji: '🌤️', summary: 'Mainly clear' };
  if (code === 2) return { emoji: '⛅', summary: 'Partly cloudy' };
  if (code === 3) return { emoji: '☁️', summary: 'Overcast' };
  if (code === 45 || code === 48) return { emoji: '🌫️', summary: 'Fog' };
  if (code >= 51 && code <= 57) return { emoji: '🌦️', summary: 'Drizzle' };
  if (code >= 61 && code <= 67) return { emoji: '🌧️', summary: 'Rain' };
  if (code >= 71 && code <= 77) return { emoji: '🌨️', summary: 'Snow' };
  if (code >= 80 && code <= 82) return { emoji: '🌧️', summary: 'Rain showers' };
  if (code === 85 || code === 86) return { emoji: '🌨️', summary: 'Snow showers' };
  if (code >= 95 && code <= 99) return { emoji: '⛈️', summary: 'Thunderstorm' };
  return { emoji: '🌡️', summary: 'Weather' };
}

// ---------------------------------------------------------------------------
// Puck resolveData
// ---------------------------------------------------------------------------

const resolveData: EmailBlockResolveData<WeatherProps> = async (data, params) => {
  const { sample_city, sample_country, units } = data.props;
  // Skip when the sample fields haven't changed and we already have a
  // preview — avoids hammering open-meteo on every prop edit.
  const changed = params.changed ?? {};
  const last = params.lastData?.props;
  const samplesUnchanged =
    !changed.sample_city &&
    !changed.sample_country &&
    !changed.units &&
    params.trigger !== 'insert' &&
    params.trigger !== 'force';
  if (samplesUnchanged && last?.preview_temp) {
    return {
      props: {
        preview_emoji: last.preview_emoji,
        preview_temp: last.preview_temp,
        preview_summary: last.preview_summary,
        preview_location: last.preview_location,
      },
      readOnly: {
        preview_emoji: true,
        preview_temp: true,
        preview_summary: true,
        preview_location: true,
      },
    };
  }

  if (!sample_city) {
    return {
      props: {
        preview_emoji: '',
        preview_temp: '',
        preview_summary: '',
        preview_location: '',
      },
      readOnly: {
        preview_emoji: true,
        preview_temp: true,
        preview_summary: true,
        preview_location: true,
      },
    };
  }

  const hit = await geocode(sample_city, sample_country);
  if (!hit) {
    return {
      props: {
        preview_emoji: '❓',
        preview_temp: '',
        preview_summary: 'Location not found',
        preview_location: `${sample_city}${sample_country ? `, ${sample_country}` : ''}`,
      },
      readOnly: {
        preview_emoji: true,
        preview_temp: true,
        preview_summary: true,
        preview_location: true,
      },
    };
  }

  const w = await currentWeather(hit, units);
  if (!w) {
    return {
      props: {
        preview_emoji: '❓',
        preview_temp: '',
        preview_summary: 'Forecast unavailable',
        preview_location: `${hit.name}${hit.country ? `, ${hit.country}` : ''}`,
      },
      readOnly: {
        preview_emoji: true,
        preview_temp: true,
        preview_summary: true,
        preview_location: true,
      },
    };
  }

  const { emoji, summary } = weatherCodeToEmoji(w.weatherCode);
  const tempUnit = units === 'fahrenheit' ? '°F' : '°C';
  return {
    props: {
      preview_emoji: emoji,
      preview_temp: `${Math.round(w.temperature)}${tempUnit}`,
      preview_summary: summary,
      preview_location: `${hit.name}${hit.country ? `, ${hit.country}` : ''}`,
    },
    readOnly: {
      preview_emoji: true,
      preview_temp: true,
      preview_summary: true,
      preview_location: true,
    },
  };
};

// ---------------------------------------------------------------------------
// Block entry
// ---------------------------------------------------------------------------

export const WeatherBlock: EmailBlockEntry<WeatherProps> = {
  componentId: 'weather',
  label: 'Weather',
  category: 'Content',
  fields: {
    intro_text: { type: 'text', label: 'Intro text (optional)' },
    units: {
      type: 'select',
      label: 'Units',
      options: [
        { label: 'Celsius', value: 'celsius' },
        { label: 'Fahrenheit', value: 'fahrenheit' },
      ],
    },
    // contentEditable disabled — resolveData passes these to geocode()
    // which does `.trim()`; the inline-edit wrapper would turn the value
    // into an object and break the preview lookup.
    sample_city: { type: 'text', label: 'Editor preview — city', contentEditable: false },
    sample_country: { type: 'text', label: 'Editor preview — country (optional)', contentEditable: false },
    fallback_text: {
      type: 'textarea',
      label: 'Fallback text (used when recipient location unknown)',
    },
    preview_emoji: { type: 'text', label: 'Resolved emoji (preview)' },
    preview_temp: { type: 'text', label: 'Resolved temperature (preview)' },
    preview_summary: { type: 'text', label: 'Resolved summary (preview)' },
    preview_location: { type: 'text', label: 'Resolved location (preview)' },
  },
  defaultProps: {
    intro_text: 'Your local forecast',
    units: 'celsius',
    sample_city: 'London',
    sample_country: 'United Kingdom',
    fallback_text: 'Weather data is unavailable for your location.',
    preview_emoji: '',
    preview_temp: '',
    preview_summary: '',
    preview_location: '',
  },
  resolveData,
  Component: ({
    intro_text,
    units,
    fallback_text,
    preview_emoji,
    preview_temp,
    preview_summary,
    preview_location,
    editMode,
  }) => {
    // Editor (canvas) path: render whatever resolveData populated. If
    // the resolver hasn't run yet or failed, show the fallback text so
    // the author sees what recipients with no location would see.
    if (editMode) {
      const hasPreview = Boolean(preview_temp || preview_summary);
      return (
        <Section
          style={{
            padding: '24px',
            backgroundColor: '#EFF6FF',
            borderRadius: 10,
            textAlign: 'center',
          }}
        >
          {intro_text ? (
            <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#1E3A8A' }}>
              {intro_text}
            </Text>
          ) : null}
          {hasPreview ? (
            <>
              <Text
                style={{
                  margin: '0 0 4px',
                  fontSize: 36,
                  lineHeight: '1.2',
                }}
              >
                {preview_emoji} {preview_temp}
              </Text>
              <Text style={{ margin: 0, fontSize: 14, color: '#1E3A8A' }}>
                {preview_summary}
              </Text>
              {preview_location ? (
                <Text style={{ margin: '4px 0 0', fontSize: 12, color: '#64748B' }}>
                  {preview_location}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={{ margin: 0, fontSize: 14, color: '#1E3A8A' }}>
              {fallback_text}
            </Text>
          )}
          <Text style={{ margin: '12px 0 0', fontSize: 11, color: '#64748B' }}>
            Recipients see weather for their own location.
          </Text>
        </Section>
      );
    }

    // Publish path: emit Mustache placeholders. newsletter-send
    // substitutes these per recipient using open-meteo against the
    // person's `people.city` / `people.country`. Recipients without
    // location data get empty strings for emoji/temp/location and a
    // generic "Weather unavailable" summary substituted in by the send
    // pipeline (the per-block `fallback_text` is editor-only — keeping
    // it simple avoids parsing per-block markers out of a multi-block
    // edition).
    //
    // The `<!--gw-weather-units:...-->` marker tells the send pipeline
    // which open-meteo `temperature_unit` to request. It defaults to
    // celsius if absent.
    return (
      <Section
        style={{
          padding: '24px',
          backgroundColor: '#EFF6FF',
          borderRadius: 10,
          textAlign: 'center',
        }}
      >
        <span
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: `<!--gw-weather-units:${units === 'fahrenheit' ? 'fahrenheit' : 'celsius'}-->`,
          }}
          style={{ display: 'none' }}
        />
        {intro_text ? (
          <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#1E3A8A' }}>
            {intro_text}
          </Text>
        ) : null}
        <Text style={{ margin: '0 0 4px', fontSize: 36, lineHeight: '1.2' }}>
          {'{{weather_emoji}}'} {'{{weather_temp}}'}
        </Text>
        <Text style={{ margin: 0, fontSize: 14, color: '#1E3A8A' }}>
          {'{{weather_summary}}'}
        </Text>
        <Text style={{ margin: '4px 0 0', fontSize: 12, color: '#64748B' }}>
          {'{{weather_location}}'}
        </Text>
      </Section>
    );
  },
};
