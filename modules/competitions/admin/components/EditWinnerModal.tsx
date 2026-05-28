import { useState, useRef } from 'react';
import { PhotoIcon, LinkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { CompetitionWinner, CompetitionWinnerService } from '@/utils/competitionWinnerService';
import { Modal, Button } from '@/components/ui';

interface EditWinnerModalProps {
  isOpen: boolean;
  onClose: () => void;
  winner: CompetitionWinner;
  onSuccess: () => void;
}

export function EditWinnerModal({ isOpen, onClose, winner, onSuccess }: EditWinnerModalProps) {
  const [socialPostUrl, setSocialPostUrl] = useState(winner.social_post_url || '');
  const [socialPostPlatform, setSocialPostPlatform] = useState(winner.social_post_platform || 'twitter');
  const [notes, setNotes] = useState(winner.notes || '');
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(winner.winner_image_url || null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [statusAccepted, setStatusAccepted] = useState(!!winner.accepted_at);
  const [statusDeclined, setStatusDeclined] = useState(!!winner.declined_at);
  const [statusNotReplied, setStatusNotReplied] = useState(!!winner.not_replied_at);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedImage(file);
      const reader = new FileReader();
      reader.onloadend = () => setPreviewUrl(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveImage = async () => {
    if (winner.winner_image_storage_path) {
      await CompetitionWinnerService.deleteWinnerImage(winner.winner_image_storage_path);
    }
    setSelectedImage(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleStatusChange = (status: 'accepted' | 'declined' | 'not_replied') => {
    if (status === 'accepted') {
      setStatusAccepted(!statusAccepted);
      if (!statusAccepted) { setStatusDeclined(false); setStatusNotReplied(false); }
    } else if (status === 'declined') {
      setStatusDeclined(!statusDeclined);
      if (!statusDeclined) { setStatusAccepted(false); setStatusNotReplied(false); }
    } else if (status === 'not_replied') {
      setStatusNotReplied(!statusNotReplied);
      if (!statusNotReplied) { setStatusAccepted(false); setStatusDeclined(false); }
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      if (selectedImage && winner.id) {
        setIsUploading(true);
        const uploadResult = await CompetitionWinnerService.uploadWinnerImage(winner.id, selectedImage);
        setIsUploading(false);
        if (!uploadResult.success) {
          setError(uploadResult.error || 'Failed to upload image');
          setIsSaving(false);
          return;
        }
      }

      if (winner.id) {
        const updateResult = await CompetitionWinnerService.updateWinnerMedia(winner.id, {
          social_post_url: socialPostUrl || undefined,
          social_post_platform: socialPostPlatform || undefined,
          notes: notes || undefined,
        });
        if (!updateResult.success) {
          setError(updateResult.error || 'Failed to update winner');
          setIsSaving(false);
          return;
        }
      }

      if (winner.id && winner.email) {
        if (statusAccepted && !winner.accepted_at) {
          await CompetitionWinnerService.markWinnerAccepted(winner.email, winner.event_id);
        } else if (statusDeclined && !winner.declined_at) {
          await CompetitionWinnerService.markWinnerDeclined(winner.email, winner.event_id);
        } else if (statusNotReplied && !winner.not_replied_at) {
          await CompetitionWinnerService.markWinnerNotReplied(winner.email, winner.event_id);
        }
      }

      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Winner Details"
      size="lg"
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSaving || isUploading}>Cancel</Button>
          <Button variant="solid" onClick={handleSave} disabled={isSaving || isUploading}>
            {isUploading ? 'Uploading...' : isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      }
    >
      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      <div className="space-y-6">
        {/* Winner Info */}
        <div className="bg-[var(--gray-a2)] p-4 rounded-lg">
          <p className="text-sm text-[var(--gray-9)]">Winner Email</p>
          <p className="font-medium text-[var(--gray-12)]">{winner.email}</p>
        </div>

        {/* Image Upload */}
        <div>
          <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">Winner Image</label>
          <div className="space-y-3">
            {previewUrl && (
              <div className="relative inline-block">
                <img src={previewUrl} alt="Winner" className="w-48 h-48 object-cover rounded-lg border-2 border-[var(--gray-a6)]" />
                <button onClick={handleRemoveImage} className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600">
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            )}
            <div>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} className="hidden" id="winner-image-upload" />
              <label htmlFor="winner-image-upload" className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--gray-a6)] rounded-lg text-sm font-medium text-[var(--gray-11)] bg-[var(--color-surface)] hover:bg-[var(--gray-a3)] cursor-pointer">
                <PhotoIcon className="h-5 w-5" />
                {previewUrl ? 'Change Image' : 'Upload Image'}
              </label>
            </div>
          </div>
        </div>

        {/* Social Post URL */}
        <div>
          <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">Social Media Post</label>
          <div className="flex gap-2">
            <select value={socialPostPlatform} onChange={(e) => setSocialPostPlatform(e.target.value)}
              className="block w-32 rounded-lg border border-[var(--gray-a6)] bg-[var(--color-surface)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]">
              <option value="twitter">Twitter</option>
              <option value="linkedin">LinkedIn</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
              <option value="other">Other</option>
            </select>
            <div className="flex-1 relative">
              <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-9)]" />
              <input type="url" value={socialPostUrl} onChange={(e) => setSocialPostUrl(e.target.value)} placeholder="https://twitter.com/..."
                className="block w-full pl-10 rounded-lg border border-[var(--gray-a6)] bg-[var(--color-surface)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]" />
            </div>
          </div>
        </div>

        {/* Winner Status */}
        <div>
          <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">Winner Status</label>
          <div className="space-y-2">
            {(['accepted', 'declined', 'not_replied'] as const).map((status) => (
              <label key={status} className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
                <input type="checkbox"
                  checked={status === 'accepted' ? statusAccepted : status === 'declined' ? statusDeclined : statusNotReplied}
                  onChange={() => handleStatusChange(status)}
                  className="rounded" />
                {status === 'not_replied' ? 'Not Replied' : status.charAt(0).toUpperCase() + status.slice(1)}
              </label>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-[var(--gray-11)] mb-2">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
            placeholder="Add any notes about the winner or their submission..."
            className="block w-full rounded-lg border border-[var(--gray-a6)] bg-[var(--color-surface)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]" />
        </div>
      </div>
    </Modal>
  );
}
