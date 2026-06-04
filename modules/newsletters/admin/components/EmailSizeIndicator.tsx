import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

/**
 * Gmail clips inbound HTML at ~102KB and shows a "[Message clipped] —
 * View entire message" link. Above the warning threshold operators
 * lose CTAs (unsubscribe footers, tracking pixels at the bottom)
 * because most readers don't click through the clip-link.
 *
 * Render a small badge in editor + HTML-preview chrome so the limit
 * is visible while composing, not just at send time. Two thresholds:
 *   - >= 102KB  → red, "Gmail will clip this email" + explanation
 *   - >= 90KB   → yellow, "Approaching Gmail limit"
 *   - < 90KB    → neutral pill, byte count only
 */

const GMAIL_CLIP_LIMIT_KB = 102;
const WARNING_THRESHOLD_KB = 90;

export interface EmailSizeIndicatorProps {
  /** Raw HTML byte size. Pass `new Blob([html]).size` so UTF-8 is counted. */
  sizeInBytes: number;
  /** Optional block count, rendered on the left as "N blocks". Hidden when undefined. */
  blocksCount?: number;
  /** Optional char count, shown next to the size. */
  charCount?: number;
  /** Layout variant. `inline` is the chrome strip (HtmlPreview footer + editor footer). */
  variant?: 'inline';
  /**
   * Set false to render a `…` placeholder until size has been measured at
   * least once. Useful for the editor view where size computation is
   * debounced — without this the first paint flashes "0.0 KB / Approaching".
   */
  ready?: boolean;
}

export function EmailSizeIndicator({
  sizeInBytes,
  blocksCount,
  charCount,
  ready = true,
}: EmailSizeIndicatorProps) {
  const sizeInKB = sizeInBytes / 1024;
  const isOverLimit = ready && sizeInKB >= GMAIL_CLIP_LIMIT_KB;
  const isNearLimit = ready && sizeInKB >= WARNING_THRESHOLD_KB && !isOverLimit;

  const containerCls = isOverLimit
    ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20'
    : isNearLimit
      ? 'border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20'
      : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50';

  const sizeCls = isOverLimit
    ? 'text-red-600 dark:text-red-400'
    : isNearLimit
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-gray-500 dark:text-gray-400';

  return (
    <div className={`px-4 py-2 border-t ${containerCls}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500 dark:text-gray-400">
          {blocksCount !== undefined
            ? `${blocksCount} block${blocksCount !== 1 ? 's' : ''}`
            : ''}
        </span>

        <div className="flex items-center gap-3">
          {charCount !== undefined && (
            <span className="text-gray-500 dark:text-gray-400">
              {charCount.toLocaleString()} chars
            </span>
          )}

          <span className={`font-medium ${sizeCls}`}>
            {ready ? `${sizeInKB.toFixed(1)} KB` : '…'}
          </span>

          {(isOverLimit || isNearLimit) && (
            <div
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${
                isOverLimit
                  ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                  : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'
              }`}
            >
              <ExclamationTriangleIcon className="w-3.5 h-3.5" />
              <span className="font-medium">
                {isOverLimit
                  ? 'Gmail will clip this email'
                  : 'Approaching Gmail limit'}
              </span>
            </div>
          )}
        </div>
      </div>

      {isOverLimit && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Gmail clips emails over {GMAIL_CLIP_LIMIT_KB}KB. Recipients will see
          &quot;[Message clipped]&quot; with a link to view the full content.
          Consider removing blocks or reducing content to stay under the limit.
        </p>
      )}
    </div>
  );
}
