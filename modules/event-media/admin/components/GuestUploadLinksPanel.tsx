/**
 * Guest upload links panel — rendered by EventMediaTab above the
 * media organizer. Create/manage the hidden QR upload links,
 * export QR PNGs (custom-domain aware, QrCodeExport precedent), and
 * review pending (unapproved) guest uploads for auto_approve=false
 * links.
 *
 * Per spec-event-media-guest-uploads §8.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
  role?: string;
  /** The album a photographer's link delivers into (migration 032). */
  album?: { name: string | null } | null;
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
const supabasePublicUrl = (
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_SUPABASE_URL ?? ''
).replace(/\/+$/, '');
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
  // 'guest' is the QR everyone scans; 'photographer' is one professional
  // delivering into their own album (migration 021).
  role: 'guest',
  credit_name: '',
  // A photographer's link can deliver into an album of its own, e.g. a
  // second, fuller delivery. Empty means the Photographer album.
  album_name: '',
  require_name: true,
  allow_video: true,
  auto_approve: true,
  show_gallery: true,
  // Off by default: a guest's face being altered is never the
  // out-of-the-box behaviour.
  allow_face_filter: false,
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
  // instead of the shared portal host. MUST be an authed fetch —
  // /api/modules/* is JWT+super-admin gated upstream, so the plain
  // fetch the QrCodeExport precedent uses silently 401s and every
  // copied URL falls back to the portal host (found live 2026-09-19).
  useEffect(() => {
    authedFetch(`/api/modules/custom-domains/lookup/events/${eventId}`)
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

  // Deep links for their own QR codes: the wedding-photos screen, or
  // the photo booth, which is the photo-booth module's own page. Full
  // page URLs rather than /u/<code>, whose redirect drops anything after
  // the code.
  const sectionUrl = useCallback(
    (link: UploadLink, tab: 'photos' | 'booth') => {
      const base = customDomainUrl
        ? baseUrl
        : eventIdentifier
          ? `${baseUrl}/events/${eventIdentifier}`
          : null;
      if (!base) return null;
      return `${base}/${tab}?u=${link.short_code}`;
    },
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

  // How long before the event the getting-ready prompts appear.
  const [readyHours, setReadyHours] = useState(36);
  // When the evening reception starts, in minutes past midnight. Photos
  // taken from then go to their own album (migration 022).
  const [eveningFrom, setEveningFrom] = useState(18 * 60 + 30);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void supabase
      .from('events_media_booth_settings')
      .select('ready_hours, evening_from_minutes')
      .eq('event_id', eventId)
      .maybeSingle()
      .then(({ data }: { data: { ready_hours?: number; evening_from_minutes?: number | null } | null }) => {
        if (cancelled || !data) return;
        if (typeof data.ready_hours === 'number') setReadyHours(data.ready_hours);
        setEveningFrom(typeof data.evening_from_minutes === 'number' ? data.evening_from_minutes : 18 * 60 + 30);
      });
    return () => { cancelled = true; };
  }, [expanded, eventId]);

  /** Save one setting, putting it back if the write is refused. */
  const saveBooth = async (
    patch: Record<string, unknown>,
    undo: () => void,
    said: string,
  ) => {
    const { error } = await supabase
      .from('events_media_booth_settings')
      .upsert({ event_id: eventId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'event_id' });
    if (error) {
      undo();
      toast.error('Could not save that booth setting');
      return;
    }
    toast.success(said);
  };

  // Guests who have uploaded, from the invitation list, and who is
  // blocked. Blocking stops a guest uploading (and the photo booth, which
  // reads the same list) and takes
  // every photo of theirs off the projector and the gallery.
  const [uploaders, setUploaders] = useState<Array<{ memberId: string; name: string; photos: number }>>([]);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  // Names claimed by a phone (one phone per name).
  const [claims, setClaims] = useState<Array<{ member_id: string; guest_name: string | null; claimed_at: string }>>([]);
  const loadGuests = useCallback(async () => {
    const [{ data: rows }, { data: blocks }, { data: held }] = await Promise.all([
      supabase.from('host_media').select('metadata').eq('host_kind', 'event').eq('host_id', eventId).limit(5000),
      supabase.from('events_media_guest_blocks').select('member_id').eq('event_id', eventId),
      supabase.from('events_media_guest_claims').select('member_id, guest_name, claimed_at').eq('event_id', eventId).order('claimed_at', { ascending: false }),
    ]);
    setClaims((held ?? []) as Array<{ member_id: string; guest_name: string | null; claimed_at: string }>);
    const byMember = new Map<string, { memberId: string; name: string; photos: number }>();
    for (const r of (rows ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
      const m = r.metadata ?? {};
      const id = typeof m['member_id'] === 'string' ? (m['member_id'] as string) : null;
      if (!id) continue;
      const entry = byMember.get(id) ?? { memberId: id, name: String(m['guest_name'] ?? 'Guest'), photos: 0 };
      entry.photos += 1;
      byMember.set(id, entry);
    }
    setUploaders([...byMember.values()].sort((a, b) => b.photos - a.photos || a.name.localeCompare(b.name)));
    setBlocked(new Set(((blocks ?? []) as Array<{ member_id: string }>).map((b) => b.member_id)));
  }, [eventId]);

  useEffect(() => {
    if (expanded) void loadGuests();
  }, [expanded, loadGuests]);

  /** Free a name so its real owner can choose it on their own phone. */
  const releaseName = async (c: { member_id: string; guest_name: string | null }) => {
    const name = c.guest_name ?? 'this guest';
    if (!window.confirm(`Release ${name}? Whoever chose it will be asked who they are next time, and the real ${name} can then choose it.`)) return;
    const { error } = await supabase.from('events_media_guest_claims').delete().eq('event_id', eventId).eq('member_id', c.member_id);
    if (error) { toast.error('Could not release that name'); return; }
    toast.success(`${name} is free to choose again`);
    await loadGuests();
  };

  const toggleBlock = async (g: { memberId: string; name: string }) => {
    const isBlocked = blocked.has(g.memberId);
    const { error } = isBlocked
      ? await supabase.from('events_media_guest_blocks').delete().eq('event_id', eventId).eq('member_id', g.memberId)
      : await supabase.from('events_media_guest_blocks').insert({ event_id: eventId, member_id: g.memberId, guest_name: g.name });
    if (error) { toast.error('Could not update that guest'); return; }
    toast.success(isBlocked ? `${g.name} can upload again` : `${g.name} is blocked; their photos are off the screen`);
    await loadGuests();
  };

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
        body: JSON.stringify(
          form.role === 'photographer'
            ? form
            : (({ album_name: _album, ...rest }) => rest)(form),
        ),
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

  const downloadQr = async (link: UploadLink, size: number, target?: { url: string | null; name: string }) => {
    const data = target ? target.url : linkUrl(link);
    if (!data) { toast.error('Event identifier still loading'); return; }
    try {
      const dataUrl = await QRCodeService.generateQRCode({
        data,
        size,
        color: '#000000',
        backgroundColor: '#ffffff',
      });
      const a = document.createElement('a');
      a.download = `${link.label.replace(/[^a-zA-Z0-9]/g, '_')}${target ? `_${target.name}` : ''}_qr_${size}.png`;
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
              {link.role === 'photographer' && (
                <span className="text-xs text-gray-500">into {link.album?.name ?? 'Photographer'}</span>
              )}
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
              {/* Deep links, each with its own QR: straight to the
                  wedding-photos screen, or straight into the booth. */}
              <div className="basis-full flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-gray-600 dark:text-gray-300">
                {([['photos', 'Wedding photos'], ['booth', 'Photo booth']] as const).map(([tab, label]) => (
                  <span key={tab} className="flex items-center gap-2">
                    <span className="font-medium">{label}:</span>
                    <button
                      className="underline"
                      onClick={async () => {
                        const url = sectionUrl(link, tab);
                        if (!url) { toast.error('Event identifier still loading'); return; }
                        try { await navigator.clipboard.writeText(url); toast.success(`${label} link copied`); }
                        catch { toast.error('Could not copy URL'); }
                      }}
                    >
                      Copy link
                    </button>
                    <button className="underline" onClick={() => downloadQr(link, 1200, { url: sectionUrl(link, tab), name: tab })}>
                      QR
                    </button>
                  </span>
                ))}
              </div>

            </div>
          ))}

          {links.length === 0 && loaded && (
            <p className="text-sm text-gray-500">No upload links yet — create one and put its QR code on the tables.</p>
          )}

          {showCreate ? (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 space-y-2">
              {/* Two kinds of link: the QR everyone scans, and the one
                  the photographer delivers through (migration 021). */}
              <select
                value={form.role}
                onChange={(e) => setForm({
                  ...form,
                  role: e.target.value,
                  // A photographer is not asked who they are -- the link
                  // says -- and their delivery is not a gallery.
                  ...(e.target.value === 'photographer'
                    ? { require_name: false, show_gallery: false, allow_face_filter: false }
                    : {}),
                })}
                className="w-full rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5 text-sm"
              >
                <option value="guest">For guests — the QR on the tables</option>
                <option value="photographer">For the photographer — their own album, originals kept</option>
              </select>
              {form.role === 'photographer' && (
                <>
                  <input
                    type="text"
                    value={form.credit_name}
                    onChange={(e) => setForm({ ...form, credit_name: e.target.value })}
                    placeholder="Credit these photos to, e.g. Hartley &amp; Rose Photography"
                    maxLength={120}
                    className="w-full rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5 text-sm"
                  />
                  <p className="text-xs text-gray-500">
                    A person or a company. Everything sent through this link is filed under this name,
                    in a Photographer album that stays off the portal until you turn it on.
                  </p>
                  <input
                    type="text"
                    value={form.album_name}
                    onChange={(e) => setForm({ ...form, album_name: e.target.value })}
                    placeholder="Album, e.g. Photographer Stream (leave empty for Photographer)"
                    maxLength={80}
                    className="w-full rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1.5 text-sm"
                  />
                  <p className="text-xs text-gray-500">
                    Name an album to keep this delivery apart from the others. It is made if it does not
                    exist yet, and stays off the portal until you turn it on.
                  </p>
                </>
              )}
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
                  ['allow_face_filter', 'Photo booth'],
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

          {/* Guests who have uploaded, and blocking. */}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
            <p className="text-sm font-medium mb-1">Guests</p>
            {uploaders.length === 0 ? (
              <p className="text-xs text-gray-500 mb-2">
                No uploads from guests on the invitation list yet. Guests choose their name from the
                people who accepted, and every photo is recorded against them.
              </p>
            ) : (
              <div className="space-y-1 mb-2">
                {uploaders.map((g) => {
                  const isBlocked = blocked.has(g.memberId);
                  return (
                    <div key={g.memberId} className="flex items-center gap-2 text-sm">
                      <span className={isBlocked ? 'line-through text-gray-400' : ''}>{g.name}</span>
                      <span className="text-xs text-gray-500">{g.photos} photo{g.photos === 1 ? '' : 's'}</span>
                      {isBlocked && (
                        <span className="text-xs rounded-full bg-red-100 text-red-700 px-2 py-0.5">blocked</span>
                      )}
                      <span className="flex-1" />
                      <button
                        className={`text-xs underline ${isBlocked ? '' : 'text-red-600'}`}
                        onClick={() => void toggleBlock(g)}
                      >
                        {isBlocked ? 'Unblock' : 'Block'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {claims.length > 0 && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
              <p className="text-sm font-medium mb-1">Names chosen ({claims.length})</p>
              <p className="text-xs text-gray-500 mb-2">
                Each name can be chosen on one phone only. If someone picked the wrong person, release the name.
              </p>
              <div className="space-y-1 mb-2 max-h-48 overflow-y-auto">
                {claims.map((c) => (
                  <div key={c.member_id} className="flex items-center gap-2 text-sm">
                    <span>{c.guest_name ?? 'Guest'}</span>
                    <span className="text-xs text-gray-500">{new Date(c.claimed_at).toLocaleString()}</span>
                    <span className="flex-1" />
                    <button className="text-xs underline" onClick={() => void releaseName(c)}>Release</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* When the day's albums start and end. The photo booth's own
              settings live on its tab (the photo-booth module). */}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
            <p className="text-sm font-medium mb-1">Albums</p>
            {/* The morning before: prompts and a countdown, before the
                event starts. */}
            <label className="flex items-center gap-2 text-sm">
              Getting ready opens
              <select
                value={String(readyHours)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  const prev = readyHours;
                  setReadyHours(next);
                  void saveBooth({ ready_hours: next }, () => setReadyHours(prev),
                    next === 0 ? 'The getting-ready prompts are off' : `Getting ready opens ${next} hours before`);
                }}
                className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-sm"
              >
                <option value="0">Off</option>
                {[12, 24, 36, 48, 72, 120].map((h) => (
                  <option key={h} value={h}>{h} hours before the event</option>
                ))}
              </select>
            </label>
            {/* Which photographs are the evening's. Not every reception
                starts at half past six. */}
            <label className="flex items-center gap-2 text-sm">
              The evening reception starts at
              <input
                type="time"
                value={`${String(Math.floor(eveningFrom / 60)).padStart(2, '0')}:${String(eveningFrom % 60).padStart(2, '0')}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  if (!Number.isFinite(h) || !Number.isFinite(m)) return;
                  const next = h * 60 + m;
                  const prev = eveningFrom;
                  setEveningFrom(next);
                  void saveBooth({ evening_from_minutes: next }, () => setEveningFrom(prev),
                    `Photos from ${e.target.value} are the evening reception's`);
                }}
                className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-sm"
              />
            </label>
            <p className="text-xs text-gray-500">
              Photos already filed stay where they are — this decides where new ones go.
            </p>
          </div>
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
