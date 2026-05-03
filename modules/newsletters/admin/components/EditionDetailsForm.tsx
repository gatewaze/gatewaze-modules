import { Card, Button, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import type { NewsletterEdition } from '../utils';

interface CollectionInfo {
  id: string;
  name: string;
  list_id?: string | null;
  list_name?: string | null;
  subscriber_count?: number;
  content_category?: string | null;
  from_name?: string | null;
  from_email?: string | null;
}

interface EditionDetailsFormProps {
  edition: NewsletterEdition;
  collection: CollectionInfo | null;
  onChange: (edition: NewsletterEdition) => void;
  onCollectionChange?: (updates: Partial<CollectionInfo>) => void;
  onSave: () => void;
  isSaving: boolean;
}

export function EditionDetailsForm({ edition, collection, onChange, onCollectionChange, onSave, isSaving }: EditionDetailsFormProps) {
  const inputClass = "w-full px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]";

  const handleSaveCollectionSender = async () => {
    if (!collection) return;
    try {
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({
          from_name: collection.from_name || null,
          from_email: collection.from_email || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', collection.id);
      if (error) throw error;
      toast.success('Sender settings saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save sender settings');
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <Card variant="surface" className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Edition Details</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Email Subject *</label>
            <input
              type="text"
              value={edition.subject || ''}
              onChange={(e) => onChange({ ...edition, subject: e.target.value })}
              className={inputClass}
              placeholder="This week's newsletter..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
              Preheader Text <span className="font-normal text-[var(--gray-9)]">(preview in inbox, max 150)</span>
            </label>
            <input
              type="text"
              value={edition.preheader || ''}
              onChange={(e) => onChange({ ...edition, preheader: e.target.value })}
              className={inputClass}
              placeholder="Preview text shown before opening..."
              maxLength={150}
            />
            <p className="text-xs text-[var(--gray-9)] mt-1">{(edition.preheader || '').length}/150</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Edition Date</label>
              <input
                type="date"
                value={edition.edition_date}
                onChange={(e) => onChange({ ...edition, edition_date: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Status</label>
              <select
                value={(edition as any).status || 'draft'}
                onChange={(e) => onChange({ ...edition, status: e.target.value } as any)}
                className={inputClass}
              >
                <option value="draft">Draft</option>
                <option value="ready">Ready</option>
                <option value="sent">Sent</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      {collection && (
        <Card variant="surface" className="p-6">
          <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Newsletter Type</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--gray-12)]">{collection.name}</span>
              {collection.content_category && (
                <Badge variant="soft" color="blue">{collection.content_category}</Badge>
              )}
            </div>
            {collection.list_name && (
              <div className="text-sm text-[var(--gray-11)]">
                Subscription list: <span className="font-medium">{collection.list_name}</span>
                {collection.subscriber_count != null && (
                  <span className="text-[var(--gray-9)]"> ({collection.subscriber_count} subscribers)</span>
                )}
              </div>
            )}

            <hr className="border-[var(--gray-a5)]" />

            <h3 className="text-sm font-medium text-[var(--gray-12)]">Sender Settings</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--gray-11)] mb-1">From Name</label>
                <input
                  type="text"
                  value={collection.from_name || ''}
                  onChange={(e) => onCollectionChange?.({ from_name: e.target.value })}
                  className={inputClass}
                  placeholder="AAIF Newsletter"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--gray-11)] mb-1">From Email</label>
                <input
                  type="email"
                  value={collection.from_email || ''}
                  onChange={(e) => onCollectionChange?.({ from_email: e.target.value })}
                  className={inputClass}
                  placeholder="newsletter@example.com"
                />
              </div>
            </div>
            <Button variant="outline" size="1" onClick={handleSaveCollectionSender}>
              Save Sender Settings
            </Button>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Button variant="solid" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Details'}
        </Button>
      </div>
    </div>
  );
}
