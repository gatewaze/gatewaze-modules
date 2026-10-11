/**
 * Organizer grid. One tile component serves both modes: selection
 * (click to select, double-click to open) and reorder (drag with
 * dnd-kit). Tiles show album and sponsor chips that remove the
 * membership/tag when clicked, plus guest, approval and YouTube badges.
 *
 * Ported from the legacy gatewaze-admin MediaGalleryView +
 * DraggableMediaGallery, now over host_media rows.
 */

import { useEffect, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  PhotoIcon,
  VideoCameraIcon,
  MusicalNoteIcon,
  ClockIcon,
  FolderIcon,
  TagIcon,
  XMarkIcon,
  UserIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import {
  type HostMediaItem,
  type HostMediaAlbum,
  type EventSponsorOption,
  mediaKind,
  guestName,
  formatDuration,
} from '../utils/mediaOrganizerService';

export interface TileChips {
  albums: HostMediaAlbum[];
  sponsors: EventSponsorOption[];
}

interface MediaGridProps {
  items: HostMediaItem[];
  chipsFor: (mediaId: string) => TileChips;
  selectedIds: Set<string>;
  newlyAddedIds: Set<string>;
  columns: number;
  dragMode: boolean;
  onToggleSelect: (mediaId: string, shiftKey: boolean) => void;
  onView: (item: HostMediaItem) => void;
  onRemoveFromAlbum: (mediaId: string, albumId: string) => Promise<void>;
  onRemoveSponsor: (mediaId: string, sponsorId: string) => Promise<void>;
  /** Called with the full new order of `items` after a drop. */
  onReorder: (orderedIds: string[]) => Promise<void>;
}

function previewUrl(item: HostMediaItem): string | null {
  const kind = mediaKind(item);
  if (kind === 'photo') return item.thumb_url ?? item.cdn_url;
  if (kind === 'video') return item.youtube_thumbnail_url ?? item.thumb_url ?? null;
  return null;
}

function truncate(s: string, n = 12): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function Preview({ item }: { item: HostMediaItem }) {
  const [src, setSrc] = useState(previewUrl(item));
  useEffect(() => setSrc(previewUrl(item)), [item]);
  const kind = mediaKind(item);

  if (src) {
    return (
      <img
        src={src}
        alt={item.alt_text || item.caption || item.filename}
        className="h-full w-full object-cover"
        loading="lazy"
        draggable={false}
        // The render (resize) endpoint is not enabled on every Supabase
        // project; fall back to the original file once.
        onError={() => { if (kind === 'photo' && src !== item.cdn_url) setSrc(item.cdn_url); }}
      />
    );
  }
  const Icon = kind === 'video' ? VideoCameraIcon : kind === 'audio' ? MusicalNoteIcon : PhotoIcon;
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Icon className="h-12 w-12 text-[var(--gray-a8)]" />
    </div>
  );
}

interface TileProps {
  item: HostMediaItem;
  chips: TileChips;
  selected: boolean;
  newlyAdded: boolean;
  dragMode: boolean;
  onToggleSelect: (mediaId: string, shiftKey: boolean) => void;
  onView: (item: HostMediaItem) => void;
  onRemoveFromAlbum: (mediaId: string, albumId: string) => Promise<void>;
  onRemoveSponsor: (mediaId: string, sponsorId: string) => Promise<void>;
}

function Chip({
  label,
  tone,
  disabled,
  onRemove,
}: {
  label: string;
  tone: 'album' | 'sponsor';
  disabled: boolean;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const toneClass = tone === 'album'
    ? 'bg-[var(--blue-a3)] text-[var(--blue-11)]'
    : 'bg-[var(--purple-a3)] text-[var(--purple-11)]';
  return (
    <button
      type="button"
      title={disabled ? label : `${label} (click to remove)`}
      disabled={disabled || busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try { await onRemove(); } finally { setBusy(false); }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`group/chip inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${toneClass} ${busy ? 'opacity-50' : ''}`}
    >
      <span>{truncate(label)}</span>
      {!disabled && <XMarkIcon className="hidden h-3 w-3 group-hover/chip:inline" />}
    </button>
  );
}

function Tile({
  item,
  chips,
  selected,
  newlyAdded,
  dragMode,
  onToggleSelect,
  onView,
  onRemoveFromAlbum,
  onRemoveSponsor,
}: TileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !dragMode,
  });
  const kind = mediaKind(item);
  const guest = guestName(item);
  const hidden = ((item.metadata ?? {}) as Record<string, unknown>)['hidden'] === true;
  const yt = item.youtube_upload_status;

  const ring = newlyAdded
    ? 'ring-2 ring-[var(--green-9)] animate-pulse'
    : selected
      ? 'ring-2 ring-[var(--accent-9)]'
      : '';

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      {...(dragMode ? { ...attributes, ...listeners } : {})}
    >
      <div
        className={`group relative overflow-hidden rounded-lg border border-[var(--gray-a5)] bg-[var(--color-panel-solid)] transition-shadow hover:shadow-md ${ring} ${dragMode ? 'cursor-move' : 'cursor-pointer'}`}
        onClick={(e) => { if (!dragMode) onToggleSelect(item.id, e.shiftKey); }}
        onDoubleClick={(e) => { if (!dragMode) { e.stopPropagation(); onView(item); } }}
      >
        {!dragMode && (
          <div className={`absolute left-2 top-2 z-10 transition-opacity ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <input
              type="checkbox"
              aria-label={`Select ${item.filename}`}
              checked={selected}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onToggleSelect(item.id, (e.nativeEvent as MouseEvent).shiftKey === true)}
              className="h-5 w-5 cursor-pointer rounded"
            />
          </div>
        )}
        {dragMode && (
          <div className="absolute right-2 top-2 z-20 rounded-full bg-black/70 p-1.5" aria-hidden>
            <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
            </svg>
          </div>
        )}

        <div className="relative aspect-square bg-[var(--gray-a3)]">
          <Preview item={item} />

          {!dragMode && (
            <div className="absolute right-2 top-2 rounded bg-black/50 p-1">
              {kind === 'video'
                ? <VideoCameraIcon className="h-4 w-4 text-white" />
                : kind === 'audio'
                  ? <MusicalNoteIcon className="h-4 w-4 text-white" />
                  : <PhotoIcon className="h-4 w-4 text-white" />}
            </div>
          )}

          {kind === 'video' && !dragMode && (
            <div className="absolute bottom-2 left-2 flex gap-1">
              {item.youtube_video_id && yt === 'completed' && (
                <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">YouTube</span>
              )}
              {(yt === 'pending' || yt === 'processing') && (
                <span className="rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {yt === 'pending' ? 'Uploading to YouTube' : 'Processing'}
                </span>
              )}
              {yt === 'failed' && (
                <span className="rounded bg-red-800 px-1.5 py-0.5 text-[10px] font-semibold text-white" title="YouTube upload failed; stored as a file instead">
                  YouTube failed
                </span>
              )}
            </div>
          )}
          {item.duration ? (
            <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white">
              <ClockIcon className="h-3 w-3" />
              {formatDuration(item.duration)}
            </div>
          ) : null}
        </div>

        <div className={`space-y-1.5 p-2 ${dragMode ? 'opacity-60' : ''}`}>
          {chips.albums.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-[var(--gray-a9)]" />
              {chips.albums.slice(0, 2).map((a) => (
                <Chip key={a.id} label={a.name} tone="album" disabled={dragMode} onRemove={() => onRemoveFromAlbum(item.id, a.id)} />
              ))}
              {chips.albums.length > 2 && (
                <span className="text-xs text-[var(--gray-a9)]" title={chips.albums.slice(2).map((a) => a.name).join(', ')}>
                  +{chips.albums.length - 2}
                </span>
              )}
            </div>
          )}
          {chips.sponsors.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <TagIcon className="h-3.5 w-3.5 shrink-0 text-[var(--gray-a9)]" />
              {chips.sponsors.slice(0, 2).map((s) => (
                <Chip key={s.id} label={s.name} tone="sponsor" disabled={dragMode} onRemove={() => onRemoveSponsor(item.id, s.id)} />
              ))}
              {chips.sponsors.length > 2 && (
                <span className="text-xs text-[var(--gray-a9)]" title={chips.sponsors.slice(2).map((s) => s.name).join(', ')}>
                  +{chips.sponsors.length - 2}
                </span>
              )}
            </div>
          )}
          {chips.albums.length === 0 && chips.sponsors.length === 0 && (
            <div className="text-xs italic text-[var(--gray-a8)]">No tags or albums</div>
          )}
          {(guest || !item.is_approved || hidden) && (
            <div className="flex flex-wrap items-center gap-1">
              {guest && (
                <span className="inline-flex items-center gap-1 text-xs text-[var(--gray-a10)]" title="Guest upload">
                  <UserIcon className="h-3 w-3" />{truncate(guest, 16)}
                </span>
              )}
              {!item.is_approved && (
                <span className="rounded-full bg-[var(--amber-a3)] px-2 py-0.5 text-xs font-medium text-[var(--amber-11)]">
                  Pending approval
                </span>
              )}
              {hidden && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--gray-a3)] px-2 py-0.5 text-xs text-[var(--gray-a11)]" title="Hidden from the guest gallery">
                  <EyeSlashIcon className="h-3 w-3" />Hidden
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MediaGrid({
  items,
  chipsFor,
  selectedIds,
  newlyAddedIds,
  columns,
  dragMode,
  onToggleSelect,
  onView,
  onRemoveFromAlbum,
  onRemoveSponsor,
  onReorder,
}: MediaGridProps) {
  // Local copy so a drop renders immediately; re-synced from props.
  const [ordered, setOrdered] = useState(items);
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => setOrdered(items), [items]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ordered.findIndex((i) => i.id === active.id);
    const to = ordered.findIndex((i) => i.id === over.id);
    const next = arrayMove(ordered, from, to);
    setOrdered(next);
    try {
      await onReorder(next.map((i) => i.id));
    } catch {
      setOrdered(items); // parent already reported the error
    }
  };

  const active = activeId ? ordered.find((i) => i.id === activeId) : null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <SortableContext items={ordered.map((i) => i.id)} strategy={rectSortingStrategy}>
        {/* Inline style: dynamic grid-cols-N classes are purged from module files. */}
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {ordered.map((item) => (
            <Tile
              key={item.id}
              item={item}
              chips={chipsFor(item.id)}
              selected={selectedIds.has(item.id)}
              newlyAdded={newlyAddedIds.has(item.id)}
              dragMode={dragMode}
              onToggleSelect={onToggleSelect}
              onView={onView}
              onRemoveFromAlbum={onRemoveFromAlbum}
              onRemoveSponsor={onRemoveSponsor}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {active ? (
          <div className="aspect-square overflow-hidden rounded-lg opacity-80 shadow-2xl">
            <Preview item={active} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
