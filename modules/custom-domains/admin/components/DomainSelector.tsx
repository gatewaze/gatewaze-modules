import { useState, useEffect, useCallback } from 'react';
import {
  GlobeAltIcon,
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

interface AvailableDomain {
  id: string;
  domain: string;
  status: string;
}

interface AssignedDomain {
  id: string;
  domain: string;
  status: string;
  content_type: string;
  content_id: string;
  content_slug: string | null;
}

interface DomainSelectorProps {
  contentType: string;
  contentId: string;
  contentSlug?: string;
  /** URL or route to the domain registry page, for the "Manage Domains" link */
  registryUrl?: string;
  /** Callback when assignment changes */
  onChange?: () => void;
}

const API_BASE = '/api/modules/custom-domains';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed (${res.status})`);
  }

  return res.json();
}

export default function DomainSelector({
  contentType,
  contentId,
  contentSlug,
  registryUrl = '/settings/domains',
  onChange,
}: DomainSelectorProps) {
  const [availableDomains, setAvailableDomains] = useState<AvailableDomain[]>([]);
  const [currentDomain, setCurrentDomain] = useState<AssignedDomain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDomainId, setSelectedDomainId] = useState('');
  const [assigning, setAssigning] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);

      // Fetch all domains to find current assignment and available ones
      const allDomains = await apiFetch<AssignedDomain[]>('/');

      // Find domain currently assigned to this content
      const assigned = allDomains.find(
        (d) => d.content_type === contentType && d.content_id === contentId
      );
      setCurrentDomain(assigned || null);

      // Also fetch available (active + unassigned) domains
      const available = await apiFetch<AvailableDomain[]>('/available');
      setAvailableDomains(available);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [contentType, contentId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAssign = async () => {
    if (!selectedDomainId) return;
    setAssigning(true);
    setError(null);
    try {
      await apiFetch(`/${selectedDomainId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          content_type: contentType,
          content_id: contentId,
          content_slug: contentSlug || null,
        }),
      });
      setSelectedDomainId('');
      await fetchData();
      onChange?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async () => {
    if (!currentDomain) return;
    setAssigning(true);
    setError(null);
    try {
      await apiFetch(`/${currentDomain.id}/assign`, { method: 'DELETE' });
      await fetchData();
      onChange?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <LoadingSpinner size="xs" />
        <span className="text-sm text-[var(--gray-a9)]">Loading domains...</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GlobeAltIcon className="size-4 text-[var(--gray-a9)]" />
          <span className="text-sm font-medium text-[var(--gray-12)]">Custom Domain</span>
        </div>
        <a
          href={registryUrl}
          className="text-xs text-[var(--accent-11)] hover:underline flex items-center gap-1"
        >
          Manage Domains
          <ArrowTopRightOnSquareIcon className="size-3" />
        </a>
      </div>

      {error && (
        <p className="text-xs text-[var(--red-11)]">{error}</p>
      )}

      {currentDomain ? (
        <div className="flex items-center justify-between rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-[var(--gray-12)]">{currentDomain.domain}</span>
            <Badge
              color={currentDomain.status === 'active' ? 'green' : 'blue'}
              variant="soft"
              size="1"
            >
              {currentDomain.status}
            </Badge>
          </div>
          <Button
            isIcon
            variant="ghost"
            size="sm"
            onClick={handleUnassign}
            disabled={assigning}
            title="Unassign domain"
          >
            <XMarkIcon className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={selectedDomainId}
            onChange={(e) => setSelectedDomainId(e.target.value)}
            className="flex-1 px-3 py-2 rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] text-[var(--gray-12)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-a7)]"
            disabled={assigning}
          >
            <option value="">
              {availableDomains.length === 0 ? 'No domains available' : 'Select a domain...'}
            </option>
            {availableDomains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.domain}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={handleAssign}
            disabled={!selectedDomainId || assigning}
          >
            {assigning ? 'Assigning...' : 'Assign'}
          </Button>
        </div>
      )}

      {!currentDomain && availableDomains.length === 0 && (
        <p className="text-xs text-[var(--gray-a9)]">
          No active, unassigned domains. <a href={registryUrl} className="text-[var(--accent-11)] hover:underline">Add a domain</a> first.
        </p>
      )}
    </div>
  );
}
