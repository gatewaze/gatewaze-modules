import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Badge, Button, Modal } from '@/components/ui';
import { Input, Select } from '@/components/ui';
import { toast } from 'sonner';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  StarIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

interface TrackConfigPanelProps {
  eventUuid: string;
}

interface Track {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  youtube_video_id: string | null;
  stream_status: 'upcoming' | 'live' | 'ended' | 'replay';
  is_default: boolean;
  sort_order: number;
}

interface TrackFormData {
  name: string;
  description: string;
  youtube_video_id: string;
  stream_status: 'upcoming' | 'live' | 'ended' | 'replay';
}

const STREAM_STATUS_OPTIONS = [
  { label: 'Upcoming', value: 'upcoming' },
  { label: 'Live', value: 'live' },
  { label: 'Ended', value: 'ended' },
  { label: 'Replay', value: 'replay' },
];

const STATUS_COLORS: Record<string, 'green' | 'red' | 'gray' | 'blue'> = {
  upcoming: 'gray',
  live: 'green',
  ended: 'red',
  replay: 'blue',
};

const EMPTY_FORM: TrackFormData = {
  name: '',
  description: '',
  youtube_video_id: '',
  stream_status: 'upcoming',
};

export function TrackConfigPanel({ eventUuid }: TrackConfigPanelProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [form, setForm] = useState<TrackFormData>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const loadTracks = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('live_event_tracks')
        .select('*')
        .eq('event_id', eventUuid)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setTracks((data as Track[]) || []);
    } catch (err) {
      console.error('Failed to load tracks:', err);
      toast.error('Failed to load tracks');
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  const openAddModal = () => {
    setEditingTrack(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEditModal = (track: Track) => {
    setEditingTrack(track);
    setForm({
      name: track.name,
      description: track.description || '',
      youtube_video_id: track.youtube_video_id || '',
      stream_status: track.stream_status,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error('Track name is required');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        event_id: eventUuid,
        name: form.name.trim(),
        description: form.description.trim() || null,
        youtube_video_id: form.youtube_video_id.trim() || null,
        stream_status: form.stream_status,
      };

      if (editingTrack) {
        const { error } = await supabase
          .from('live_event_tracks')
          .update(payload)
          .eq('id', editingTrack.id);
        if (error) throw error;
        toast.success('Track updated');
      } else {
        const nextOrder = tracks.length > 0
          ? Math.max(...tracks.map(t => t.sort_order)) + 1
          : 0;
        const { error } = await supabase
          .from('live_event_tracks')
          .insert({ ...payload, sort_order: nextOrder, is_default: tracks.length === 0 });
        if (error) throw error;
        toast.success('Track created');
      }

      setModalOpen(false);
      await loadTracks();
    } catch (err) {
      console.error('Failed to save track:', err);
      toast.error('Failed to save track');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (track: Track) => {
    if (!confirm(`Delete track "${track.name}"? This will also delete all chat messages for this track.`)) return;

    try {
      const { error } = await supabase
        .from('live_event_tracks')
        .delete()
        .eq('id', track.id);
      if (error) throw error;
      toast.success('Track deleted');
      await loadTracks();
    } catch (err) {
      console.error('Failed to delete track:', err);
      toast.error('Failed to delete track');
    }
  };

  const setDefault = async (track: Track) => {
    try {
      // Unset all defaults for this event
      await supabase
        .from('live_event_tracks')
        .update({ is_default: false })
        .eq('event_id', eventUuid);

      // Set the selected track as default
      const { error } = await supabase
        .from('live_event_tracks')
        .update({ is_default: true })
        .eq('id', track.id);

      if (error) throw error;
      toast.success(`"${track.name}" set as default track`);
      await loadTracks();
    } catch (err) {
      console.error('Failed to set default track:', err);
      toast.error('Failed to set default track');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--gray-11)]">
          {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} configured
        </p>
        <Button onClick={openAddModal} size="sm" color="primary">
          <PlusIcon className="w-4 h-4 mr-1" />
          Add Track
        </Button>
      </div>

      {tracks.length === 0 && (
        <Card>
          <div className="p-8 text-center text-[var(--gray-11)]">
            <p>No tracks configured yet. Add a track to get started.</p>
          </div>
        </Card>
      )}

      <div className="grid gap-3">
        {tracks.map((track) => (
          <Card key={track.id}>
            <div className="p-4 flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="font-medium truncate">{track.name}</h4>
                  <Badge color={STATUS_COLORS[track.stream_status]}>
                    {track.stream_status}
                  </Badge>
                  {track.is_default && (
                    <Badge color="blue">Default</Badge>
                  )}
                </div>
                {track.description && (
                  <p className="text-sm text-[var(--gray-11)] mb-2">{track.description}</p>
                )}
                {track.youtube_video_id && (
                  <div className="mt-2">
                    <p className="text-xs text-[var(--gray-11)] mb-1">
                      YouTube ID: <code className="bg-[var(--gray-a3)] px-1 rounded">{track.youtube_video_id}</code>
                    </p>
                    <div className="aspect-video max-w-sm rounded overflow-hidden border border-[var(--gray-a5)]">
                      <iframe
                        src={`https://www.youtube.com/embed/${track.youtube_video_id}`}
                        className="w-full h-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        title={`${track.name} preview`}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDefault(track)}
                  title={track.is_default ? 'Default track' : 'Set as default'}
                >
                  {track.is_default
                    ? <StarIconSolid className="w-4 h-4 text-yellow-500" />
                    : <StarIcon className="w-4 h-4" />
                  }
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openEditModal(track)}>
                  <PencilIcon className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" color="red" onClick={() => handleDelete(track)}>
                  <TrashIcon className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <p className="text-xs text-[var(--gray-11)] italic">
        Remember to disable YouTube Live Chat in YouTube Studio and add a link to your Gatewaze event page in the stream description.
      </p>

      {/* Add / Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingTrack ? 'Edit Track' : 'Add Track'}
      >
        <div className="space-y-4 p-1">
          <Input
            label="Track Name"
            placeholder="e.g. Main Stage"
            value={form.name}
            onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
            required
          />
          <Input
            label="Description"
            placeholder="Optional description"
            value={form.description}
            onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
          />
          <Input
            label="YouTube Video ID"
            placeholder="e.g. dQw4w9WgXcQ"
            value={form.youtube_video_id}
            onChange={(e) => setForm(prev => ({ ...prev, youtube_video_id: e.target.value }))}
          />
          {form.youtube_video_id && (
            <div className="aspect-video max-w-sm rounded overflow-hidden border border-[var(--gray-a5)]">
              <iframe
                src={`https://www.youtube.com/embed/${form.youtube_video_id}`}
                className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                title="Preview"
              />
            </div>
          )}
          <Select
            label="Stream Status"
            data={STREAM_STATUS_OPTIONS}
            value={form.stream_status}
            onChange={(e) =>
              setForm(prev => ({ ...prev, stream_status: e.target.value as TrackFormData['stream_status'] }))
            }
          />
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
          <Button color="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving...' : editingTrack ? 'Update Track' : 'Add Track'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
