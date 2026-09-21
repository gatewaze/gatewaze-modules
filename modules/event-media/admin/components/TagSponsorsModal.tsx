import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Modal } from '@/components/ui';
import { tagMediaWithSponsors, type EventSponsorOption } from '../utils/mediaOrganizerService';

interface TagSponsorsModalProps {
  sponsors: EventSponsorOption[];
  selectedMediaIds: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function TagSponsorsModal({ sponsors, selectedMediaIds, onClose, onSuccess }: TagSponsorsModalProps) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    if (chosen.length === 0) return;
    setSaving(true);
    try {
      await tagMediaWithSponsors(selectedMediaIds, chosen);
      toast.success(`Tagged ${selectedMediaIds.length} item(s) with ${chosen.length} sponsor(s)`);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to tag sponsors');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Tag sponsors"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || chosen.length === 0}>{saving ? 'Tagging…' : 'Tag sponsors'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--gray-a11)]">
          Choose the sponsors that appear in the {selectedMediaIds.length} selected item(s):
        </p>
        {sponsors.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--gray-a10)]">
            This event has no active sponsors. Add them on the Sponsors tab first.
          </p>
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {sponsors.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--gray-a5)] p-3 hover:bg-[var(--gray-a2)]"
              >
                <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} className="h-4 w-4" />
                {s.logoUrl && <img src={s.logoUrl} alt="" className="h-10 w-10 rounded object-contain" />}
                <div className="flex-1">
                  <div className="font-medium">{s.name}</div>
                  <div className="flex items-center gap-2 text-xs text-[var(--gray-a10)]">
                    {s.tier && <span className="capitalize">{s.tier}</span>}
                    {s.boothNumber && <span>Booth {s.boothNumber}</span>}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
