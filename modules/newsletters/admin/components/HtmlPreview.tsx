import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  DocumentDuplicateIcon,
  CheckIcon,
  PaperAirplaneIcon,
  XMarkIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { Card, Button, Badge } from '@/components/ui';
import { getNewsletterConfig } from '@/config/brands';
import { toast } from 'sonner';
import {
  generateNewsletterHtml,
  OutputFormat,
  type NewsletterEdition,
  getEditionLinks,
  type GeneratedLink,
  getFullShortUrl,
} from '../utils';
import { supabase } from '@/lib/supabase';
import { useHasModule } from '@/hooks/useModuleFeature';
import { getSupabaseConfig } from '@/config/brands';

interface HtmlPreviewProps {
  edition: NewsletterEdition;
  redirectsReady?: boolean;
  generatedLinks?: GeneratedLink[];
}

const FORMAT_OPTIONS: { id: OutputFormat; label: string; description: string }[] = [
  {
    id: 'customerio',
    label: 'Customer.io',
    description: 'Full HTML with table layout and inline styles',
  },
  {
    id: 'substack',
    label: 'Substack',
    description: 'Simplified HTML for rich text paste',
  },
  {
    id: 'beehiiv',
    label: 'Beehiiv',
    description: 'Simplified HTML for rich text paste',
  },
];

/**
 * Replace original URLs in HTML with short URLs
 * This does a simple string replacement of URLs in the final HTML
 */
function replaceUrlsInHtml(
  html: string,
  links: GeneratedLink[],
  channel: OutputFormat
): string {
  let result = html;

  // Filter links for the selected channel
  const channelLinks = links.filter(link => link.distributionChannel === channel);

  // Create a map of original URL -> short URL
  // Sort by URL length descending to replace longer URLs first (prevents partial replacements)
  const sortedLinks = [...channelLinks].sort(
    (a, b) => b.originalUrl.length - a.originalUrl.length
  );

  for (const link of sortedLinks) {
    const shortUrl = getFullShortUrl(link.shortPath);
    // Replace all occurrences of the original URL with the short URL
    // Use a simple string replace - the URL should appear in href attributes
    result = result.split(link.originalUrl).join(shortUrl);
  }

  return result;
}

export function HtmlPreview({ edition, redirectsReady = false, generatedLinks = [] }: HtmlPreviewProps) {
  const hasCIO = useHasModule('customerio');
  const availableFormats = useMemo(
    () => FORMAT_OPTIONS.filter(f => f.id !== 'customerio' || hasCIO),
    [hasCIO],
  );
  const [selectedFormat, setSelectedFormat] = useState<OutputFormat>(hasCIO ? 'customerio' : 'substack');
  const [copied, setCopied] = useState(false);
  const [showTestSendModal, setShowTestSendModal] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [editionLinks, setEditionLinks] = useState<GeneratedLink[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Fetch edition links when edition changes
  const fetchEditionLinks = useCallback(async () => {
    if (edition.id === 'new') {
      setEditionLinks([]);
      return;
    }

    try {
      const links = await getEditionLinks(edition.id);
      setEditionLinks(links);
    } catch (error) {
      console.error('Error fetching edition links:', error);
      setEditionLinks([]);
    }
  }, [edition.id]);

  // Fetch links on mount and when edition ID changes
  useEffect(() => {
    fetchEditionLinks();
  }, [fetchEditionLinks]);

  // Also refetch when redirectsReady changes to true (links were just generated)
  useEffect(() => {
    if (redirectsReady) {
      fetchEditionLinks();
    }
  }, [redirectsReady, fetchEditionLinks]);

  // Generate HTML for selected format with short links applied
  // Prefer in-memory generatedLinks (passed as prop) over DB-fetched editionLinks,
  // since the DB save may silently fail
  const html = useMemo(() => {
    try {
      const activeLinks = generatedLinks.length > 0 ? generatedLinks : editionLinks;

      // First generate the base HTML
      let generatedHtml = generateNewsletterHtml(edition, selectedFormat);

      // If we have links, replace URLs with short links for the selected format
      if (activeLinks.length > 0) {
        generatedHtml = replaceUrlsInHtml(generatedHtml, activeLinks, selectedFormat);
      }

      return generatedHtml;
    } catch (err) {
      console.error('Error generating HTML:', err);
      return '<p>Error generating preview</p>';
    }
  }, [edition, selectedFormat, generatedLinks, editionLinks]);

  // Update iframe content without replacing the iframe element
  // This prevents scroll position reset that happens when srcDoc changes
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe && iframe.contentDocument) {
      iframe.contentDocument.open();
      iframe.contentDocument.write(html);
      iframe.contentDocument.close();
    }
  }, [html]);

  const handleCopy = async () => {
    try {
      // For Substack/Beehiiv, copy as rich text so it can be pasted into their editors
      if (selectedFormat === 'substack' || selectedFormat === 'beehiiv') {
        // Use the Clipboard API to write HTML as rich text
        const blob = new Blob([html], { type: 'text/html' });
        const clipboardItem = new ClipboardItem({
          'text/html': blob,
          'text/plain': new Blob([html], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([clipboardItem]);
        setCopied(true);
        toast.success('Rich text copied - paste into your editor');
      } else {
        // For Customer.io, copy the raw HTML code
        await navigator.clipboard.writeText(html);
        setCopied(true);
        toast.success('HTML copied to clipboard');
      }
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleTestSend = async () => {
    if (!testEmail || !testEmail.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }

    try {
      setSending(true);
      const { url } = getSupabaseConfig();

      // Get the session for auth
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('You must be logged in to send test emails');
        return;
      }

      const response = await fetch(`${url}/functions/v1/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          to: testEmail,
          from: getNewsletterConfig().fromEmail,
          fromName: getNewsletterConfig().fromName,
          subject: `[TEST] ${edition.title}`,
          html: html,
          text: `This is a test email for: ${edition.title}. Please view in HTML.`,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to send test email');
      }

      toast.success(`Test email sent to ${testEmail}`);
      setShowTestSendModal(false);
      setTestEmail('');
    } catch (error) {
      console.error('Error sending test email:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to send test email');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Preview
          </h3>
          <div className="flex items-center gap-2">
            <div className="relative group">
              <Button
                onClick={handleCopy}
                disabled={!redirectsReady}
                className="gap-1 text-sm px-3 py-1.5"
              >
                {copied ? (
                  <CheckIcon className="w-4 h-4" />
                ) : (
                  <DocumentDuplicateIcon className="w-4 h-4" />
                )}
                {copied ? 'Copied!' : (selectedFormat === 'customerio' ? 'Copy HTML' : 'Copy Rich Text')}
              </Button>
              {!redirectsReady && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 dark:bg-gray-700 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  Update redirects first
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-900 dark:border-b-gray-700" />
                </div>
              )}
            </div>
            <div className="relative group">
              <Button
                variant="outlined"
                onClick={() => setShowTestSendModal(true)}
                disabled={!redirectsReady}
                className="gap-1 text-sm px-3 py-1.5"
              >
                <PaperAirplaneIcon className="w-4 h-4" />
                Test Send
              </Button>
              {!redirectsReady && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 dark:bg-gray-700 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  Update redirects first
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-900 dark:border-b-gray-700" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Test Send Modal */}
        {showTestSendModal && (
          <div className="mb-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
                Send Test Email
              </span>
              <button
                onClick={() => setShowTestSendModal(false)}
                className="text-blue-500 hover:text-blue-700"
              >
                <XMarkIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="Enter email address..."
                className="flex-1 px-3 py-1.5 text-sm border border-blue-300 dark:border-blue-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                onKeyDown={(e) => e.key === 'Enter' && handleTestSend()}
              />
              <Button
                onClick={handleTestSend}
                disabled={sending || !testEmail}
                className="gap-1 text-sm px-3 py-1.5"
              >
                {sending ? 'Sending...' : 'Send'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-blue-700 dark:text-blue-300">
              Sends the {selectedFormat === 'customerio' ? 'Customer.io' : selectedFormat} format to the specified email
            </p>
          </div>
        )}

        {/* Format Selector */}
        <div className="flex gap-2">
          {availableFormats.map((format) => (
            <button
              key={format.id}
              onClick={() => setSelectedFormat(format.id)}
              className={`
                flex-1 p-2 rounded-lg border text-left transition-all
                ${selectedFormat === format.id
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }
              `}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-white">
                  {format.label}
                </span>
                {selectedFormat === format.id && (
                  <Badge color="primary" size="sm">Active</Badge>
                )}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {format.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Preview Content */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-auto bg-gray-100 dark:bg-gray-800 p-4">
          <div className="max-w-[650px] mx-auto bg-white shadow-lg">
            <iframe
              ref={iframeRef}
              title="Newsletter Preview"
              className="w-full h-full min-h-[800px] border-0"
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        </div>
      </div>

      {/* Footer with stats and Gmail clipping warning */}
      {(() => {
        // Calculate email size in KB (using UTF-8 byte size for accuracy)
        const sizeInBytes = new Blob([html]).size;
        const sizeInKB = sizeInBytes / 1024;
        const GMAIL_CLIP_LIMIT = 102; // Gmail clips at 102KB
        const WARNING_THRESHOLD = 90; // Warn at 90KB (88% of limit)

        const isOverLimit = sizeInKB >= GMAIL_CLIP_LIMIT;
        const isNearLimit = sizeInKB >= WARNING_THRESHOLD && !isOverLimit;

        return (
          <div className={`px-4 py-2 border-t ${
            isOverLimit
              ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20'
              : isNearLimit
                ? 'border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20'
                : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50'
          }`}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500 dark:text-gray-400">
                {edition.blocks.length} block{edition.blocks.length !== 1 ? 's' : ''}
              </span>

              <div className="flex items-center gap-3">
                <span className="text-gray-500 dark:text-gray-400">
                  {html.length.toLocaleString()} chars
                </span>

                <span className={`font-medium ${
                  isOverLimit
                    ? 'text-red-600 dark:text-red-400'
                    : isNearLimit
                      ? 'text-yellow-600 dark:text-yellow-400'
                      : 'text-gray-500 dark:text-gray-400'
                }`}>
                  {sizeInKB.toFixed(1)} KB
                </span>

                {(isOverLimit || isNearLimit) && (
                  <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${
                    isOverLimit
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                      : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300'
                  }`}>
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
                Gmail clips emails over 102KB. Recipients will see "[Message clipped]" with a link to view the full content.
                Consider removing blocks or reducing content to stay under the limit.
              </p>
            )}
          </div>
        );
      })()}
    </Card>
  );
}

export default HtmlPreview;
