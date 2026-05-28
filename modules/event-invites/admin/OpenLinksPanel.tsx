import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card, Badge, Modal } from '@/components/ui';
import {
  PlusIcon,
  ClipboardDocumentIcon,
  TrashIcon,
  LinkIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  listOpenLinks,
  createOpenLink,
  updateOpenLink,
  deleteOpenLink,
  type InviteOpenLink,
} from './utils/inviteOpenLinkService';

interface OpenLinksPanelProps {
  eventUuid: string;
}

interface SubEvent {
  id: string;
  name: string;
  sort_order: number;
}

export function OpenLinksPanel({ eventUuid }: OpenLinksPanelProps) {
  const [links, setLinks] = useState<InviteOpenLink[]>([]);
  const [subEvents, setSubEvents] = useState<SubEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InviteOpenLink | null>(null);

  // Create form state
  const [label, setLabel] = useState('');
  const [formSubEventId, setFormSubEventId] = useState('');
  const [maxMembers, setMaxMembers] = useState(10);

  const portalUrl =
    import.meta.env.VITE_PORTAL_URL ||
    import.meta.env.VITE_APP_URL ||
    window.location.origin;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [linksData, subEventsResult] = await Promise.all([
        listOpenLinks(eventUuid),
        supabase
          .from('invite_sub_events')
          .select('id, name, sort_order')
          .eq('event_id', eventUuid)
          .order('sort_order'),
      ]);
      setLinks(linksData);
      setSubEvents(subEventsResult.data || []);
    } catch (err: any) {
      console.error('Failed to load open links:', err);
      toast.error(`Failed to load open links: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = () => {
    setLabel('');
    setFormSubEventId('');
    setMaxMembers(10);
  };

  const openCreate = () => {
    resetForm();
    setShowCreate(true);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await createOpenLink({
        event_id: eventUuid,
        sub_event_id: formSubEventId || null,
        label: label.trim() || null,
        max_members_per_party: maxMembers,
      });
      toast.success('Open link created');
      setShowCreate(false);
      resetForm();
      loadData();
    } catch (err: any) {
      toast.error(`Failed to create link: ${err.message || err}`);
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (link: InviteOpenLink) => {
    try {
      await updateOpenLink(link.id, { is_active: !link.is_active });
      toast.success(`Link ${link.is_active ? 'disabled' : 'enabled'}`);
      loadData();
    } catch (err: any) {
      toast.error(`Failed to update: ${err.message || err}`);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteOpenLink(deleteTarget.id);
      toast.success('Link deleted');
      setDeleteTarget(null);
      loadData();
    } catch (err: any) {
      toast.error(`Failed to delete: ${err.message || err}`);
    }
  };

  const buildUrl = (link: InviteOpenLink): string => {
    return `${portalUrl}/o/${link.short_code}`;
  };

  const handleCopy = (link: InviteOpenLink) => {
    const url = buildUrl(link);
    navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied to clipboard'),
      () => toast.error('Failed to copy link'),
    );
  };

  const subEventMap = new Map(subEvents.map(se => [se.id, se.name]));

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--gray-12)] flex items-center gap-2">
            <LinkIcon className="w-4 h-4" />
            Open RSVP Links
          </h3>
          <p className="text-xs text-[var(--gray-9)] mt-0.5">
            Share a single link with anyone — they&apos;ll register their own name and party, and RSVP directly. Each submission creates a new party.
          </p>
        </div>
        <Button variant="soft" size="1" onClick={openCreate}>
          <PlusIcon className="w-4 h-4 mr-1" />
          Create Link
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--gray-9)]">Loading...</p>
      ) : links.length === 0 ? (
        <p className="text-sm text-[var(--gray-9)] text-center py-6">
          No open links yet. Create one to share with guests.
        </p>
      ) : (
        <div className="space-y-2">
          {links.map(link => {
            const url = buildUrl(link);
            const scope = link.sub_event_id
              ? (subEventMap.get(link.sub_event_id) || 'Unknown sub-event')
              : 'All sub-events';
            return (
              <div
                key={link.id}
                className="flex items-center justify-between gap-3 p-3 rounded border border-[var(--gray-6)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[var(--gray-12)] truncate">
                      {link.label || '(unlabelled)'}
                    </p>
                    <Badge color={link.is_active ? 'green' : 'gray'}>
                      {link.is_active ? 'Active' : 'Disabled'}
                    </Badge>
                    <Badge color="blue">{scope}</Badge>
                  </div>
                  <p className="text-xs text-[var(--gray-9)] mt-0.5 font-mono truncate">{url}</p>
                  <p className="text-[10px] text-[var(--gray-9)] mt-0.5">
                    {link.times_used} submission{link.times_used !== 1 ? 's' : ''}
                    {link.last_used_at ? ` · last used ${new Date(link.last_used_at).toLocaleDateString()}` : ''}
                    {' · max '}
                    {link.max_members_per_party} per party
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleCopy(link)}
                    className="text-[var(--gray-9)] hover:text-[var(--gray-12)] cursor-pointer"
                    title="Copy link"
                    aria-label="Copy link"
                  >
                    <ClipboardDocumentIcon className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleActive(link)}
                    className="relative inline-flex items-center rounded-full transition-colors cursor-pointer"
                    style={{
                      width: 36,
                      height: 20,
                      backgroundColor: link.is_active ? 'var(--accent-9)' : 'var(--gray-6)',
                    }}
                    aria-label={link.is_active ? 'Disable' : 'Enable'}
                  >
                    <span
                      className="inline-block rounded-full bg-white"
                      style={{
                        width: 14,
                        height: 14,
                        transform: `translateX(${link.is_active ? 18 : 3}px)`,
                        transition: 'transform 150ms ease',
                      }}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(link)}
                    className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer"
                    title="Delete"
                    aria-label="Delete"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => { setShowCreate(false); resetForm(); }}
        title="Create Open Link"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => { setShowCreate(false); resetForm(); }} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Link'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Label</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Venue flyer, social media post"
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
            <p className="text-xs text-[var(--gray-9)] mt-1">Admin-only label to help you keep track of where you shared this link.</p>
          </div>

          {subEvents.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Scope</label>
              <select
                value={formSubEventId}
                onChange={e => setFormSubEventId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              >
                <option value="">All sub-events (guest picks)</option>
                {subEvents.map(se => (
                  <option key={se.id} value={se.id}>{se.name} only</option>
                ))}
              </select>
              <p className="text-xs text-[var(--gray-9)] mt-1">
                Scope the link to a specific sub-event, or leave as &ldquo;All&rdquo; to let the guest choose which ones they&apos;re attending.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Max members per party</label>
            <input
              type="number"
              min={1}
              max={50}
              value={maxMembers}
              onChange={e => setMaxMembers(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
            <p className="text-xs text-[var(--gray-9)] mt-1">How many people a single guest can add to their party (including themselves).</p>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Open Link"
        footer={
          deleteTarget && (
            <div className="flex justify-end gap-2">
              <Button variant="soft" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button color="red" onClick={handleDelete}>Delete</Button>
            </div>
          )
        }
      >
        {deleteTarget && (
          <p className="text-sm text-[var(--gray-12)]">
            Delete the link <span className="font-medium">{deleteTarget.label || deleteTarget.short_code}</span>?
            Any parties already created through this link will remain, but new submissions will be rejected.
          </p>
        )}
      </Modal>
    </Card>
  );
}
