import { useState } from 'react';
import { ArrowUpTrayIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import { Modal, Button } from '@/components/ui';
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
      const lines = codesText.split('\n').filter(line => line.trim());
      const cleanCodes = lines
        .map(line => line.trim().split(',')[0].trim())
        .filter(code => code.length > 0);

      if (cleanCodes.length === 0) {
        setError('No valid discount codes found');
        setIsUploading(false);
        return;
      }

      setUploadProgress({ total: cleanCodes.length, uploaded: 0, failed: 0 });

      const result = await DiscountService.uploadDiscountCodes(
        discount.eventId,
        cleanCodes,
        (progress) => setUploadProgress(progress)
      );

      if (result.success) {
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

  const codeCount = codesText.trim()
    ? codesText.split('\n').filter(line => line.trim()).length
    : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Upload Discount Codes"
      size="lg"
      footer={
        <div className="flex justify-end gap-3">
          <Button onClick={handleClose} disabled={isUploading} variant="outline">Cancel</Button>
          <Button onClick={handleUpload} disabled={!codesText.trim() || isUploading} variant="solid">
            {isUploading ? (
              <><ArrowUpTrayIcon className="size-5 animate-pulse mr-1" /> Uploading...</>
            ) : (
              <><ArrowUpTrayIcon className="size-5 mr-1" /> Upload {codeCount > 0 ? codeCount : ''} Code{codeCount !== 1 ? 's' : ''}</>
            )}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-[var(--gray-9)] mb-4">{discount.eventTitle}</p>

      {/* Instructions */}
      <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 mb-4">
        <div className="flex items-start gap-2">
          <DocumentTextIcon className="size-5 text-blue-600 dark:text-blue-400 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-blue-900 dark:text-blue-100">Paste Discount Codes</p>
            <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
              Paste one discount code per line. Codes will be automatically trimmed and cleaned.
            </p>
          </div>
        </div>
      </div>

      {/* Textarea Input */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-[var(--gray-11)]">Discount Codes</label>
          {codeCount > 0 && (
            <span className="text-xs text-[var(--gray-9)]">{codeCount} code{codeCount !== 1 ? 's' : ''}</span>
          )}
        </div>
        <textarea
          value={codesText}
          onChange={(e) => setCodesText(e.target.value)}
          disabled={isUploading}
          rows={10}
          placeholder="Paste discount codes here, one per line..."
          className="block w-full px-4 py-3 border border-[var(--gray-a6)] bg-[var(--color-surface)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)] font-mono text-sm disabled:opacity-50 resize-none"
        />
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {uploadProgress && (
        <div className="mt-4 p-4 bg-[var(--gray-a2)] rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-[var(--gray-11)]">Uploading...</span>
            <span className="text-sm text-[var(--gray-9)]">{uploadProgress.uploaded} / {uploadProgress.total}</span>
          </div>
          <div className="w-full bg-[var(--gray-a4)] rounded-full h-2">
            <div className="bg-[var(--accent-9)] h-2 rounded-full transition-all duration-300" style={{ width: `${(uploadProgress.uploaded / uploadProgress.total) * 100}%` }} />
          </div>
          {uploadProgress.failed > 0 && (
            <p className="text-xs text-red-600 mt-2">{uploadProgress.failed} failed</p>
          )}
        </div>
      )}
    </Modal>
  );
}
