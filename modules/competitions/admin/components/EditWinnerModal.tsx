import { Fragment, useState, useRef } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { XMarkIcon, PhotoIcon, LinkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { CompetitionWinner, CompetitionWinnerService } from '@/utils/competitionWinnerService';
import { Button } from '@/components/ui';

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
      // Create preview URL
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveImage = async () => {
    if (winner.winner_image_storage_path) {
      // Delete from storage
      await CompetitionWinnerService.deleteWinnerImage(winner.winner_image_storage_path);
    }
    setSelectedImage(null);
    setPreviewUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleStatusChange = (status: 'accepted' | 'declined' | 'not_replied') => {
    // Only one can be checked at a time
    if (status === 'accepted') {
      setStatusAccepted(!statusAccepted);
      if (!statusAccepted) {
        setStatusDeclined(false);
        setStatusNotReplied(false);
      }
    } else if (status === 'declined') {
      setStatusDeclined(!statusDeclined);
      if (!statusDeclined) {
        setStatusAccepted(false);
        setStatusNotReplied(false);
      }
    } else if (status === 'not_replied') {
      setStatusNotReplied(!statusNotReplied);
      if (!statusNotReplied) {
        setStatusAccepted(false);
        setStatusDeclined(false);
      }
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      // Upload image if selected
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

      // Update social post and notes
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

      // Update status if changed
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
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/25 dark:bg-black/50" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-2xl transform overflow-hidden rounded-2xl bg-white dark:bg-gray-800 p-6 text-left align-middle shadow-xl transition-all">
                <div className="flex items-center justify-between mb-6">
                  <Dialog.Title
                    as="h3"
                    className="text-lg font-medium leading-6 text-gray-900 dark:text-white"
                  >
                    Edit Winner Details
                  </Dialog.Title>
                  <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                  >
                    <XMarkIcon className="h-6 w-6" />
                  </button>
                </div>

                {error && (
                  <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                    <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                  </div>
                )}

                <div className="space-y-6">
                  {/* Winner Info */}
                  <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                    <p className="text-sm text-gray-600 dark:text-gray-400">Winner Email</p>
                    <p className="font-medium text-gray-900 dark:text-white">{winner.email}</p>
                  </div>

                  {/* Image Upload */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Winner Image
                    </label>
                    <div className="space-y-3">
                      {previewUrl && (
                        <div className="relative inline-block">
                          <img
                            src={previewUrl}
                            alt="Winner"
                            className="w-48 h-48 object-cover rounded-lg border-2 border-gray-300 dark:border-gray-600"
                          />
                          <button
                            onClick={handleRemoveImage}
                            className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                      <div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handleImageSelect}
                          className="hidden"
                          id="winner-image-upload"
                        />
                        <label
                          htmlFor="winner-image-upload"
                          className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 cursor-pointer"
                        >
                          <PhotoIcon className="h-5 w-5" />
                          {previewUrl ? 'Change Image' : 'Upload Image'}
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Social Post URL */}
                  <div>
                    <label htmlFor="social-post-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Social Media Post
                    </label>
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <select
                          value={socialPostPlatform}
                          onChange={(e) => setSocialPostPlatform(e.target.value)}
                          className="block w-32 rounded-lg border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm focus:border-primary-500 focus:ring-primary-500"
                        >
                          <option value="twitter">Twitter</option>
                          <option value="linkedin">LinkedIn</option>
                          <option value="instagram">Instagram</option>
                          <option value="facebook">Facebook</option>
                          <option value="other">Other</option>
                        </select>
                        <div className="flex-1 relative">
                          <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                          <input
                            type="url"
                            id="social-post-url"
                            value={socialPostUrl}
                            onChange={(e) => setSocialPostUrl(e.target.value)}
                            placeholder="https://twitter.com/..."
                            className="block w-full pl-10 rounded-lg border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm focus:border-primary-500 focus:ring-primary-500"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Winner Status */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Winner Status
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={statusAccepted}
                          onChange={() => handleStatusChange('accepted')}
                          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300">Accepted</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={statusDeclined}
                          onChange={() => handleStatusChange('declined')}
                          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300">Declined</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={statusNotReplied}
                          onChange={() => handleStatusChange('not_replied')}
                          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300">Not Replied</span>
                      </label>
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <label htmlFor="notes" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Notes
                    </label>
                    <textarea
                      id="notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={4}
                      placeholder="Add any notes about the winner or their submission..."
                      className="block w-full rounded-lg border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm focus:border-primary-500 focus:ring-primary-500"
                    />
                  </div>
                </div>

                <div className="mt-6 flex justify-end gap-3">
                  <Button
                    variant="outlined"
                    onClick={onClose}
                    disabled={isSaving || isUploading}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={isSaving || isUploading}
                  >
                    {isUploading ? 'Uploading...' : isSaving ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
