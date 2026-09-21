/**
 * Event media organizer — the event's Media tab.
 *
 * Restores the legacy gatewaze-admin organizer on top of host_media:
 * stats, type/status/album/sponsor filters, search, sorting, a custom
 * order with drag-to-reorder (per album or event-wide), adjustable
 * thumbnail size, multi-select with bulk add-to-album / tag sponsors /
 * approve / delete, album management, a viewer with caption editing,
 * uploads (files or ZIP), and live updates as guests upload.
 *
 * Guest upload links (QR codes) stay in their own panel above.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  PhotoIcon,
  VideoCameraIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
  ArrowUpTrayIcon,
  XMarkIcon,
  TagIcon,
  ArrowsPointingOutIcon,
  MagnifyingGlassIcon,
  CheckCircleIcon,
  ClockIcon,
  FolderMinusIcon,
} from '@heroicons/react/24/outline';
import { Button, Card, ConfirmModal } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import {
  bulkPatchHostMedia,
  bulkDeleteHostMedia,
  deleteHostMedia,
  patchHostMedia,
  getHostMedia,
  setHostMediaOrder,
  setAlbumOrder,
  removeFromAlbum,
  errorMessage,
} from '@gatewaze-modules/host-media/admin';
import {
  HOST_KIND,
  type HostMediaItem,
  type HostMediaAlbum,
  type HostMediaAlbumItem,
  type EventSponsorOption,
  type MediaSponsorTag,
  loadOrganizerMedia,
  loadAlbums,
  loadAlbumItems,
  loadEventSponsors,
  loadSponsorTags,
  untagMediaSponsor,
  mediaKind,
  guestName,
  isGuestUpload,
  formatFileSize,
  mergeSubsetOrder,
} from './utils/mediaOrganizerService';
import { GuestUploadLinksPanel } from './components/GuestUploadLinksPanel';
import { MediaGrid, type TileChips } from './components/MediaGrid';
import { MediaUploadModal } from './components/MediaUploadModal';
import { AlbumManagementModal } from './components/AlbumManagementModal';
import { AddToAlbumModal } from './components/AddToAlbumModal';
import { TagSponsorsModal } from './components/TagSponsorsModal';
import { MediaViewerModal } from './components/MediaViewerModal';

interface EventMediaTabProps {
  eventId: string; // host_id — events.id (uuid)
}

type TypeFilter = 'all' | 'photos' | 'videos';
type StatusFilter = 'all' | 'pending' | 'approved' | 'guest';
type SortOption = 'newest' | 'oldest' | 'name_asc' | 'name_desc' | 'custom';

type DeleteTarget = { kind: 'single'; item: HostMediaItem } | { kind: 'bulk'; ids: string[] };

const COLUMNS_KEY = 'gatewaze.eventMedia.columns';

function readColumns(): number {
  try {
    const n = Number(localStorage.getItem(COLUMNS_KEY));
    return n >= 2 && n <= 10 ? n : 5;
  } catch {
    return 5;
  }
}

const EMPTY_CHIPS: TileChips = { albums: [], sponsors: [] };

export function EventMediaTab({ eventId }: EventMediaTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [media, setMedia] = useState<HostMediaItem[]>([]);
  const [albums, setAlbums] = useState<HostMediaAlbum[]>([]);
  const [albumItems, setAlbumItems] = useState<HostMediaAlbumItem[]>([]);
  const [sponsors, setSponsors] = useState<EventSponsorOption[]>([]);
  const [sponsorTags, setSponsorTags] = useState<MediaSponsorTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('newest');
  const [dragMode, setDragMode] = useState(false);
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const selectedSponsor = searchParams.get('sponsorId');
  const [columns, setColumns] = useState<number>(readColumns);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  const [newlyAddedIds, setNewlyAddedIds] = useState<Set<string>>(new Set());
  const [viewerId, setViewerId] = useState<string | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [showAlbums, setShowAlbums] = useState(false);
  const [showAddToAlbum, setShowAddToAlbum] = useState(false);
  const [showTagSponsors, setShowTagSponsors] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // While the admin's own upload runs, its rows arrive over realtime too;
  // add them quietly instead of toasting once per file.
  const quietInserts = useRef(false);
  useEffect(() => { quietInserts.current = showUpload; }, [showUpload]);

  // ── Loading ──────────────────────────────────────────────────────────
  const reloadAlbums = useCallback(async () => {
    const [a, items] = await Promise.all([loadAlbums(eventId), loadAlbumItems(eventId)]);
    setAlbums(a);
    setAlbumItems(items);
  }, [eventId]);

  const reloadTags = useCallback(async (sponsorList: EventSponsorOption[]) => {
    setSponsorTags(await loadSponsorTags(sponsorList.map((s) => s.id)));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [m, s] = await Promise.all([loadOrganizerMedia(eventId), loadEventSponsors(eventId), reloadAlbums()]);
      setMedia(m);
      setSponsors(s);
      await reloadTags(s);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load media');
    } finally {
      setLoading(false);
    }
  }, [eventId, reloadAlbums, reloadTags]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ── Live updates (guest uploads, other admins) ───────────────────────
  // Realtime rows lack the server-derived URLs, so INSERT/UPDATE re-read
  // the row through the API. RLS limits the stream to what this admin
  // may see.
  useEffect(() => {
    const flash = (id: string) => {
      setNewlyAddedIds((prev) => new Set(prev).add(id));
      setTimeout(() => setNewlyAddedIds((prev) => { const n = new Set(prev); n.delete(id); return n; }), 3000);
    };
    const refetch = async (id: string, isInsert: boolean) => {
      try {
        const resp = await getHostMedia(HOST_KIND, eventId, id);
        if (!resp.ok) return;
        const row = (await resp.json()) as HostMediaItem;
        setMedia((prev) => {
          const exists = prev.some((m) => m.id === row.id);
          if (exists) return prev.map((m) => (m.id === row.id ? row : m));
          return isInsert ? [row, ...prev] : prev;
        });
        if (isInsert && !quietInserts.current) {
          flash(row.id);
          const who = guestName(row);
          toast.success(`New ${mediaKind(row)}${who ? ` from ${who}` : ''}`, { duration: 2000, position: 'bottom-right' });
        }
      } catch {
        // Next full reload picks it up.
      }
    };

    const channel = supabase
      .channel(`event-media-organizer-${eventId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'host_media', filter: `host_id=eq.${eventId}` },
        (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => {
          if (payload.eventType === 'DELETE') {
            const id = payload.old?.['id'] as string | undefined;
            if (!id) return;
            setMedia((prev) => prev.filter((m) => m.id !== id));
            setSelectedIds((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
            return;
          }
          if (payload.new?.['host_kind'] !== HOST_KIND) return;
          void refetch(payload.new['id'] as string, payload.eventType === 'INSERT');
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [eventId]);

  // ── Derived data ─────────────────────────────────────────────────────
  const albumById = useMemo(() => new Map(albums.map((a) => [a.id, a])), [albums]);
  const sponsorById = useMemo(() => new Map(sponsors.map((s) => [s.id, s])), [sponsors]);

  const albumCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of albumItems) counts.set(i.album_id, (counts.get(i.album_id) ?? 0) + 1);
    return counts;
  }, [albumItems]);

  const chipsByMedia = useMemo(() => {
    const map = new Map<string, TileChips>();
    const get = (id: string) => {
      let c = map.get(id);
      if (!c) { c = { albums: [], sponsors: [] }; map.set(id, c); }
      return c;
    };
    for (const i of albumItems) { const a = albumById.get(i.album_id); if (a) get(i.media_id).albums.push(a); }
    for (const t of sponsorTags) { const s = sponsorById.get(t.event_sponsor_id); if (s) get(t.media_id).sponsors.push(s); }
    return map;
  }, [albumItems, sponsorTags, albumById, sponsorById]);
  const chipsFor = useCallback((id: string) => chipsByMedia.get(id) ?? EMPTY_CHIPS, [chipsByMedia]);

  const sponsorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of sponsorTags) counts.set(t.event_sponsor_id, (counts.get(t.event_sponsor_id) ?? 0) + 1);
    return counts;
  }, [sponsorTags]);

  const albumOrder = useMemo(() => {
    if (!selectedAlbum) return null;
    return new Map(albumItems.filter((i) => i.album_id === selectedAlbum).map((i) => [i.media_id, i.sort_order]));
  }, [albumItems, selectedAlbum]);

  const sponsorMedia = useMemo(() => {
    if (!selectedSponsor) return null;
    return new Set(sponsorTags.filter((t) => t.event_sponsor_id === selectedSponsor).map((t) => t.media_id));
  }, [sponsorTags, selectedSponsor]);

  /** Every item of the current album/event in custom order (the reorder baseline). */
  const customSorted = useMemo(() => {
    const base = albumOrder ? media.filter((m) => albumOrder.has(m.id)) : media;
    const pos = (m: HostMediaItem) => (albumOrder ? albumOrder.get(m.id) ?? null : m.display_order);
    return [...base].sort((a, b) => {
      const pa = pos(a);
      const pb = pos(b);
      if (pa !== null && pb !== null && pa !== pb) return pa - pb;
      if (pa !== null && pb === null) return -1;
      if (pa === null && pb !== null) return 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [media, albumOrder]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = customSorted.filter((m) => {
      const kind = mediaKind(m);
      if (typeFilter === 'photos' && kind !== 'photo') return false;
      if (typeFilter === 'videos' && kind !== 'video') return false;
      if (statusFilter === 'pending' && m.is_approved) return false;
      if (statusFilter === 'approved' && !m.is_approved) return false;
      if (statusFilter === 'guest' && !isGuestUpload(m)) return false;
      if (sponsorMedia && !sponsorMedia.has(m.id)) return false;
      if (q) {
        const hay = `${m.filename} ${m.caption ?? ''} ${m.alt_text ?? ''} ${guestName(m) ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sort === 'custom') return filtered;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'oldest': return a.created_at.localeCompare(b.created_at);
        case 'name_asc': return a.filename.localeCompare(b.filename);
        case 'name_desc': return b.filename.localeCompare(a.filename);
        default: return b.created_at.localeCompare(a.created_at);
      }
    });
  }, [customSorted, search, typeFilter, statusFilter, sponsorMedia, sort]);

  const stats = useMemo(() => ({
    photos: media.filter((m) => mediaKind(m) === 'photo').length,
    videos: media.filter((m) => mediaKind(m) === 'video').length,
    bytes: media.reduce((s, m) => s + (m.bytes || 0), 0),
    pending: media.filter((m) => !m.is_approved).length,
  }), [media]);

  const selectedList = useMemo(() => media.filter((m) => selectedIds.has(m.id)), [media, selectedIds]);
  const selectionHasPending = selectedList.some((m) => !m.is_approved);
  const filtersActive = typeFilter !== 'all' || statusFilter !== 'all' || !!selectedSponsor || search.trim() !== '';

  // Selection only ever refers to items still in view.
  useEffect(() => {
    const ids = new Set(visible.map((m) => m.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  // ── Selection ────────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const anchor = lastClicked.current;
      if (shiftKey && anchor && anchor !== id) {
        // Shift-click selects the whole range between the anchor and here.
        const ids = visible.map((m) => m.id);
        const [from, to] = [ids.indexOf(anchor), ids.indexOf(id)].sort((a, b) => a - b);
        if (from >= 0) ids.slice(from, to + 1).forEach((x) => next.add(x));
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastClicked.current = id;
  }, [visible]);

  const clearSelection = () => { setSelectedIds(new Set()); lastClicked.current = null; };
  const allSelected = visible.length > 0 && visible.every((m) => selectedIds.has(m.id));
  const toggleSelectAll = () => (allSelected ? clearSelection() : setSelectedIds(new Set(visible.map((m) => m.id))));

  const anyModalOpen = showUpload || showAlbums || showAddToAlbum || showTagSponsors || !!deleteTarget || !!viewerId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (anyModalOpen) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape' && selectedIds.size > 0) clearSelection();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !dragMode && visible.length > 0) {
        e.preventDefault();
        setSelectedIds(new Set(visible.map((m) => m.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyModalOpen, selectedIds.size, dragMode, visible]);

  // ── Actions ──────────────────────────────────────────────────────────
  const setSponsorFilter = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('sponsorId', id); else next.delete('sponsorId');
    setSearchParams(next, { replace: true });
  };

  const setColumnsPersisted = (n: number) => {
    setColumns(n);
    try { localStorage.setItem(COLUMNS_KEY, String(n)); } catch { /* per-viewer convenience only */ }
  };

  const onRemoveFromAlbum = useCallback(async (mediaId: string, albumId: string) => {
    const resp = await removeFromAlbum(HOST_KIND, eventId, albumId, mediaId);
    if (resp.status !== 204) { toast.error(await errorMessage(resp, 'Failed to remove from album')); return; }
    setAlbumItems((prev) => prev.filter((i) => !(i.album_id === albumId && i.media_id === mediaId)));
    toast.success('Removed from album');
  }, [eventId]);

  const onRemoveSponsor = useCallback(async (mediaId: string, sponsorId: string) => {
    try {
      await untagMediaSponsor(mediaId, sponsorId);
      setSponsorTags((prev) => prev.filter((t) => !(t.media_id === mediaId && t.event_sponsor_id === sponsorId)));
      toast.success('Sponsor tag removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove sponsor tag');
    }
  }, []);

  const onReorder = useCallback(async (visibleIds: string[]) => {
    const merged = mergeSubsetOrder(customSorted.map((m) => m.id), visibleIds);
    const resp = selectedAlbum
      ? await setAlbumOrder(HOST_KIND, eventId, selectedAlbum, merged)
      : await setHostMediaOrder(HOST_KIND, eventId, merged);
    if (!resp.ok) {
      toast.error(await errorMessage(resp, 'Failed to save order'));
      throw new Error('order_failed');
    }
    const pos = new Map(merged.map((id, i) => [id, (i + 1) * 10]));
    if (selectedAlbum) {
      setAlbumItems((prev) => prev.map((i) => (i.album_id === selectedAlbum && pos.has(i.media_id) ? { ...i, sort_order: pos.get(i.media_id)! } : i)));
    } else {
      setMedia((prev) => prev.map((m) => (pos.has(m.id) ? { ...m, display_order: pos.get(m.id)! } : m)));
    }
    toast.success(selectedAlbum ? 'Album order saved' : 'Order saved');
  }, [customSorted, selectedAlbum, eventId]);

  const patchOne = useCallback(async (item: HostMediaItem, fields: Record<string, unknown>) => {
    const resp = await patchHostMedia(HOST_KIND, eventId, item.id, fields);
    if (!resp.ok) { toast.error(await errorMessage(resp, 'Update failed')); return false; }
    const row = (await resp.json()) as HostMediaItem;
    setMedia((prev) => prev.map((m) => (m.id === row.id ? row : m)));
    return true;
  }, [eventId]);

  const approveSelected = async () => {
    const ids = selectedList.filter((m) => !m.is_approved).map((m) => m.id);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const resp = await bulkPatchHostMedia(HOST_KIND, eventId, ids, { is_approved: true });
      if (!resp.ok) throw new Error(await errorMessage(resp, 'Approve failed'));
      const { updated } = (await resp.json()) as { updated: string[] };
      const done = new Set(updated);
      setMedia((prev) => prev.map((m) => (done.has(m.id) ? { ...m, is_approved: true } : m)));
      toast.success(`Approved ${updated.length} item(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const removeSelectedFromAlbum = async () => {
    if (!selectedAlbum) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    const results = await Promise.all(ids.map((id) => removeFromAlbum(HOST_KIND, eventId, selectedAlbum, id)));
    const removed = new Set(ids.filter((_, i) => results[i]!.status === 204));
    setAlbumItems((prev) => prev.filter((i) => !(i.album_id === selectedAlbum && removed.has(i.media_id))));
    setBulkBusy(false);
    clearSelection();
    if (removed.size === ids.length) toast.success(`Removed ${removed.size} item(s) from the album`);
    else toast.warning(`Removed ${removed.size} of ${ids.length} item(s) from the album`);
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    if (target.kind === 'single') {
      const resp = await deleteHostMedia(HOST_KIND, eventId, target.item.id);
      if (resp.status !== 204) { toast.error(await errorMessage(resp, 'Delete failed')); return; }
      setMedia((prev) => prev.filter((m) => m.id !== target.item.id));
      setViewerId(null);
      toast.success('Deleted');
      return;
    }
    setBulkBusy(true);
    try {
      const resp = await bulkDeleteHostMedia(HOST_KIND, eventId, target.ids);
      if (!resp.ok) throw new Error(await errorMessage(resp, 'Delete failed'));
      const { deleted, in_use } = (await resp.json()) as { deleted: string[]; in_use: string[] };
      const gone = new Set(deleted);
      setMedia((prev) => prev.filter((m) => !gone.has(m.id)));
      clearSelection();
      if (in_use.length) toast.warning(`Deleted ${deleted.length} item(s). ${in_use.length} are in use elsewhere and were kept.`);
      else toast.success(`Deleted ${deleted.length} item(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────
  const viewerIndex = viewerId ? visible.findIndex((m) => m.id === viewerId) : -1;
  const selectClass = 'rounded-md border border-[var(--gray-a6)] bg-[var(--color-panel-solid)] px-3 py-2 text-sm';

  const statCards = [
    { label: 'Photos', value: stats.photos, Icon: PhotoIcon },
    { label: 'Videos', value: stats.videos, Icon: VideoCameraIcon },
    { label: 'Albums', value: albums.length, Icon: FolderIcon },
    { label: 'Total size', value: formatFileSize(stats.bytes), Icon: ArrowUpTrayIcon },
    ...(stats.pending > 0 ? [{ label: 'Pending approval', value: stats.pending, Icon: ClockIcon }] : []),
  ];

  return (
    <>
      <GuestUploadLinksPanel eventId={eventId} />

      {loading ? (
        <div className="flex items-center justify-center py-12"><LoadingSpinner size="medium" /></div>
      ) : loadError ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-[var(--red-11)]">{loadError}</p>
          <Button className="mt-4" variant="outline" onClick={() => void loadAll()}>Try again</Button>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {statCards.map(({ label, value, Icon }) => (
              <Card key={label} className="p-4">
                <div className="flex items-center gap-3">
                  <Icon className="h-7 w-7 text-[var(--accent-11)]" />
                  <div>
                    <p className="text-xs font-medium text-[var(--gray-a10)]">{label}</p>
                    <p className="text-xl font-semibold">{value}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setShowUpload(true)}><PlusIcon className="h-4 w-4" /> Upload media</Button>
            <Button variant="outline" onClick={() => setShowAlbums(true)}><FolderIcon className="h-4 w-4" /> Manage albums</Button>
            <span className="flex-1" />
            <div className="relative">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--gray-a9)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, caption, guest…"
                className={`${selectClass} w-56 pl-8`}
              />
            </div>
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--gray-a6)]">
              {(['all', 'photos', 'videos'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter(t)}
                  className={`px-3 py-2 text-sm font-medium ${typeFilter === t ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--color-panel-solid)] text-[var(--gray-a11)] hover:bg-[var(--gray-a3)]'}`}
                >
                  {t === 'all' ? 'All' : t === 'photos' ? 'Photos' : 'Videos'}
                </button>
              ))}
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className={selectClass} aria-label="Status filter">
              <option value="all">Any status</option>
              <option value="pending">Pending approval</option>
              <option value="approved">Approved</option>
              <option value="guest">Guest uploads</option>
            </select>
            {sponsors.length > 0 && (
              <select value={selectedSponsor ?? ''} onChange={(e) => setSponsorFilter(e.target.value || null)} className={selectClass} aria-label="Sponsor filter">
                <option value="">All sponsors</option>
                {sponsors.map((s) => <option key={s.id} value={s.id}>{s.name} ({sponsorCounts.get(s.id) ?? 0})</option>)}
              </select>
            )}
            <select
              value={sort}
              onChange={(e) => {
                const next = e.target.value as SortOption;
                setSort(next);
                if (next !== 'custom') setDragMode(false);
              }}
              className={selectClass}
              aria-label="Sort"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name_asc">Name (A–Z)</option>
              <option value="name_desc">Name (Z–A)</option>
              <option value="custom">Custom order</option>
            </select>
            {sort === 'custom' && (
              <Button
                variant={dragMode ? 'solid' : 'outline'}
                onClick={() => { setDragMode((d) => !d); clearSelection(); }}
              >
                <ArrowsPointingOutIcon className="h-4 w-4" /> {dragMode ? 'Done reordering' : 'Reorder'}
              </Button>
            )}
            <label className="flex items-center gap-2 rounded-md border border-[var(--gray-a6)] px-3 py-2 text-sm" title={`${columns} per row`}>
              Size
              <input type="range" min={2} max={10} value={12 - columns} onChange={(e) => setColumnsPersisted(12 - Number(e.target.value))} className="w-20" />
            </label>
          </div>

          {selectedSponsor && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[var(--gray-a10)]">Filtering by sponsor:</span>
              <span className="inline-flex items-center gap-2 rounded-md bg-[var(--purple-a3)] px-3 py-1 font-medium text-[var(--purple-11)]">
                <TagIcon className="h-4 w-4" />
                {sponsorById.get(selectedSponsor)?.name ?? 'Unknown sponsor'}
                <button type="button" onClick={() => setSponsorFilter(null)} title="Clear sponsor filter"><XMarkIcon className="h-4 w-4" /></button>
              </span>
            </div>
          )}

          {albums.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedAlbum(null)}
                className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ${selectedAlbum === null ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)] text-[var(--gray-a11)] hover:bg-[var(--gray-a4)]'}`}
              >
                <FolderIcon className="h-4 w-4" /> All media <span className="text-xs opacity-75">({media.length})</span>
              </button>
              {albums.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedAlbum(a.id)}
                  title={a.description ?? undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ${selectedAlbum === a.id ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--gray-a3)] text-[var(--gray-a11)] hover:bg-[var(--gray-a4)]'}`}
                >
                  <FolderIcon className="h-4 w-4" /> {a.name} <span className="text-xs opacity-75">({albumCounts.get(a.id) ?? 0})</span>
                </button>
              ))}
            </div>
          )}

          {visible.length > 0 && selectedIds.size === 0 && (
            <p className="text-sm text-[var(--gray-a10)]">
              {dragMode
                ? `Drag items to reorder${selectedAlbum ? ' this album' : ''}. Changes save as you drop.${filtersActive ? ' Hidden items keep their places.' : ''}`
                : `Click to select (Shift-click for a range), double-click to open.${sort === 'custom' ? ' Use Reorder to drag items into place.' : ''}`}
              {' '}Showing {visible.length} of {selectedAlbum ? albumCounts.get(selectedAlbum) ?? 0 : media.length}.
            </p>
          )}

          <div className={selectedIds.size > 0 ? 'pb-24' : ''}>
            {visible.length === 0 ? (
              <Card className="p-12 text-center">
                <PhotoIcon className="mx-auto h-12 w-12 text-[var(--gray-a8)]" />
                <h3 className="mt-4 text-lg font-medium">{media.length === 0 ? 'No media yet' : 'Nothing matches these filters'}</h3>
                <p className="mt-2 text-sm text-[var(--gray-a10)]">
                  {media.length === 0
                    ? 'Upload photos or videos, or share a guest upload link.'
                    : 'Try a different album, sponsor, status or search.'}
                </p>
                {media.length === 0 && (
                  <Button className="mt-4" onClick={() => setShowUpload(true)}><PlusIcon className="h-4 w-4" /> Upload media</Button>
                )}
              </Card>
            ) : (
              <MediaGrid
                items={visible}
                chipsFor={chipsFor}
                selectedIds={selectedIds}
                newlyAddedIds={newlyAddedIds}
                columns={columns}
                dragMode={dragMode}
                onToggleSelect={toggleSelect}
                onView={(item) => setViewerId(item.id)}
                onRemoveFromAlbum={onRemoveFromAlbum}
                onRemoveSponsor={onRemoveSponsor}
                onReorder={onReorder}
              />
            )}
          </div>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-2rem)] max-w-max -translate-x-1/2">
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-[var(--gray-a5)] bg-[var(--color-panel-solid)] px-4 py-3 shadow-xl">
            <span className="whitespace-nowrap text-sm font-medium">{selectedIds.size} selected</span>
            <span className="h-6 w-px bg-[var(--gray-a5)]" />
            <Button size="sm" variant="soft" onClick={toggleSelectAll}>{allSelected ? 'Deselect all' : 'Select all'}</Button>
            <Button size="sm" onClick={() => setShowAddToAlbum(true)} disabled={bulkBusy}><FolderIcon className="h-4 w-4" /> Add to album</Button>
            {selectedAlbum && (
              <Button size="sm" variant="outline" onClick={removeSelectedFromAlbum} disabled={bulkBusy}>
                <FolderMinusIcon className="h-4 w-4" /> Remove from album
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => setShowTagSponsors(true)}
              disabled={bulkBusy || sponsors.length === 0}
              title={sponsors.length === 0 ? 'This event has no active sponsors' : undefined}
            >
              <TagIcon className="h-4 w-4" /> Tag sponsors
            </Button>
            {selectionHasPending && (
              <Button size="sm" color="green" onClick={approveSelected} disabled={bulkBusy}>
                <CheckCircleIcon className="h-4 w-4" /> Approve
              </Button>
            )}
            <Button size="sm" variant="outline" color="red" onClick={() => setDeleteTarget({ kind: 'bulk', ids: [...selectedIds] })} disabled={bulkBusy}>
              <TrashIcon className="h-4 w-4" /> Delete
            </Button>
            <Button size="sm" variant="outline" onClick={clearSelection}><XMarkIcon className="h-4 w-4" /> Cancel</Button>
          </div>
        </div>
      )}

      {showUpload && (
        <MediaUploadModal
          eventId={eventId}
          albums={albums}
          defaultAlbumId={selectedAlbum}
          onClose={() => setShowUpload(false)}
          onDone={() => { void loadAll(); }}
        />
      )}

      {showAlbums && (
        <AlbumManagementModal
          eventId={eventId}
          albums={albums}
          albumCounts={albumCounts}
          onClose={() => setShowAlbums(false)}
          onChanged={() => { void reloadAlbums(); }}
          onDeleted={(id) => { if (selectedAlbum === id) setSelectedAlbum(null); }}
        />
      )}

      {showAddToAlbum && (
        <AddToAlbumModal
          eventId={eventId}
          albums={albums}
          albumCounts={albumCounts}
          selectedMediaIds={[...selectedIds]}
          onClose={() => setShowAddToAlbum(false)}
          onSuccess={() => { setShowAddToAlbum(false); clearSelection(); void reloadAlbums(); }}
        />
      )}

      {showTagSponsors && (
        <TagSponsorsModal
          sponsors={sponsors}
          selectedMediaIds={[...selectedIds]}
          onClose={() => setShowTagSponsors(false)}
          onSuccess={() => { setShowTagSponsors(false); clearSelection(); void reloadTags(sponsors); }}
        />
      )}

      {viewerIndex >= 0 && (
        <MediaViewerModal
          items={visible}
          index={viewerIndex}
          chips={chipsFor(visible[viewerIndex]!.id)}
          onNavigate={(i) => { const next = visible[i]; if (next) setViewerId(next.id); }}
          onClose={() => setViewerId(null)}
          onPatch={patchOne}
          onDelete={(item) => setDeleteTarget({ kind: 'single', item })}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          isOpen
          onClose={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
          title={deleteTarget.kind === 'bulk' ? 'Delete selected media?' : 'Delete media?'}
          message={
            deleteTarget.kind === 'bulk'
              ? `Delete ${deleteTarget.ids.length} item(s)? This cannot be undone. Items used elsewhere are kept.`
              : `Delete "${deleteTarget.item.filename}"? This cannot be undone.`
          }
          confirmText="Delete"
          confirmColor="red"
        />
      )}
    </>
  );
}

export default EventMediaTab;
