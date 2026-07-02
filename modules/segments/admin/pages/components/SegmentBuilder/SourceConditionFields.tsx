import React, { useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  SourceCondition,
  SegmentCondition,
  ConditionSource,
  createSegmentService,
} from '@/lib/segments';

interface SourceConditionFieldsProps {
  condition: SourceCondition;
  source: ConditionSource;
  onChange: (condition: SegmentCondition) => void;
}

const inputCls =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500';

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Manual editor for a registry (module-contributed) condition — geo_radius,
 * event_registration, calendar_member, ambassador_application, … Driven by the
 * source's params_schema + vocabulary (entities) from segments_sources_catalog,
 * so new sources get an editor with no code change. geo_radius is special-cased
 * to geocode its place → lat/lng (stored on the condition) from our own data.
 */
export function SourceConditionFields({ condition, source, onChange }: SourceConditionFieldsProps) {
  const [geoNote, setGeoNote] = useState<string>('');
  const props = source.params_schema?.properties ?? {};
  const entityProp = Object.entries(props).find(([, d]) => d?.['x-entity-source'])?.[0] ?? null;

  const set = (patch: Record<string, unknown>) => onChange({ ...condition, ...patch });

  async function geocodePlace(place: string) {
    if (!place.trim() || !supabase) { set({ lat: null, lng: null }); return; }
    try {
      const g = await createSegmentService(supabase).geocodePlace(place.trim());
      if (g) { set({ lat: g.lat, lng: g.lng }); setGeoNote(`Located from ${g.n ?? 0} nearby contact${g.n === 1 ? '' : 's'}.`); }
      else { set({ lat: null, lng: null }); setGeoNote(`Couldn't locate "${place}" from our data — this will match nobody. Try a larger nearby city.`); }
    } catch { setGeoNote('Geocoding failed.'); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap">
        {/* Operator (is / is_not / within / …) */}
        {source.operators && source.operators.length > 0 && (
          <div className="min-w-[120px]">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Condition</label>
            <select
              value={condition.operator ?? source.operators[0]}
              onChange={(e) => set({ operator: e.target.value })}
              className={inputCls}
            >
              {source.operators.map((op) => <option key={op} value={op}>{humanize(op)}</option>)}
            </select>
          </div>
        )}

        {/* Entity picker (x-entity-source), e.g. which event / calendar / programme */}
        {entityProp && (
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{source.label}</label>
            <select
              value={(condition[entityProp] as string) ?? ''}
              onChange={(e) => set({ [entityProp]: e.target.value })}
              className={inputCls}
            >
              <option value="">Select…</option>
              {(source.entities ?? []).map((ent) => <option key={ent.id} value={ent.id}>{ent.label}</option>)}
            </select>
            {source.entities_truncated && (
              <p className="text-xs text-gray-400 mt-1">List truncated — type in the copilot if the one you want is missing.</p>
            )}
          </div>
        )}
      </div>

      {/* Remaining params (skip the entity prop + lat/lng which are derived) */}
      <div className="flex items-end gap-3 flex-wrap">
        {Object.entries(props).map(([key, def]) => {
          if (key === entityProp || key === 'lat' || key === 'lng') return null;
          const isGeoPlace = source.kind === 'geo_radius' && key === 'place';
          const isNumber = def?.type === 'number' || key === 'radius_km';
          const isArray = def?.type === 'array';
          const val = condition[key];
          return (
            <div key={key} className={isGeoPlace ? 'flex-1 min-w-[200px]' : 'min-w-[140px]'}>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {humanize(key)}{isNumber && key === 'radius_km' ? ' (km)' : ''}
              </label>
              {Array.isArray(def?.enum) ? (
                <select value={(val as string) ?? ''} onChange={(e) => set({ [key]: e.target.value })} className={inputCls}>
                  <option value="">Any</option>
                  {def!.enum!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : isArray ? (
                <input
                  value={Array.isArray(val) ? (val as string[]).join(', ') : ''}
                  onChange={(e) => set({ [key]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                  placeholder="comma,separated"
                  className={inputCls}
                />
              ) : (
                <input
                  type={isNumber ? 'number' : 'text'}
                  value={(val as string | number) ?? ''}
                  onChange={(e) => set({ [key]: e.target.value })}
                  onBlur={isGeoPlace ? (e) => geocodePlace(e.target.value) : undefined}
                  placeholder={isGeoPlace ? 'e.g. San Francisco' : ''}
                  className={inputCls}
                />
              )}
            </div>
          );
        })}
      </div>

      {source.kind === 'geo_radius' && (geoNote || condition.lat != null) && (
        <p className="text-xs text-gray-500 dark:text-gray-400 pl-1">
          {condition.lat != null && !geoNote ? 'Centre located from our contact data.' : geoNote}
        </p>
      )}
    </div>
  );
}
