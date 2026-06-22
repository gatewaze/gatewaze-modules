/**
 * R5 — "follow the sun" replay (spec §5, phase-2 showpiece). A time scrubber
 * over the choropleth: countries bloom with cumulative engagement as the send
 * rolls through timezones. Powered by the timeline RPC (per-event IP regions, or
 * email_send_log timestamps + profile region for imported editions).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { TimelineRow } from './geo-types.js';
import { countryName, resolveA3, featurePath } from './world-geo.js';
import { WORLD_FEATURES } from './world-atlas.js';
import { heatColor } from './geo-format.js';
import { ReportFrame, Toggle } from './_shared.js';

const W = 760;
const H = 380;
const NO_DATA = '#e7ecf3';
const BUCKET_MINUTES = 30;
const WORLD_PATHS = WORLD_FEATURES.map((f) => ({ a3: f.a3, name: f.name, d: featurePath(f.rings, W, H) }));

type Metric = 'clicks' | 'opens';

export function FollowTheSun({ editionId }: { editionId: string }) {
  const [metric, setMetric] = useState<Metric>('clicks');
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);

  const { env, loading, error, schemaMismatch } = useGeoRpc<TimelineRow>(
    'newsletter_engagement_timeline',
    { p_edition_id: editionId, p_bucket_minutes: BUCKET_MINUTES },
    [editionId],
  );

  // ordered distinct buckets + cumulative value per region up to each bucket
  const { buckets, cumulative, maxCum } = useMemo(() => {
    const rows = env?.data ?? [];
    const bset = [...new Set(rows.map((r) => r.bucket_start))].sort();
    const byBucket = new Map<string, TimelineRow[]>();
    for (const r of rows) {
      const a = byBucket.get(r.bucket_start) ?? [];
      a.push(r);
      byBucket.set(r.bucket_start, a);
    }
    const cum: Array<Map<string, number>> = [];
    const running = new Map<string, number>();
    let mx = 0;
    for (const b of bset) {
      for (const r of byBucket.get(b) ?? []) {
        const v = metric === 'clicks' ? r.clicks : r.opens;
        running.set(r.region_code, (running.get(r.region_code) ?? 0) + v);
        if ((running.get(r.region_code) ?? 0) > mx) mx = running.get(r.region_code) ?? 0;
      }
      cum.push(new Map(running));
    }
    return { buckets: bset, cumulative: cum, maxCum: mx };
  }, [env, metric]);

  // clamp index when data changes
  useEffect(() => { setIdx((i) => Math.min(i, Math.max(0, buckets.length - 1))); }, [buckets.length]);

  // playback
  useEffect(() => {
    if (!playing || buckets.length === 0) return;
    let last = 0;
    const step = (ts: number) => {
      if (ts - last > 600) {
        last = ts;
        setIdx((i) => {
          if (i >= buckets.length - 1) { setPlaying(false); return i; }
          return i + 1;
        });
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, buckets.length]);

  const frame = cumulative[idx] ?? new Map<string, number>();
  // resolve cumulative region values to atlas A3 (summing regions that map to
  // the same country, e.g. "United States" + "US")
  const byA3 = useMemo(() => {
    const m = new Map<string, { v: number; label: string }>();
    for (const [code, v] of frame.entries()) {
      const a3 = resolveA3(code);
      if (!a3) continue;
      const prev = m.get(a3);
      m.set(a3, { v: (prev?.v ?? 0) + v, label: countryName(code) });
    }
    return m;
  }, [frame]);

  const stamp = buckets[idx] ? new Date(buckets[idx]).toUTCString().replace(' GMT', ' UTC') : '';

  return (
    <ReportFrame
      title="Follow the sun"
      description="Watch engagement roll across the globe as the staggered send reaches each timezone."
      loading={loading}
      error={error}
      schemaMismatch={schemaMismatch}
      env={env}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Toggle ariaLabel="Metric" value={metric} onChange={setMetric}
          options={[{ value: 'clicks', label: 'Clicks' }, { value: 'opens', label: 'Opens' }]} />
        <button type="button" onClick={() => { if (idx >= buckets.length - 1) setIdx(0); setPlaying((p) => !p); }}
          className="rounded-md border border-gray-200 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50">
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <span className="ml-auto font-mono text-xs text-gray-500">{stamp}</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-gray-100 bg-[#eef4fb]" role="img"
           aria-label="Animated world choropleth of cumulative engagement">
        {WORLD_PATHS.map((f) => {
          const hit = byA3.get(f.a3);
          const fill = hit && maxCum ? heatColor(hit.v / maxCum) : NO_DATA;
          return (
            <path key={f.a3} d={f.d} fill={fill} fillRule="evenodd" stroke="#ffffff" strokeWidth={0.4}>
              <title>{hit ? `${hit.label}: ${hit.v} ${metric}` : f.name}</title>
            </path>
          );
        })}
      </svg>

      <input type="range" min={0} max={Math.max(0, buckets.length - 1)} value={idx}
        onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
        className="mt-3 w-full" aria-label="Timeline position" />
    </ReportFrame>
  );
}
