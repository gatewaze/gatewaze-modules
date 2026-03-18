import { useState } from 'react';
import { XMarkIcon, ArrowUpTrayIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { Event } from '@/utils/eventService';
import { ActiveDiscountService as DiscountService } from '@/utils/serviceSwitcher';

interface UploadDiscountCodesModalProps {
  isOpen: boolean;
  onClose: () => void;
  discount: Event;
  onSuccess: () => void;
}

export function UploadDiscountCodesModal({
  isOpen,
  onClose,
  discount,
  onSuccess,
}: UploadDiscountCodesModalProps) {
  const [codesText, setCodesText] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    total: number;
    uploaded: number;
    failed: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async () => {
    if (!codesText.trim()) {
      setError('Please enter discount codes');
      return;
    }

    setIsUploading(true);
    setError(null);
    setUploadProgress(null);

    try {
      // Parse codes from textarea
      const lines = codesText.split('\n').filter(line => line.trim());

      // Clean and validate codes
      const cleanCodes = lines
        .map(line => line.trim().split(',')[0].trim()) // Get first column if comma-separated
        .filter(code => code.length > 0);

      if (cleanCodes.length === 0) {
        setError('No valid discount codes found');
        setIsUploading(false);
        return;
      }

      setUploadProgress({
        total: cleanCodes.length,
        uploaded: 0,
        failed: 0,
      });

      // Upload codes using the service
      const result = await DiscountService.uploadDiscountCodes(
        discount.eventId,
        cleanCodes,
        (progress) => {
          setUploadProgress(progress);
        }
      );

      if (result.success) {
        // Success - close modal and refresh parent
        setTimeout(() => {
          setIsUploading(false);
          setUploadProgress(null);
          setCodesText('');
          onSuccess();
          onClose();
        }, 1000);
      } else {
        setError(result.error || 'Failed to upload discount codes');
        setIsUploading(false);
      }
    } catch (err) {
      console.error('Error uploading discount codes:', err);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    if (!isUploading) {
      setCodesText('');
      setError(null);
      setUploadProgress(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  // Count codes in textarea
  const codeCount = codesText.trim()
    ? codesText.split('\n').filter(line => line.trim()).length
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={handleClose}>
      <div className="mx-auto max-w-2xl w-full bg-white dark:bg-neutral-800 rounded-lg shadow-xl m-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-white">Upload Discount Codes</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{discount.eventTitle}</p>
          </div>
          <button
            onClick={handleClose}
            disabled={isUploading}
            className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
          >
            <XMarkIcon className="size-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Instructions */}
          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2">
              <DocumentTextIcon className="size-5 text-blue-600 dark:text-blue-400 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-900 dark:text-blue-100">Paste Discount Codes</p>
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                  Paste one discount code per line. Codes will be automatically trimmed and cleaned.
                </p>
                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 font-mono">
                  Example:<br />
                  CODE1<br />
                  CODE2<br />
                  CODE3
                </p>
              </div>
            </div>
          </div>

          {/* Textarea Input */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Discount Codes
              </label>
              {codeCount > 0 && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {codeCount} code{codeCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <textarea
              value={codesText}
              onChange={(e) => setCodesText(e.target.value)}
              disabled={isUploading}
              rows={12}
              placeholder="Paste discount codes here, one per line..."
              className="block w-full px-4 py-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-neutral-900 dark:text-white font-mono text-sm disabled:opacity-50 disabled:cursor-not-allowed resize-none"
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          {/* Upload Progress */}
          {uploadProgress && (
            <div className="p-4 bg-neutral-50 dark:bg-neutral-900 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  Uploading...
                </span>
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
                  {uploadProgress.uploaded} / {uploadProgress.total}
                </span>
              </div>
              <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2">
                <div
                  className="bg-primary-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(uploadProgress.uploaded / uploadProgress.total) * 100}%` }}
                />
              </div>
              {uploadProgress.failed > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                  {uploadProgress.failed} failed
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-neutral-200 dark:border-neutral-700">
          <Button
            onClick={handleClose}
            disabled={isUploading}
            variant="outlined"
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!codesText.trim() || isUploading}
            className="gap-2"
          >
            {isUploading ? (
              <>
                <ArrowUpTrayIcon className="size-5 animate-pulse" />
                Uploading...
              </>
            ) : (
              <>
                <ArrowUpTrayIcon className="size-5" />
                Upload {codeCount > 0 ? codeCount : ''} Code{codeCount !== 1 ? 's' : ''}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
