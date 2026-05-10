/**
 * Image field adapter — Puck inline custom field that gives the
 * operator three ways to put an image into an email block:
 *
 *   1. Drop a file onto the dropzone → uploaded via host-media
 *      (`uploadHostMedia('newsletter', collectionId, files)`),
 *      stored in the platform's Supabase Storage bucket, and the
 *      returned CDN URL is written to the block's field value.
 *   2. Click "Choose file" → same flow as the dropzone.
 *   3. Paste a URL into the input → bypass upload entirely.
 *
 * Used by every block that has an image-bearing field (Hero,
 * LogoHeader, Img, TwoColumnFeatures, CTACard). Wired as the
 * `render` of a Puck `type: 'custom'` field — the same pattern as
 * HelixAiFieldAdapter.
 *
 * Mirrors the events module's `EventImageUpload` ergonomics
 * (validate-then-upload) but talks to host-media's polymorphic
 * endpoint so newsletters share the same media library /
 * permissions / storage backend as every other host-kind. The
 * collectionId comes through `useNewsletterEditing()` — Puck's
 * field-render API doesn't pass it directly.
 */

import { useCallback, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { ArrowUpTrayIcon, PhotoIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { uploadHostMedia } from '@gatewaze-modules/host-media/admin';
import { useNewsletterEditing } from '../NewsletterEditingContext.js';

interface PuckCustomFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
  name?: string;
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB; large enough for hero photos.

export function NewsletterImageFieldAdapter({ value, onChange }: PuckCustomFieldProps): ReactElement {
  const { collectionId } = useNewsletterEditing();
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const currentUrl = typeof value === 'string' ? value : '';

  const doUpload = useCallback(
    async (files: FileList | File[]) => {
      if (!collectionId) {
        toast.error('Save the edition before uploading an image.');
        return;
      }
      const arr = Array.from(files);
      if (arr.length === 0) return;
      const file = arr[0]!;
      if (!file.type.startsWith('image/')) {
        toast.error(`"${file.name}" isn't an image.`);
        return;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`"${file.name}" is over 10 MB.`);
        return;
      }
      setBusy(true);
      try {
        const res = await uploadHostMedia('newsletter', collectionId, [file]);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `upload failed (${res.status})`);
        }
        const body = (await res.json()) as { items?: Array<{ status: string; cdn_url?: string; error?: string }> };
        const item = body.items?.[0];
        if (!item || item.status !== 'created' || !item.cdn_url) {
          throw new Error(item?.error ?? 'upload returned no URL');
        }
        onChange(item.cdn_url);
        toast.success('Image uploaded.');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setBusy(false);
      }
    },
    [collectionId, onChange],
  );

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (busy) return;
    void doUpload(e.dataTransfer.files);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragActive) setDragActive(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, marginBottom: 4 }}>
      {currentUrl ? (
        <div
          style={{
            position: 'relative',
            border: '1px solid var(--gray-a5, #e5e7eb)',
            borderRadius: 6,
            overflow: 'hidden',
            background: 'var(--gray-2, #f7f7f7)',
            maxHeight: 180,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <img
            src={currentUrl}
            alt=""
            style={{ maxWidth: '100%', maxHeight: 180, display: 'block' }}
          />
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Remove image"
            title="Remove image"
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 24,
              height: 24,
              borderRadius: 12,
              border: 'none',
              background: 'rgba(0,0,0,0.6)',
              color: '#fff',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <XMarkIcon className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          style={{
            border: dragActive
              ? '1px dashed var(--accent-9, #14171E)'
              : '1px dashed var(--gray-a6, #ccc)',
            borderRadius: 6,
            padding: '20px 12px',
            background: dragActive ? 'var(--accent-a3, #eef2f7)' : 'var(--gray-1, #fafafa)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: 'var(--gray-9, #888)',
            fontSize: 12,
            textAlign: 'center',
            transition: 'background 0.1s ease',
          }}
        >
          <PhotoIcon className="w-6 h-6" />
          <div>{busy ? 'Uploading…' : 'Drop an image, paste a URL, or click below'}</div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            border: '1px solid var(--gray-a6, #ccc)',
            borderRadius: 6,
            background: 'var(--color-surface, #fff)',
            color: 'var(--gray-12, #14171E)',
            cursor: busy ? 'wait' : 'pointer',
            fontSize: 12,
            opacity: busy ? 0.7 : 1,
          }}
        >
          <ArrowUpTrayIcon className="w-3.5 h-3.5" />
          {currentUrl ? 'Replace' : 'Choose file'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) {
              void doUpload(e.target.files);
              e.target.value = '';
            }
          }}
        />
        <input
          type="text"
          value={currentUrl}
          placeholder="…or paste an image URL"
          onChange={(e) => onChange(e.target.value)}
          style={{
            flex: 1,
            padding: '6px 10px',
            border: '1px solid var(--gray-a6, #ccc)',
            borderRadius: 6,
            background: 'var(--color-surface, #fff)',
            color: 'var(--gray-12, #14171E)',
            fontSize: 12,
          }}
        />
      </div>
    </div>
  );
}
