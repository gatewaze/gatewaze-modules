import { useState } from 'react';
import { XMarkIcon, ArrowUpTrayIcon, DocumentTextIcon, CheckCircleIcon, UserGroupIcon, TicketIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';

// Flexible discount type that works with the new event_discounts table
interface DiscountForModal {
  id: string;       // UUID from event_discounts
  eventId: string;  // event_id (TEXT) for backwards compat
  title: string;
  slug: string;
}

interface DiscountCodesManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  discount: DiscountForModal;
  onSuccess: () => void;
}

type TabType = 'upload' | 'registered' | 'attended' | 'generate';

export function DiscountCodesManagementModal({
  isOpen,
  onClose,
  discount,
  onSuccess,
}: DiscountCodesManagementModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('upload');
  const [codesText, setCodesText] = useState('');
  const [generateCount, setGenerateCount] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    total: number;
    uploaded: number;
    failed: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUploadCodes = async () => {
    if (!codesText.trim()) {
      setError('Please enter discount codes');
      return;
    }

    setIsProcessing(true);
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
        setIsProcessing(false);
        return;
      }

      setUploadProgress({
        total: cleanCodes.length,
        uploaded: 0,
        failed: 0,
      });

      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100
      const batchSize = 100;
      for (let i = 0; i < cleanCodes.length; i += batchSize) {
        const batch = cleanCodes.slice(i, i + batchSize);

        const insertData = batch.map(code => ({
          code: code.trim(),
          event_id: discount.eventId || null,
          discount_id: discount.id,
          issued: false,
          issued_to: null,
          issued_at: null,
        }));

        const { error: insertError } = await supabase
          .from('events_discount_codes')
          .insert(insertData);

        if (insertError) {
          console.error('Failed to upload batch:', insertError);
          failed += batch.length;
        } else {
          uploaded += batch.length;
        }

        setUploadProgress({
          total: cleanCodes.length,
          uploaded,
          failed,
        });
      }

      // Success - close modal and refresh parent
      setTimeout(() => {
        setIsProcessing(false);
        setUploadProgress(null);
        setCodesText('');
        onSuccess();
      }, 1000);
    } catch (err) {
      console.error('Error uploading discount codes:', err);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setIsProcessing(false);
    }
  };

  const handleMarkRegistered = async () => {
    if (!codesText.trim()) {
      setError('Please enter discount codes that have been registered');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setUploadProgress(null);

    try {
      // Parse codes from textarea
      const lines = codesText.split('\n').filter(line => line.trim());

      // Clean and validate codes
      const cleanCodes = lines
        .map(line => line.trim().split(',')[0].trim())
        .filter(code => code.length > 0);

      if (cleanCodes.length === 0) {
        setError('No valid discount codes found');
        setIsProcessing(false);
        return;
      }

      setUploadProgress({
        total: cleanCodes.length,
        uploaded: 0,
        failed: 0,
      });

      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100
      const batchSize = 100;
      for (let i = 0; i < cleanCodes.length; i += batchSize) {
        const batch = cleanCodes.slice(i, i + batchSize);

        for (const code of batch) {
          const { error: updateError } = await supabase
            .from('events_discount_codes')
            .update({
              registered: true,
              registered_at: new Date().toISOString(),
            })
            .eq('discount_id', discount.id)
            .eq('code', code.trim());

          if (updateError) {
            console.error(`Failed to mark code ${code} as registered:`, updateError);
            failed++;
          } else {
            uploaded++;
          }
        }

        setUploadProgress({
          total: cleanCodes.length,
          uploaded,
          failed,
        });
      }

      // Success - show completion
      setTimeout(() => {
        setIsProcessing(false);
        setUploadProgress(null);
        setCodesText('');
        onSuccess();
      }, 1000);
    } catch (err) {
      console.error('Error marking codes as registered:', err);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setIsProcessing(false);
    }
  };

  const handleMarkAttended = async () => {
    if (!codesText.trim()) {
      setError('Please enter discount codes of attendees');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setUploadProgress(null);

    try {
      // Parse codes from textarea
      const lines = codesText.split('\n').filter(line => line.trim());

      // Clean and validate codes
      const cleanCodes = lines
        .map(line => line.trim().split(',')[0].trim())
        .filter(code => code.length > 0);

      if (cleanCodes.length === 0) {
        setError('No valid discount codes found');
        setIsProcessing(false);
        return;
      }

      setUploadProgress({
        total: cleanCodes.length,
        uploaded: 0,
        failed: 0,
      });

      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100
      const batchSize = 100;
      for (let i = 0; i < cleanCodes.length; i += batchSize) {
        const batch = cleanCodes.slice(i, i + batchSize);

        for (const code of batch) {
          // Note: When marking as attended, we also mark as registered if not already
          const { error: updateError } = await supabase
            .from('events_discount_codes')
            .update({
              registered: true,
              registered_at: new Date().toISOString(),
              attended: true,
              attended_at: new Date().toISOString(),
            })
            .eq('discount_id', discount.id)
            .eq('code', code.trim());

          if (updateError) {
            console.error(`Failed to mark code ${code} as attended:`, updateError);
            failed++;
          } else {
            uploaded++;
          }
        }

        setUploadProgress({
          total: cleanCodes.length,
          uploaded,
          failed,
        });
      }

      // Success - show completion
      setTimeout(() => {
        setIsProcessing(false);
        setUploadProgress(null);
        setCodesText('');
        onSuccess();
      }, 1000);
    } catch (err) {
      console.error('Error marking codes as attended:', err);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setIsProcessing(false);
    }
  };

  const handleGenerateNoneCodes = async () => {
    const count = parseInt(generateCount);

    if (!generateCount.trim() || isNaN(count) || count <= 0) {
      setError('Please enter a valid number of codes to generate');
      return;
    }

    if (count > 10000) {
      setError('Maximum 10,000 codes can be generated at once');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setUploadProgress(null);

    try {
      setUploadProgress({
        total: count,
        uploaded: 0,
        failed: 0,
      });

      // Generate unique "none" codes with timestamp and random suffix
      const codes: string[] = [];
      const timestamp = Date.now();

      for (let i = 0; i < count; i++) {
        const codeNumber = String(i + 1).padStart(4, '0');
        const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        codes.push(`NONE-${timestamp}-${codeNumber}-${randomSuffix}`);
      }

      let uploaded = 0;
      let failed = 0;

      // Process codes in batches of 100
      const batchSize = 100;
      for (let i = 0; i < codes.length; i += batchSize) {
        const batch = codes.slice(i, i + batchSize);

        const insertData = batch.map(code => ({
          code: code,
          event_id: discount.eventId || null,
          discount_id: discount.id,
          issued: false,
          issued_to: null,
          issued_at: null,
        }));

        const { error: insertError } = await supabase
          .from('events_discount_codes')
          .insert(insertData);

        if (insertError) {
          console.error('Failed to generate batch:', insertError);
          failed += batch.length;
        } else {
          uploaded += batch.length;
        }

        setUploadProgress({
          total: count,
          uploaded,
          failed,
        });
      }

      // Success - close modal and refresh parent
      setTimeout(() => {
        setIsProcessing(false);
        setUploadProgress(null);
        setGenerateCount('');
        onSuccess();
      }, 1000);
    } catch (err) {
      console.error('Error generating none codes:', err);
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setIsProcessing(false);
    }
  };

  const handleSubmit = () => {
    switch (activeTab) {
      case 'upload':
        handleUploadCodes();
        break;
      case 'registered':
        handleMarkRegistered();
        break;
      case 'attended':
        handleMarkAttended();
        break;
      case 'generate':
        handleGenerateNoneCodes();
        break;
    }
  };

  const handleClose = () => {
    if (!isProcessing) {
      setCodesText('');
      setGenerateCount('');
      setError(null);
      setUploadProgress(null);
      setActiveTab('upload');
      onClose();
    }
  };

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setCodesText('');
    setGenerateCount('');
    setError(null);
    setUploadProgress(null);
  };

  if (!isOpen) return null;

  // Count codes in textarea
  const codeCount = codesText.trim()
    ? codesText.split('\n').filter(line => line.trim()).length
    : 0;

  const getTabContent = () => {
    switch (activeTab) {
      case 'upload':
        return {
          title: 'Upload New Codes',
          instructions: 'Paste one discount code per line. Codes will be automatically trimmed and cleaned.',
          placeholder: 'Paste discount codes here, one per line...',
          buttonText: `Upload ${codeCount > 0 ? codeCount : ''} Code${codeCount !== 1 ? 's' : ''}`,
          icon: <ArrowUpTrayIcon className="size-5" />
        };
      case 'registered':
        return {
          title: 'Mark Codes as Registered',
          instructions: 'Paste discount codes that have been registered for the event. These codes will be marked as registered.',
          placeholder: 'Paste registered discount codes here, one per line...',
          buttonText: `Mark ${codeCount > 0 ? codeCount : ''} as Registered`,
          icon: <CheckCircleIcon className="size-5" />
        };
      case 'attended':
        return {
          title: 'Mark Codes as Attended',
          instructions: 'Paste discount codes of attendees who actually attended the event. These codes will be marked as attended.',
          placeholder: 'Paste attended discount codes here, one per line...',
          buttonText: `Mark ${codeCount > 0 ? codeCount : ''} as Attended`,
          icon: <UserGroupIcon className="size-5" />
        };
      case 'generate':
        return {
          title: 'Generate "None" Codes',
          instructions: 'Generate tracking codes with value "none" to track offer acceptance limits without providing actual discount codes.',
          placeholder: 'Enter number of codes to generate...',
          buttonText: `Generate ${generateCount ? generateCount : ''} Code${generateCount !== '1' ? 's' : ''}`,
          icon: <TicketIcon className="size-5" />
        };
    }
  };

  const tabContent = getTabContent();

  const displayTitle = discount.title || 'Untitled Discount';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={handleClose}>
      <div className="mx-auto max-w-2xl w-full bg-white dark:bg-neutral-800 rounded-lg shadow-xl m-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-white">Manage Discount Codes</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{displayTitle}</p>
          </div>
          <button
            onClick={handleClose}
            disabled={isProcessing}
            className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
          >
            <XMarkIcon className="size-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-neutral-200 dark:border-neutral-700">
          <button
            onClick={() => handleTabChange('upload')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'upload'
                ? 'text-primary-600 border-b-2 border-primary-600 bg-primary-50 dark:bg-primary-900/20'
                : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <ArrowUpTrayIcon className="size-4" />
              Upload Codes
            </div>
          </button>
          <button
            onClick={() => handleTabChange('generate')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'generate'
                ? 'text-primary-600 border-b-2 border-primary-600 bg-primary-50 dark:bg-primary-900/20'
                : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <TicketIcon className="size-4" />
              Generate None
            </div>
          </button>
          <button
            onClick={() => handleTabChange('registered')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'registered'
                ? 'text-primary-600 border-b-2 border-primary-600 bg-primary-50 dark:bg-primary-900/20'
                : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <CheckCircleIcon className="size-4" />
              Mark Registered
            </div>
          </button>
          <button
            onClick={() => handleTabChange('attended')}
            className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'attended'
                ? 'text-primary-600 border-b-2 border-primary-600 bg-primary-50 dark:bg-primary-900/20'
                : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <UserGroupIcon className="size-4" />
              Mark Attended
            </div>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Instructions */}
          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2">
              <DocumentTextIcon className="size-5 text-blue-600 dark:text-blue-400 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-900 dark:text-blue-100">{tabContent.title}</p>
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                  {tabContent.instructions}
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

          {/* Input Field */}
          <div>
            {activeTab === 'generate' ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Number of Codes
                  </label>
                </div>
                <input
                  type="number"
                  value={generateCount}
                  onChange={(e) => setGenerateCount(e.target.value)}
                  disabled={isProcessing}
                  min="1"
                  max="10000"
                  placeholder={tabContent.placeholder}
                  className="block w-full px-4 py-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-neutral-900 dark:text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                  Maximum 10,000 codes can be generated at once
                </p>
              </>
            ) : (
              <>
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
                  disabled={isProcessing}
                  rows={12}
                  placeholder={tabContent.placeholder}
                  className="block w-full px-4 py-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-neutral-900 dark:text-white font-mono text-sm disabled:opacity-50 disabled:cursor-not-allowed resize-none"
                />
              </>
            )}
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
                  Processing...
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
                  {uploadProgress.failed} failed (codes may not exist or already have this status)
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-neutral-200 dark:border-neutral-700">
          <Button
            onClick={handleClose}
            disabled={isProcessing}
            variant="outlined"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={(activeTab === 'generate' ? !generateCount.trim() : !codesText.trim()) || isProcessing}
            className="gap-2"
          >
            {isProcessing ? (
              <>
                {tabContent.icon}
                Processing...
              </>
            ) : (
              <>
                {tabContent.icon}
                {tabContent.buttonText}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
