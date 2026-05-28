import { useState, useEffect } from 'react';

/**
 * Hook to look up the custom domain URL for a content item.
 * Returns the custom domain URL (e.g., https://example.com) if one is
 * configured and active, or null if not.
 *
 * Usage:
 *   const customDomainUrl = useCustomDomainUrl('events', eventId);
 *   const rsvpLink = `${customDomainUrl || portalUrl}/i/${shortCode}`;
 */
export function useCustomDomainUrl(contentType: string, contentId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!contentType || !contentId) {
      setUrl(null);
      return;
    }

    const apiUrl = import.meta.env.VITE_API_URL || '';
    fetch(`${apiUrl}/api/modules/custom-domains/lookup/${contentType}/${contentId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        setUrl(data?.url || null);
      })
      .catch(() => {
        // Custom domains module may not be enabled — silently ignore
        setUrl(null);
      });
  }, [contentType, contentId]);

  return url;
}

export default useCustomDomainUrl;
