import { useState } from 'react';
import { toast } from 'sonner';
import { XMarkIcon, TagIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { EventSponsor, tagMediaWithSponsor, untagMediaFromSponsor } from '../utils/eventMediaService';
import { supabase } from '@/lib/supabase';

interface TagSponsorsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  sponsors: EventSponsor[];
  selectedMediaIds: string[];
}

export function TagSponsorsModal({
  isOpen,
  onClose,
  onSuccess,
  sponsors,
  selectedMediaIds,
}: TagSponsorsModalProps) {
  const [selectedSponsorId, setSelectedSponsorId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleTag = async () => {
    if (!selectedSponsorId) {
      toast.error('Please select a sponsor');
      return;
    }

    setSaving(true);
    try {
      // Tag each selected media with the sponsor
      const promises = selectedMediaIds.map(mediaId =>
        supabase
          .from('events_media_sponsor_tags')
          .upsert(
            { media_id: mediaId, event_sponsor_id: selectedSponsorId },
            { onConflict: 'media_id,event_sponsor_id' }
          )
      );

      await Promise.all(promises);
      toast.success(`Tagged ${selectedMediaIds.length} item(s) with sponsor`);
      onSuccess();
    } catch (error) {
      console.error('Error tagging media:', error);
      toast.error('Failed to tag media');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Tag with Sponsor
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          Tag {selectedMediaIds.length} selected item(s) with a sponsor.
        </p>

        {sponsors.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No sponsors available for this event.</p>
        ) : (
          <div className="mb-6 space-y-2">
            {sponsors.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedSponsorId(s.id)}
                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${
                  selectedSponsorId === s.id
                    ? 'border-primary-500 bg-primary-50 dark:border-primary-400 dark:bg-primary-900/20'
                    : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'
                }`}
              >
                {s.sponsor?.logo_url ? (
                  <img src={s.sponsor.logo_url} alt={s.sponsor.name} className="h-8 w-8 rounded object-contain" />
                ) : (
                  <TagIcon className="h-8 w-8 text-gray-400" />
                )}
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {s.sponsor?.name || 'Unknown Sponsor'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleTag}
            disabled={!selectedSponsorId || saving}
          >
            {saving ? 'Tagging...' : 'Tag Selected'}
          </Button>
        </div>
      </div>
    </div>
  );
}
