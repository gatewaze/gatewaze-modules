/**
 * R5 — "follow the sun" replay (spec §5, phase-2 showpiece). A time scrubber
 * over the bubble map: engagement blooms across regions as the send rolls
 * through timezones. Loads after the static reports (it’s the heaviest) and is
 * read-only over the timeline RPC.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { TimelineRow } from './geo-types.js';
import { project, centroid, countryName } from './world-geo.js';
import { heatColor } from './geo-format.js';
import { ReportFrame, Toggle } from './_shared.js';

const W = 720;
const H = 360;
const BUCKET_MINUTES = 30;

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
  const bubbles = useMemo(
    () =>
      [...frame.entries()]
        .map(([code, v]) => {
          const c = centroid(code);
          if (!c) return null;
          const p = project(c.lng, c.lat, W, H);
          return { code, v, x: p.x, y: p.y, t: maxCum ? v / maxCum : 0 };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null),
    [frame, maxCum],
  );

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

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-gray-100 bg-[#f0f5fb]" role="img"
           aria-label="Animated world map of cumulative engagement">
        {[...Array(11)].map((_, i) => (
          <line key={`v${i}`} x1={(i / 11) * W} y1={0} x2={(i / 11) * W} y2={H} stroke="#dbe6f3" strokeWidth={1} />
        ))}
        {[...Array(6)].map((_, i) => (
          <line key={`h${i}`} x1={0} y1={(i / 6) * H} x2={W} y2={(i / 6) * H} stroke="#dbe6f3" strokeWidth={1} />
        ))}
        {bubbles.map((b) => (
          <circle key={b.code} cx={b.x} cy={b.y} r={6 + b.t * 22} fill={heatColor(b.t)} fillOpacity={0.75} stroke="#fff" strokeWidth={1}>
            <title>{countryName(b.code)}: {b.v} {metric}</title>
          </circle>
        ))}
      </svg>

      <input type="range" min={0} max={Math.max(0, buckets.length - 1)} value={idx}
        onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
        className="mt-3 w-full" aria-label="Timeline position" />
    </ReportFrame>
  );
}
