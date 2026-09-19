/**
 * Guest upload links panel — rendered by EventMediaTab above the
 * shared <HostMediaTab>. Create/manage the hidden QR upload links,
 * export QR PNGs (custom-domain aware, QrCodeExport precedent), and
 * review pending (unapproved) guest uploads for auto_approve=false
 * links.
 *
 * Per spec-event-media-guest-uploads §8.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { QRCodeService } from '@/utils/qrCodeService';
import { toast } from 'sonner';

interface GuestUploadLinksPanelProps {
  eventId: string; // events.id uuid
}

interface UploadLink {
  id: string;
  short_code: string;
  label: string;
  is_active: boolean;
  expires_at: string | null;
  require_name: boolean;
  allow_video: boolean;
  auto_approve: boolean;
  show_gallery: boolean;
  uploads_count: number;
  logo_url: string | null;
  created_at: string;
}

interface PendingMedia {
  id: string;
  storage_path: string;
  mime_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const apiUrl = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
const portalUrl =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_PORTAL_URL ??
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_APP_URL ??
  '';

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${apiUrl}${path}`, { ...init, headers });
}

const DEFAULT_FORM = {
  label: '',
  require_name: true,
  allow_video: true,
  auto_approve: true,
  show_gallery: true,
};

export function GuestUploadLinksPanel({ eventId }: GuestUploadLinksPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [links, setLinks] = useState<UploadLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [customDomainUrl, setCustomDomainUrl] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingMedia[]>([]);

  // Custom-domain lookup so copied URLs + QR codes use dan-sarah.com
  // instead of the shared portal host (QrCodeExport precedent).
  useEffect(() => {
    fetch(`${apiUrl}/api/modules/custom-domains/lookup/events/${eventId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.url) setCustomDomainUrl(data.url); })
      .catch(() => { /* custom domains module may not be enabled */ });
  }, [eventId]);

  // Event identifier for the display URL (custom domains imply the
  // event; the shared portal host needs /events/<identifier>).
  const [eventIdentifier, setEventIdentifier] = useState<string | null>(null);
  useEffect(() => {
    supabase
      .from('events')
      .select('event_slug, event_id')
      .eq('id', eventId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setEventIdentifier(data.event_slug || data.event_id || null);
      });
  }, [eventId]);

  const baseUrl = (customDomainUrl || portalUrl).replace(/\/+$/, '');
  const linkUrl = useCallback((link: UploadLink) => `${baseUrl}/u/${link.short_code}`, [baseUrl]);
  // Projector display = the photos tab in ?display=1 mode (module portal
  // pages are nav-gated, so there is no standalone display route).
  const displayUrl = useCallback(
    (link: UploadLink) =>
      customDomainUrl
        ? `${baseUrl}/photos?u=${link.short_code}&display=1`
        : eventIdentifier
          ? `${baseUrl}/events/${eventIdentifier}/photos?u=${link.short_code}&display=1`
          : null,
    [baseUrl, customDomainUrl, eventIdentifier],
  );

  const loadLinks = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/admin/events/${eventId}/media-upload-links`);
      if (!res.ok) return;
      const data = await res.json();
      setLinks(data.items ?? []);
    } catch {
      // panel stays collapsed-empty; retry on next expand
    } finally {
      setLoaded(true);
    }
  }, [eventId]);

  const loadPending = useCallback(async () => {
    // Unapproved guest rows (auto_approve=false moderation queue) —
    // admin read via the user's own session, RLS admin policy applies.
    const { data } = await supabase
      .from('host_media')
      .select('id, storage_path, mime_type, metadata, created_at')
      .eq('host_kind', 'event')
      .eq('host_id', eventId)
      .eq('is_approved', false)
      .order('created_at', { ascending: false })
      .limit(100);
    setPending((data ?? []) as PendingMedia[]);
  }, [eventId]);

  // Pending moderation loads on MOUNT (not first expand) so the
  // collapsed-header badge is actually visible when a queue exists.
  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  useEffect(() => {
    if (!expanded || loaded) return;
    void loadLinks();
  }, [expanded, loaded, loadLinks]);

  const createLink = async () => {
    if (!form.label.trim()) return;
    setSaving(true);
    try {
      const res = await authedFetch(`/api/admin/events/${eventId}/media-upload-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.message ?? 'Failed to create link');
        return;
      }
      toast.success('Upload link created');
      setShowCreate(false);
      setForm(DEFAULT_FORM);
      await loadLinks();
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (link: UploadLink) => {
    const res = await authedFetch(`/api/admin/events/${eventId}/media-upload-links/${link.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !link.is_active }),
    });
    if (res.ok) {
      toast.success(link.is_active ? 'Link deactivated' : 'Link activated');
      await loadLinks();
    } else {
      toast.error('Failed to update link');
    }
  };

  const copyUrl = async (link: UploadLink) => {
    try {
      await navigator.clipboard.writeText(linkUrl(link));
      toast.success('URL copied');
    } catch {
      toast.error('Could not copy URL');
    }
  };

  const downloadQr = async (link: UploadLink, size: number) => {
    try {
      const dataUrl = await QRCodeService.generateQRCode({
        data: linkUrl(link),
        size,
        color: '#000000',
        backgroundColor: '#ffffff',
      });
      const a = document.createElement('a');
      a.download = `${link.label.replace(/[^a-zA-Z0-9]/g, '_')}_qr_${size}.png`;
      a.href = dataUrl;
      a.click();
      toast.success('QR code downloaded');
    } catch {
      toast.error('Failed to generate QR code');
    }
  };

  const moderate = async (media: PendingMedia, approve: boolean) => {
    if (approve) {
      const { error } = await supabase
        .from('host_media')
        .update({ is_approved: true })
        .eq('id', media.id);
      if (error) { toast.error('Approve failed'); return; }
      toast.success('Approved');
    } else {
      const { error } = await supabase.from('host_media').delete().eq('id', media.id);
      if (error) { toast.error('Reject failed'); return; }
      // Best-effort storage cleanup (original + variants); anything a
      // policy blocks is picked up by the orphan sweep script.
      const dir = media.storage_path.replace(/\/[^/]+$/, '');
      try {
        await supabase.storage.from('media').remove([
          media.storage_path,
          `${dir}/variants/thumb.jpg`,
          `${dir}/variants/medium.jpg`,
        ]);
      } catch { /* sweep script catches leftovers */ }
      toast.success('Rejected');
    }
    await loadPending();
  };

  return (
    <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-medium">
          Guest upload links{loaded ? ` (${links.length})` : ''}
          {pending.length > 0 && (
            <span className="ml-2 text-xs rounded-full bg-amber-100 text-amber-800 px-2 py-0.5">
              {pending.length} pending approval
            </span>
          )}
        </span>
        <span className="text-gray-400">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {links.map((link) => (
            <div key={link.id} className="flex flex-wrap items-center gap-2 rounded-md border border-gray-100 dark:border-gray-800 px-3 py-2 text-sm">
              <span className="font-medium">{link.label}</span>
              <code className="text-xs bg-gray-100 dark:bg-gray-800 rounded px-1.5 py-0.5">{link.short_code}</code>
              <span className={`text-xs rounded-full px-2 py-0.5 ${link.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                {link.is_active ? 'active' : 'inactive'}
              </span>
              <span className="text-xs text-gray-500">{link.uploads_count} uploads</span>
              <span className="flex-1" />
              <button className="text-xs underline" onClick={() => copyUrl(link)}>Copy URL</button>
              <button
                className="text-xs underline"
                onClick={async () => {
                  const url = displayUrl(link);
                  if (!url) { toast.error('Event identifier still loading'); return; }
                  try { await navigator.clipboard.writeText(url); toast.success('Display URL copied'); }
                  catch { toast.error('Could not copy URL'); }
                }}
              >
                Copy display URL
              </button>
              <button className="text-xs underline" onClick={() => downloadQr(link, 1200)}>QR 1200px</button>
              <button className="text-xs underline" onClick={() => downloadQr(link, 600)}>QR 600px</button>
              <button className="text-xs underline text-red-600" onClick={() => toggleActive(link)}>
                {link.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          ))}

          {links.length === 0 && loaded && (
            <p className="text-sm text-gray-500">No upload links yet — create one and put its QR code on the tables.</p>
          )}

          {showCreate ? (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 space-y-2">
              <input
                type="text"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder='Label, e.g. "Wedding day QR"'
                maxLength={120}
                className="w-full rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5 text-sm"
              />
              <div className="flex flex-wrap gap-4 text-sm">
                {([
                  ['require_name', 'Ask for name'],
                  ['allow_video', 'Allow video'],
                  ['auto_approve', 'Auto-approve'],
                  ['show_gallery', 'Show gallery'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded bg-blue-600 text-white text-sm px-3 py-1.5 disabled:opacity-50"
                  disabled={saving || !form.label.trim()}
                  onClick={createLink}
                >
                  Create link
                </button>
                <button className="text-sm underline" onClick={() => setShowCreate(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="text-sm underline" onClick={() => setShowCreate(true)}>+ New upload link</button>
          )}

          {pending.length > 0 && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <p className="text-sm font-medium mb-2">Pending approval</p>
              <div className="space-y-1">
                {pending.map((m) => {
                  const meta = (m.metadata ?? {}) as Record<string, unknown>;
                  return (
                    <div key={m.id} className="flex items-center gap-2 text-xs">
                      <span className="truncate flex-1">
                        {typeof meta.guest_name === 'string' ? meta.guest_name : 'Unknown guest'} — {m.storage_path.split('/').pop()}
                      </span>
                      <button className="underline text-green-700" onClick={() => moderate(m, true)}>Approve</button>
                      <button className="underline text-red-600" onClick={() => moderate(m, false)}>Reject</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default GuestUploadLinksPanel;
