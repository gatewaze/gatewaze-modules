import { useState } from 'react';
import { Upload, Loader2, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { toStoragePath } from '@gatewaze/shared';

interface Props {
  /**
   * The calendar's stable id, used as the file-path prefix so a re-upload
   * overwrites the previous cover instead of leaving orphaned blobs.
   */
  calendarId: string;
  label?: string;
  description?: string;
  /** Current persisted value — relative storage path or legacy full URL. */
  value: string | null | undefined;
  onChange: (next: string) => void;
}

/**
 * Cover-image upload field for the calendar settings page.
 *
 * Mirrors the pattern in @/components/shared/branding/LogoUploadField but
 * uses a calendar-scoped path (`calendars/{calendarId}-cover.{ext}`) and
 * renders a 16:9 preview suitable for a hero background. Upserts so a
 * fresh upload simply overwrites the existing object.
 *
 * Persists the relative storage path; the portal resolves it to a full
 * URL via `toPublicUrl(path, brandConfig.storageBucketUrl)` at render time.
 */
export function CalendarCoverUploadField({
  calendarId,
  label = 'Hero cover image',
  description = 'Used as the background behind the calendar name on the public page. Wide, photographic images work best (recommended 1600×600 or larger).',
  value,
  onChange,
}: Props) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const displayUrl = (() => {
    if (!value) return '';
    if (/^https?:\/\//.test(value)) return value;
    const { data } = supabase.storage.from('media').getPublicUrl(value);
    return data.publicUrl;
  })();

  const normalizedInput = toStoragePath(value) ?? value ?? '';

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const filePath = `calendars/${calendarId}-cover.${ext}`;
      const { error } = await supabase.storage
        .from('media')
        .upload(filePath, file, { upsert: true, cacheControl: '3600' });
      if (error) throw error;
      onChange(filePath);
    } catch (err: any) {
      console.error('[calendar-cover-upload] failed:', err);
      setUploadError(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
      // Reset the input so re-selecting the same file fires onChange.
      e.target.value = '';
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
      </label>
      <p className="text-xs text-gray-500 mb-3">{description}</p>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative w-full sm:w-72 aspect-[16/9] rounded-lg border border-dashed border-gray-300 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-neutral-900 flex items-center justify-center">
          {value ? (
            <img
              src={displayUrl}
              alt="Calendar cover"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center text-gray-400 text-xs">
              <ImageIcon className="w-6 h-6 mb-1" />
              No cover yet
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Button variant="outlined" size="sm" disabled={uploading} asChild>
            <label className="cursor-pointer inline-flex items-center">
              {uploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {uploading ? 'Uploading…' : value ? 'Replace image' : 'Upload image'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleUpload}
              />
            </label>
          </Button>
          {value && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange('')}
              disabled={uploading}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      {uploadError && (
        <p className="mt-2 text-xs text-red-500">{uploadError}</p>
      )}

      {value && (
        <input
          value={normalizedInput}
          onChange={(e) => onChange(e.target.value)}
          placeholder="calendars/CAL-XXX-cover.jpg"
          className="mt-3 w-full rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-300"
        />
      )}
    </div>
  );
}
