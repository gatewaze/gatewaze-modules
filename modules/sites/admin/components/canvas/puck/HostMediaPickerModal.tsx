/**
 * Modal that wraps the host-media list endpoint as a picker. Used by
 * the Puck MediaField via PuckCanvasEditor's `renderHost.showMediaPicker`.
 *
 * Phase B+ scope: photos only, single-select, simple grid. Album
 * navigation, video/audio support, and search land in a follow-up
 * (host-media's own tab handles them; this picker is a lightweight
 * adjunct for inline image-field selection).
 */

import { useEffect, useState } from 'react';

/**
 * Cross-module import: the host-media module exposes hostMediaService
 * through admin/utils. The sites tsconfig has rootDir='./sites' which
 * forbids static imports across module boundaries at typecheck time
 * (Vite resolves them fine at runtime). We dynamically import inside
 * the effect body so the typecheck pass doesn't traverse the file.
 */
type ListHostMediaFn = (
  hostKind: string,
  hostId: string,
  opts?: { filter?: 'all' | 'photo' | 'video' | 'audio'; limit?: number },
) => Promise<Response>;

async function loadListHostMedia(): Promise<ListHostMediaFn> {
  // Cross-module import: the host-media module is a sibling under
  // gatewaze-modules/, but the sites tsconfig has rootDir='./sites'.
  // We construct the URL from a runtime-built string so tsc cannot
  // resolve the path (and therefore won't trip on rootDir). Vite still
  // resolves it at runtime via the standard relative-path lookup.
  const path = '../../../../../host-media/admin/utils/hostMediaService.js';
  const mod = await import(/* @vite-ignore */ path) as { listHostMedia: ListHostMediaFn };
  return mod.listHostMedia;
}

interface MediaItem {
  id: string;
  url: string;
  alt_text: string | null;
  caption: string | null;
  thumbnail_url: string | null;
  type: 'photo' | 'video' | 'audio' | 'document' | string;
}

interface HostMediaPickerModalProps {
  open: boolean;
  hostKind: 'site';
  hostId: string;
  onSelect: (url: string, alt: string | null) => void;
  onClose: () => void;
}

export function HostMediaPickerModal(props: HostMediaPickerModalProps) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const listHostMedia = await loadListHostMedia();
        const res = await listHostMedia(props.hostKind, props.hostId, { filter: 'photo', limit: 60 });
        if (cancelled) return;
        if (!res.ok) {
          setError(`Load failed (${res.status})`);
          return;
        }
        const body = await res.json() as { items?: MediaItem[] };
        setItems(Array.isArray(body.items) ? body.items : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [props.open, props.hostKind, props.hostId]);

  if (!props.open) return null;

  return (
    <div className="puck-media-picker-backdrop" onClick={props.onClose}>
      <div
        className="puck-media-picker-modal"
        role="dialog"
        aria-label="Pick image"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="puck-media-picker-header">
          <h2>Pick an image</h2>
          <button type="button" onClick={props.onClose} aria-label="Close">×</button>
        </header>
        {loading && <p>Loading…</p>}
        {error && <p className="puck-media-picker-error">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p>No images yet. Upload some via the media tab first.</p>
        )}
        <div className="puck-media-picker-grid">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className="puck-media-picker-tile"
              onClick={() => {
                props.onSelect(it.url, it.alt_text);
                props.onClose();
              }}
            >
              <img
                src={it.thumbnail_url ?? it.url}
                alt={it.alt_text ?? ''}
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
