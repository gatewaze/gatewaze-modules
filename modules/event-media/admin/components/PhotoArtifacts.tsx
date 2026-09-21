import { useEffect, useState } from 'react';
import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { HostMediaItem } from '../utils/mediaOrganizerService';
import {
  MAX_FAR_INSIDE,
  MAX_NEAR_OUTSIDE,
  PLATE_MIN_CHANGE,
  depthVerdict,
  layerAgreementScore,
  plateChangeScore,
  type DepthVerdict,
} from '../../lib/depth-quality.js';

/**
 * Everything that sits behind one photo: the layers the projector builds
 * its 3D effect from, the Wedflix copy, which view it plays in, and --
 * the part most worth seeing -- whether the projector will actually use
 * the 3D effect for it, and if not, why.
 *
 * The verdict is computed here with the same shared arithmetic the
 * projector uses (lib/depth-quality.ts), so what this says and what the
 * screen does cannot disagree.
 */

const VIEW_NAMES: Record<string, string> = {
  seed: 'Preload', preload: 'Preload', day: 'The day', booth: 'Photo booth',
};

interface Card {
  title?: string;
  words?: string[];
  genre?: string;
  kind?: string;
  eyebrow?: string;
}

/**
 * The bucket's public URL, taken from the photo's own cdn_url rather than
 * rebuilt from configuration, so it keeps working whatever the storage
 * host is.
 */
function artifactUrl(item: HostMediaItem, path: string | undefined): string | null {
  if (!path) return null;
  if (/^https?:/i.test(path)) return path;
  const m = /^(.*\/storage\/v1\/object\/public\/[^/]+\/)/.exec(item.cdn_url);
  return m ? m[1] + path : null;
}

function load(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new window.Image();
    // Required to read pixels back for the verdict.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** RGBA pixels at the coarse size the projector judges at. */
function read(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray | null {
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
}

interface Scored {
  verdict: DepthVerdict;
  plateChange: number | null;
  agreement: { nearOutside: number; farInside: number } | null;
}

async function score(item: HostMediaItem): Promise<Scored> {
  const v = item.variants ?? {};
  const [photo, plate, cutout, depth] = await Promise.all([
    load(item.medium_url ?? item.cdn_url),
    load(artifactUrl(item, v.plate)),
    load(artifactUrl(item, v.cutout)),
    load(artifactUrl(item, v.depth)),
  ]);

  const W = 128;
  let plateChange: number | null = null;
  if (photo && plate && cutout) {
    const H = Math.max(1, Math.round((photo.naturalHeight / photo.naturalWidth) * W));
    const a = read(photo, W, H), b = read(plate, W, H), m = read(cutout, W, H);
    if (a && b && m) plateChange = plateChangeScore(a, b, m, W * H);
  }
  let agreement: Scored['agreement'] = null;
  if (depth && cutout) {
    const H = Math.max(1, Math.round((cutout.naturalHeight / cutout.naturalWidth) * W));
    const d = read(depth, W, H), m = read(cutout, W, H);
    if (d && m) agreement = layerAgreementScore(d, m, W * H);
  }
  return {
    plateChange,
    agreement,
    verdict: depthVerdict({
      hasPlate: !!plate, hasCutout: !!cutout, hasDepth: !!depth, plateChange, agreement,
    }),
  };
}

function Measure({ label, value, limit, better }: {
  label: string; value: number | null; limit: number; better: 'above' | 'below';
}) {
  if (value === null) return null;
  const ok = better === 'above' ? value >= limit : value <= limit;
  const fmt = (n: number) => (limit < 1 ? n.toFixed(3) : n.toFixed(1));
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-[var(--gray-a10)]">{label}</span>
      <span className={ok ? '' : 'font-medium text-[var(--red-11)]'}>
        {fmt(value)} <span className="text-[var(--gray-a9)]">({better === 'above' ? '≥' : '≤'} {fmt(limit)})</span>
      </span>
    </div>
  );
}

export function PhotoArtifacts({ item }: { item: HostMediaItem }) {
  const v = item.variants ?? {};
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const card = (meta.card && typeof meta.card === 'object' ? meta.card : null) as Card | null;
  const album = typeof meta.album === 'string' ? meta.album : 'seed';
  const hidden = meta.hidden === true;

  const [scored, setScored] = useState<Scored | null>(null);
  useEffect(() => {
    let live = true;
    setScored(null);
    void score(item).then((s) => { if (live) setScored(s); });
    return () => { live = false; };
  }, [item]);

  const layers: Array<{ key: string; label: string; url: string | null; note: string; checker?: boolean }> = [
    { key: 'original', label: 'Original', url: item.cdn_url, note: item.width && item.height ? `${item.width} × ${item.height}` : 'as uploaded' },
    { key: 'hires', label: 'Upscaled', url: artifactUrl(item, v.hires), note: 'shown on the projector when present' },
    { key: 'depth', label: 'Depth map', url: artifactUrl(item, v.depth), note: 'brighter is nearer' },
    { key: 'cutout', label: 'People', url: artifactUrl(item, v.cutout), note: 'the layer that holds still', checker: true },
    { key: 'plate', label: 'Background', url: artifactUrl(item, v.plate), note: 'the layer that pans' },
  ];

  return (
    <section className="mt-5 space-y-4 border-t border-[var(--gray-a5)] pt-4 text-sm">
      <h3 className="text-base font-semibold">Behind this photo</h3>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-[var(--gray-a2)] p-3">
          <div className="text-xs text-[var(--gray-a10)]">Plays in</div>
          <div className="mt-0.5 font-medium">{VIEW_NAMES[album] ?? album}</div>
        </div>
        <div className="rounded-lg bg-[var(--gray-a2)] p-3">
          <div className="text-xs text-[var(--gray-a10)]">On the projector</div>
          <div className="mt-0.5 font-medium">
            {hidden ? <span className="text-[var(--amber-11)]">Hidden</span> : 'Shown'}
          </div>
          {hidden && typeof meta.hidden_reason === 'string' && (
            <div className="text-xs text-[var(--gray-a10)]">{meta.hidden_reason}</div>
          )}
        </div>
        <div className="rounded-lg bg-[var(--gray-a2)] p-3">
          <div className="text-xs text-[var(--gray-a10)]">3D effect</div>
          {!scored ? (
            <div className="mt-0.5 text-[var(--gray-a10)]">Checking…</div>
          ) : scored.verdict.parallax ? (
            <div className="mt-0.5 flex items-center gap-1 font-medium text-[var(--green-11)]">
              <CheckCircleIcon className="h-4 w-4" /> Used
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-1 font-medium text-[var(--amber-11)]">
              <ExclamationTriangleIcon className="h-4 w-4" /> Shown still
            </div>
          )}
        </div>
      </div>

      {scored && (
        <div className="space-y-2 rounded-lg border border-[var(--gray-a5)] p-3">
          {scored.verdict.reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {scored.verdict.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <div className="space-y-1">
            <Measure label="Background changed from the original" value={scored.plateChange} limit={PLATE_MIN_CHANGE} better="above" />
            <Measure label="Near things outside the people layer" value={scored.agreement?.nearOutside ?? null} limit={MAX_NEAR_OUTSIDE} better="below" />
            <Measure label="Far things inside the people layer" value={scored.agreement?.farInside ?? null} limit={MAX_FAR_INSIDE} better="below" />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {layers.map((l) => (
          <figure key={l.key} className="space-y-1">
            {l.url ? (
              <a href={l.url} target="_blank" rel="noopener noreferrer" title="Open full size">
                <div
                  className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border border-[var(--gray-a5)]"
                  // Transparency shows as a checkerboard, so a bad cutout edge is visible.
                  style={l.checker ? { background: 'repeating-conic-gradient(#d4d4d8 0% 25%, #f4f4f5 0% 50%) 50% / 16px 16px' } : { background: 'var(--gray-a3)' }}
                >
                  <img src={l.url} alt={l.label} loading="lazy" className="max-h-full max-w-full object-contain" />
                </div>
              </a>
            ) : (
              <div className="flex aspect-[4/3] items-center justify-center rounded-md border border-dashed border-[var(--gray-a6)] text-xs text-[var(--gray-a9)]">
                Not generated
              </div>
            )}
            <figcaption>
              <div className="font-medium">{l.label}</div>
              <div className="text-xs text-[var(--gray-a10)]">{l.note}</div>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="rounded-lg border border-[var(--gray-a5)] p-3">
        <div className="mb-1 text-xs text-[var(--gray-a10)]">Wedflix card</div>
        {card?.title ? (
          <div className="space-y-1">
            {card.eyebrow && <div className="text-xs uppercase tracking-widest text-[var(--gray-a10)]">{card.eyebrow}</div>}
            <div className="text-lg font-semibold">{card.title}</div>
            {Array.isArray(card.words) && card.words.length > 0 && <div>{card.words.join(' · ')}</div>}
            <div className="text-xs text-[var(--gray-a10)]">
              {[card.genre && `${card.genre} styling`, card.kind].filter(Boolean).join(' · ')}
            </div>
            {album === 'seed' && (
              <div className="text-xs text-[var(--gray-a10)]">
                Preload photos are never billed as programmes, so this card is not shown.
              </div>
            )}
          </div>
        ) : (
          <div className="text-[var(--gray-a10)]">
            No card yet. Photos without one are left out of Wedflix.
          </div>
        )}
      </div>
    </section>
  );
}
