import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card, Modal } from '@/components/ui';
import { PlusIcon, PencilIcon, TrashIcon, CalendarDaysIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface SubEvent {
  id: string;
  event_id: string;
  name: string;
  slug: string | null;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  rsvp_deadline: string | null;
  sort_order: number;
  linked_rsvp: boolean;
}

// Normalize a free-text slug to the lowercase-alphanumeric-dash shape we
// match against in the CSV importer (e.g. "Day!" → "day", "Evening party"
// → "evening-party"). Empty after normalization → null.
function normalizeSlug(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || null;
}

interface SubEventConfigPanelProps {
  eventUuid: string;
  onSubEventsChange?: (subEvents: SubEvent[]) => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function SubEventConfigPanel({ eventUuid, onSubEventsChange }: SubEventConfigPanelProps) {
  const [subEvents, setSubEvents] = useState<SubEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SubEvent | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [rsvpDeadline, setRsvpDeadline] = useState('');
  const [linkedRsvp, setLinkedRsvp] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadSubEvents = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('invite_sub_events')
        .select('*')
        .eq('event_id', eventUuid)
        .order('sort_order');

      if (error) throw error;
      const list = data || [];
      setSubEvents(list);
      onSubEventsChange?.(list);
    } catch (error) {
      console.error('Error loading sub-events:', error);
      toast.error('Failed to load sub-events');
    } finally {
      setLoading(false);
    }
  }, [eventUuid, onSubEventsChange]);

  useEffect(() => {
    loadSubEvents();
  }, [loadSubEvents]);

  const resetForm = () => {
    setName('');
    setSlug('');
    setDescription('');
    setStartsAt('');
    setEndsAt('');
    setRsvpDeadline('');
    setLinkedRsvp(false);
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (se: SubEvent) => {
    setEditing(se);
    setName(se.name);
    setSlug(se.slug || '');
    setDescription(se.description || '');
    setStartsAt(se.starts_at ? se.starts_at.slice(0, 16) : '');
    setEndsAt(se.ends_at ? se.ends_at.slice(0, 16) : '');
    setRsvpDeadline(se.rsvp_deadline ? se.rsvp_deadline.slice(0, 16) : '');
    setLinkedRsvp(se.linked_rsvp ?? false);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        event_id: eventUuid,
        name: name.trim(),
        slug: normalizeSlug(slug),
        description: description.trim() || null,
        starts_at: startsAt || null,
        ends_at: endsAt || null,
        rsvp_deadline: rsvpDeadline || null,
        linked_rsvp: linkedRsvp,
        sort_order: editing ? editing.sort_order : subEvents.length,
      };

      if (editing) {
        const { error } = await supabase
          .from('invite_sub_events')
          .update(payload)
          .eq('id', editing.id);
        if (error) throw error;
        toast.success('Sub-event updated');
      } else {
        const { error } = await supabase
          .from('invite_sub_events')
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        toast.success('Sub-event added');
      }

      setShowForm(false);
      resetForm();
      loadSubEvents();
    } catch (error) {
      console.error('Error saving sub-event:', error);
      toast.error('Failed to save sub-event');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this sub-event? Guest assignments to it will also be removed.')) return;

    try {
      const { error } = await supabase
        .from('invite_sub_events')
        .delete()
        .eq('id', id);
      if (error) throw error;
      toast.success('Sub-event deleted');
      loadSubEvents();
    } catch (error) {
      console.error('Error deleting sub-event:', error);
      toast.error('Failed to delete sub-event');
    }
  };

  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const updated = [...subEvents];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    for (let i = 0; i < updated.length; i++) {
      await supabase.from('invite_sub_events').update({ sort_order: i }).eq('id', updated[i].id);
    }
    loadSubEvents();
  };

  const handleMoveDown = async (index: number) => {
    if (index === subEvents.length - 1) return;
    const updated = [...subEvents];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    for (let i = 0; i < updated.length; i++) {
      await supabase.from('invite_sub_events').update({ sort_order: i }).eq('id', updated[i].id);
    }
    loadSubEvents();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Sub-Events</h3>
        <Button variant="soft" size="1" onClick={openCreate}>
          <PlusIcon className="w-4 h-4 mr-1" />
          Add Sub-Event
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--gray-9)]">Loading sub-events...</p>
      ) : subEvents.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-[var(--gray-9)] text-center">
            No sub-events configured. Add sub-events if guests are invited to different parts of this event (e.g., Day Ceremony and Evening Reception).
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {subEvents.map((se, i) => (
            <Card key={se.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 flex-1">
                  <div className="flex flex-col gap-0.5 mt-1">
                    <button
                      onClick={() => handleMoveUp(i)}
                      disabled={i === 0}
                      className="text-xs text-[var(--gray-9)] hover:text-[var(--gray-12)] disabled:opacity-30 cursor-pointer disabled:cursor-default"
                      aria-label="Move up"
                    >
                      &#9650;
                    </button>
                    <button
                      onClick={() => handleMoveDown(i)}
                      disabled={i === subEvents.length - 1}
                      className="text-xs text-[var(--gray-9)] hover:text-[var(--gray-12)] disabled:opacity-30 cursor-pointer disabled:cursor-default"
                      aria-label="Move down"
                    >
                      &#9660;
                    </button>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-[var(--gray-12)]">
                      {se.name}
                      {se.linked_rsvp && <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded bg-[var(--accent-3)] text-[var(--accent-11)]">Linked</span>}
                    </p>
                    {se.description && (
                      <p className="text-xs text-[var(--gray-9)] mt-0.5">{se.description}</p>
                    )}
                    <div className="flex flex-wrap gap-3 mt-1.5">
                      {(se.starts_at || se.ends_at) && (
                        <span className="inline-flex items-center gap-1 text-xs text-[var(--gray-9)]">
                          <CalendarDaysIcon className="w-3.5 h-3.5" />
                          {se.starts_at && formatDateTime(se.starts_at)}
                          {se.starts_at && se.ends_at && ' - '}
                          {se.ends_at && formatDateTime(se.ends_at)}
                        </span>
                      )}
                      {se.rsvp_deadline && (
                        <span className="text-xs text-[var(--gray-9)]">
                          RSVP by {formatDateTime(se.rsvp_deadline)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(se)} className="text-[var(--gray-9)] hover:text-[var(--gray-12)] cursor-pointer">
                    <PencilIcon className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(se.id)} className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer">
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={showForm}
        onClose={() => { setShowForm(false); resetForm(); }}
        title={editing ? 'Edit Sub-Event' : 'Add Sub-Event'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => { setShowForm(false); resetForm(); }} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editing ? 'Update' : 'Add Sub-Event'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Evening Reception"
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Slug <span className="text-[var(--gray-10)] font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="e.g. day, evening"
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
            <p className="text-xs text-[var(--gray-a11)] mt-1">
              Short identifier used to match CSV import column values (e.g. put &quot;day&quot; or &quot;evening&quot; in an Invite column and it maps to this sub-event). Lowercased and dashed automatically; unique per event.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description"
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Start Time</label>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={e => setStartsAt(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">End Time</label>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={e => setEndsAt(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">RSVP Deadline</label>
            <input
              type="datetime-local"
              value={rsvpDeadline}
              onChange={e => setRsvpDeadline(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-[var(--gray-12)] cursor-pointer">
              <input
                type="checkbox"
                checked={linkedRsvp}
                onChange={e => setLinkedRsvp(e.target.checked)}
                className="rounded"
              />
              Linked RSVP
            </label>
            <p className="mt-1 text-xs text-[var(--gray-9)]">
              When enabled, accepting any linked sub-event automatically accepts all others for that person. Use for weddings where day attendance implies evening attendance.
            </p>
          </div>

        </div>
      </Modal>
    </div>
  );
}
