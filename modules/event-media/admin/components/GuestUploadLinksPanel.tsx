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
import { BOOTH_ERAS } from '../../lib/booth-eras';
import { KeyPeoplePanel } from './KeyPeoplePanel';

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

interface FaceFilter {
  id: string;
  label: string;
  source_path: string;
  is_active: boolean;
  sort_order: number;
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
  // straight into the photo booth. Full page URLs rather than /u/<code>,
  // whose redirect drops anything after the code.
  const sectionUrl = useCallback(
    (link: UploadLink, tab: 'photos' | 'booth') => {
      const base = customDomainUrl
        ? `${baseUrl}/photos`
        : eventIdentifier
          ? `${baseUrl}/events/${eventIdentifier}/photos`
          : null;
      if (!base) return null;
      return `${base}?u=${link.short_code}${tab === 'booth' ? '&tab=booth' : ''}`;
    },
    [baseUrl, customDomainUrl, eventIdentifier],
  );

  // ── Face filters ──────────────────────────────────────────────────

  const [filters, setFilters] = useState<FaceFilter[]>([]);
  const [provider, setProvider] = useState<{
    configured: boolean;
    reason?: string;
    styles?: boolean;
    swaps?: boolean;
  } | null>(null);
  const [filterLabel, setFilterLabel] = useState('');
  const [uploadingFace, setUploadingFace] = useState(false);
  const faceInputRef = useRef<HTMLInputElement | null>(null);

  const loadFilters = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/admin/events/${eventId}/face-filters`);
      if (!res.ok) return;
      const data = await res.json();
      setFilters(data.items ?? []);
      setProvider(data.provider ?? null);
    } catch {
      // panel still usable without it
    }
  }, [eventId]);

  const addFace = useCallback(async (file: File) => {
    const label = filterLabel.trim();
    if (!label) { toast.error('Give the face a name first'); return; }
    setUploadingFace(true);
    try {
      // Reference faces live outside the media rows: they are inputs
      // to the swap, not gallery content.
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `event/${eventId}/__faces/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('media').upload(path, file, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
      });
      if (upErr) { toast.error(`Upload failed: ${upErr.message}`); return; }

      const res = await authedFetch(`/api/admin/events/${eventId}/face-filters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, source_path: path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.message ?? 'Could not save that face');
        return;
      }
      toast.success(`Added ${label}`);
      setFilterLabel('');
      await loadFilters();
    } finally {
      setUploadingFace(false);
    }
  }, [eventId, filterLabel, loadFilters]);

  const toggleFilter = useCallback(async (f: FaceFilter) => {
    const res = await authedFetch(`/api/admin/events/${eventId}/face-filters/${f.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !f.is_active }),
    });
    if (res.ok) await loadFilters(); else toast.error('Could not update that face');
  }, [eventId, loadFilters]);

  const removeFilter = useCallback(async (f: FaceFilter) => {
    const res = await authedFetch(`/api/admin/events/${eventId}/face-filters/${f.id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Removed'); await loadFilters(); } else toast.error('Could not remove that face');
  }, [eventId, loadFilters]);

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

  // Which booth eras guests are offered: all of them (an era picker), or
  // one, for a themed party -- the booth then opens straight into it.
  const [boothEra, setBoothEra] = useState<string>('all');
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void supabase
      .from('events_media_booth_settings')
      .select('era')
      .eq('event_id', eventId)
      .maybeSingle()
      .then(({ data }: { data: { era?: string } | null }) => {
        if (!cancelled && data?.era) setBoothEra(data.era);
      });
    return () => { cancelled = true; };
  }, [expanded, eventId]);

  const saveBoothEra = async (era: string) => {
    const prev = boothEra;
    setBoothEra(era);
    const { error } = await supabase
      .from('events_media_booth_settings')
      .upsert({ event_id: eventId, era, updated_at: new Date().toISOString() }, { onConflict: 'event_id' });
    if (error) {
      setBoothEra(prev);
      toast.error('Could not save the booth era');
      return;
    }
    toast.success(era === 'all' ? 'Guests choose from every era' : `The booth is ${era} only`);
  };

  // Guests who have uploaded, from the invitation list, and who is
  // blocked. Blocking stops a guest uploading or using the booth and takes
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
    void loadFilters();
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
                  ['allow_face_filter', 'Face filter'],
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

          <KeyPeoplePanel eventId={eventId} />

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

          {/* Photo booth. Style effects need only the provider; face
              swaps also need the reference faces uploaded below. Both
              are offered to guests only when the link opts in. */}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
            <p className="text-sm font-medium mb-1">Photo booth</p>
            <label className="flex flex-wrap items-center gap-2 text-sm mb-2">
              Decades
              <select
                value={boothEra}
                onChange={(e) => void saveBoothEra(e.target.value)}
                className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-sm"
              >
                <option value="all">All decades — guests pick one</option>
                {BOOTH_ERAS.map((era) => (
                  <option key={era.key} value={era.key}>{era.label} only — a themed event</option>
                ))}
              </select>
            </label>
            {provider && !provider.configured ? (
              <p className="text-xs text-gray-500 mb-2">
                Not available — {provider.reason}. Set BOOTH_PROVIDER=fal and FAL_API_KEY to
                enable, then tick &quot;Face filter&quot; on a link.
              </p>
            ) : (
              <p className="text-xs text-gray-500 mb-2">
                {provider?.styles
                  ? 'Guests taking a photo can pick a style effect. '
                  : 'Style effects are off. '}
                {provider?.swaps
                  ? 'Add a reference face below to also let them wear it — upload a clear, front-facing photo of each person.'
                  : 'Face swaps are off.'}
              </p>
            )}

            {filters.length > 0 && (
              <div className="flex flex-wrap gap-3 mb-2">
                {filters.map((f) => (
                  <div key={f.id} className="flex flex-col items-center gap-1 w-20">
                    <img
                      src={`${supabasePublicUrl}/storage/v1/object/public/media/${f.source_path}`}
                      alt=""
                      className={`w-16 h-16 rounded-full object-cover ring-2 ${f.is_active ? 'ring-green-500' : 'ring-gray-300 opacity-50'}`}
                    />
                    <span className="text-xs truncate w-full text-center">{f.label}</span>
                    <div className="flex gap-1.5 text-[11px]">
                      <button className="underline" onClick={() => toggleFilter(f)}>
                        {f.is_active ? 'Off' : 'On'}
                      </button>
                      <button className="underline text-red-600" onClick={() => removeFilter(f)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={filterLabel}
                onChange={(e) => setFilterLabel(e.target.value)}
                placeholder="Name, e.g. Dan"
                maxLength={40}
                className="rounded border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1 text-sm w-36"
              />
              <button
                className="text-sm underline disabled:opacity-50"
                disabled={uploadingFace || !filterLabel.trim()}
                onClick={() => faceInputRef.current?.click()}
              >
                {uploadingFace ? 'Uploading…' : '+ Add reference photo'}
              </button>
              <input
                ref={faceInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void addFace(f);
                  e.target.value = '';
                }}
              />
            </div>
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
