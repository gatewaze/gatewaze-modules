import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  GlobeAltIcon,
  ArrowPathIcon,
  TrashIcon,
  CheckCircleIcon,
  ArrowLeftIcon,
  ClipboardDocumentIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

interface CustomDomain {
  id: string;
  domain: string;
  status: 'pending' | 'dns_verified' | 'provisioning' | 'active' | 'error' | 'removing';
  cname_target: string | null;
  expected_ip: string | null;
  content_type: string | null;
  content_id: string | null;
  content_slug: string | null;
  page_title: string | null;
  favicon_url: string | null;
  error_message: string | null;
  dns_verified_at: string | null;
  is_apex?: boolean;
  created_at: string;
  updated_at: string;
}

const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api/modules/custom-domains`;

const STATUS_CONFIG: Record<string, { label: string; color: 'orange' | 'blue' | 'yellow' | 'green' | 'red' | 'gray' }> = {
  pending: { label: 'Pending DNS', color: 'yellow' },
  dns_verified: { label: 'DNS Verified', color: 'blue' },
  provisioning: { label: 'Provisioning', color: 'orange' },
  active: { label: 'Active', color: 'green' },
  error: { label: 'Error', color: 'red' },
  removing: { label: 'Removing', color: 'gray' },
};

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

interface DomainDetailProps {
  domainId?: string;
  onBack?: () => void;
}

export default function DomainDetail({ domainId: propDomainId, onBack }: DomainDetailProps) {
  const params = useParams();
  const nav = useNavigate();
  const domainId = propDomainId || params.domainId || '';
  const handleBack = onBack || (() => nav('/admin/custom-domains'));
  const [domain, setDomain] = useState<CustomDomain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Branding form
  const [pageTitle, setPageTitle] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [savingBranding, setSavingBranding] = useState(false);

  // Content assignment
  const [assignContentType, setAssignContentType] = useState('');
  const [assignContentId, setAssignContentId] = useState('');
  const [assignContentSlug, setAssignContentSlug] = useState('');
  const [assignMode, setAssignMode] = useState<'top-level' | 'specific'>('top-level');
  const [assigning, setAssigning] = useState(false);
  const [contentItems, setContentItems] = useState<Array<{ id: string; label: string; slug: string }>>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Verify / Remove
  const [verifying, setVerifying] = useState(false);
  const [showConfirmRemove, setShowConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const fetchDomain = useCallback(async () => {
    try {
      setError(null);
      const data = await apiFetch<CustomDomain>(`/${domainId}`);
      setDomain(data);
      setPageTitle(data.page_title || '');
      setFaviconUrl(data.favicon_url || '');
      setAssignContentType(data.content_type || '');
      setAssignContentId(data.content_id || '');
      setAssignContentSlug(data.content_slug || '');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [domainId]);

  useEffect(() => {
    fetchDomain();
  }, [fetchDomain]);

  const showSuccessMessage = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 4000);
  };

  const handleVerify = async () => {
    setVerifying(true);
    setError(null);
    try {
      const result = await apiFetch<{ verified: boolean; status: string }>(`/${domainId}/verify`, {
        method: 'POST',
      });
      if (result.verified) {
        showSuccessMessage('DNS verified successfully.');
      } else {
        setError('DNS records not detected yet. Check your configuration and try again in a few minutes.');
      }
      await fetchDomain();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveBranding = async () => {
    setSavingBranding(true);
    setError(null);
    try {
      await apiFetch(`/${domainId}`, {
        method: 'PUT',
        body: JSON.stringify({
          page_title: pageTitle || null,
          favicon_url: faviconUrl || null,
        }),
      });
      showSuccessMessage('Branding settings saved.');
      await fetchDomain();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingBranding(false);
    }
  };

  // Content type definitions — keyed by module feature/id
  // Maps module features to their database table, name field, slug field for item lookup
  const CONTENT_TYPE_MAP: Record<string, { label: string; table: string; nameField: string; slugField: string; topLevelSlug: string; portalPath: string }> = {
    events: { label: 'Events', table: 'events', nameField: 'event_title', slugField: 'event_slug', topLevelSlug: 'upcoming', portalPath: '/events' },
    blog: { label: 'Blog', table: 'blog_posts', nameField: 'title', slugField: 'slug', topLevelSlug: '', portalPath: '/blog' },
    newsletters: { label: 'Newsletters', table: 'newsletters_template_collections', nameField: 'name', slugField: 'slug', topLevelSlug: '', portalPath: '/newsletters' },
    cohorts: { label: 'Cohorts', table: 'cohorts', nameField: 'name', slugField: 'slug', topLevelSlug: '', portalPath: '/cohorts' },
    competitions: { label: 'Competitions', table: 'competitions', nameField: 'title', slugField: 'slug', topLevelSlug: '', portalPath: '/competitions' },
    structured_resources: { label: 'Resources', table: 'structured_resources', nameField: 'title', slugField: 'slug', topLevelSlug: '', portalPath: '/resources' },
  };

  // Discover available content types from enabled modules
  const [availableContentTypes, setAvailableContentTypes] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    const fetchModules = async () => {
      const { data: modules } = await supabase
        .from('installed_modules')
        .select('id, name, features, status')
        .eq('status', 'enabled');
      if (!modules) return;

      const types: Array<{ value: string; label: string }> = [];
      for (const mod of modules) {
        // Check if any of the module's features match a known content type
        for (const feature of (mod.features || [])) {
          if (CONTENT_TYPE_MAP[feature]) {
            types.push({ value: feature, label: CONTENT_TYPE_MAP[feature].label });
          }
        }
        // Also check by module ID
        if (CONTENT_TYPE_MAP[mod.id] && !types.some(t => t.value === mod.id)) {
          types.push({ value: mod.id, label: CONTENT_TYPE_MAP[mod.id].label });
        }
      }
      setAvailableContentTypes(types);
    };
    fetchModules();
  }, []);

  const selectedContentType = assignContentType ? CONTENT_TYPE_MAP[assignContentType] : null;

  // Fetch content items when type changes and mode is 'specific'
  useEffect(() => {
    if (assignMode !== 'specific' || !assignContentType || !selectedContentType) {
      setContentItems([]);
      return;
    }
    const fetchItems = async () => {
      setLoadingItems(true);
      try {
        const { data, error: fetchError } = await supabase
          .from(selectedContentType.table)
          .select(`id, ${selectedContentType.nameField}, ${selectedContentType.slugField}`)
          .order(selectedContentType.nameField, { ascending: true })
          .limit(100);
        if (fetchError) {
          setContentItems([]);
        } else {
          setContentItems((data || []).map((item: any) => ({
            id: item.id,
            label: item[selectedContentType.nameField] || item.id,
            slug: item[selectedContentType.slugField] || item.id || '',
          })));
        }
      } catch {
        setContentItems([]);
      } finally {
        setLoadingItems(false);
      }
    };
    fetchItems();
  }, [assignContentType, assignMode]);

  const handleSelectItem = (itemId: string) => {
    const item = contentItems.find(i => i.id === itemId);
    if (item) {
      setAssignContentId(item.id);
      // Use slug if available, fall back to ID for portal routing
      setAssignContentSlug(item.slug || item.id);
    }
  };

  const handleSelectTopLevel = () => {
    if (selectedContentType) {
      // For top-level, use a special sentinel ID and the module's base slug
      setAssignContentId('__top_level__');
      setAssignContentSlug(selectedContentType.topLevelSlug || '');
    }
  };

  const handleAssign = async () => {
    if (!assignContentType) {
      setError('Please select a content type.');
      return;
    }

    // Determine content_id and slug based on mode
    let finalContentId = assignContentId;
    let finalContentSlug = assignContentSlug;

    if (assignMode === 'top-level') {
      finalContentId = '__top_level__';
      finalContentSlug = selectedContentType?.topLevelSlug || '';
    } else if (!finalContentId) {
      setError('Please select a specific item.');
      return;
    }

    setAssigning(true);
    setError(null);
    try {
      await apiFetch(`/${domainId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          content_type: assignContentType,
          content_id: finalContentId,
          content_slug: finalContentSlug || null,
        }),
      });
      showSuccessMessage('Domain assigned to content.');
      await fetchDomain();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async () => {
    setAssigning(true);
    setError(null);
    try {
      await apiFetch(`/${domainId}/assign`, { method: 'DELETE' });
      showSuccessMessage('Domain unassigned from content.');
      setAssignContentType('');
      setAssignContentId('');
      setAssignContentSlug('');
      await fetchDomain();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAssigning(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setShowConfirmRemove(false);
    try {
      await apiFetch(`/${domainId}`, { method: 'DELETE' });
      handleBack();
    } catch (err: any) {
      setError(err.message);
      setRemoving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <Page title="Domain Detail">
        <div className="flex items-center justify-center py-24">
          <LoadingSpinner size="medium" />
        </div>
      </Page>
    );
  }

  if (!domain) {
    return (
      <Page title="Domain Not Found">
        <div className="p-6">
          <div className="text-center py-16 text-[var(--gray-a9)]">
            <GlobeAltIcon className="size-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium text-[var(--gray-11)]">Domain not found</p>
            { (
              <Button variant="outline" onClick={handleBack} style={{ marginTop: "1rem" }}>
                <ArrowLeftIcon className="size-4" />
                Back to Domains
              </Button>
            )}
          </div>
        </div>
      </Page>
    );
  }

  const statusCfg = STATUS_CONFIG[domain.status] || STATUS_CONFIG.pending;

  return (
    <Page title={`Domain - ${domain.domain}`}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            { (
              <Button isIcon variant="ghost" onClick={handleBack}>
                <ArrowLeftIcon className="size-5" />
              </Button>
            )}
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold text-[var(--gray-12)]">{domain.domain}</h1>
                <Badge color={statusCfg.color} variant="soft">{statusCfg.label}</Badge>
              </div>
              <p className="text-sm text-[var(--gray-11)] mt-1">
                Added {formatDate(domain.created_at)}
                {domain.dns_verified_at && ` | DNS verified ${formatDate(domain.dns_verified_at)}`}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            color="red"
            onClick={() => setShowConfirmRemove(true)}
            disabled={removing || domain.status === 'removing'}
          >
            <TrashIcon className="size-4" />
            Remove Domain
          </Button>
        </div>

        {/* Messages */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
            <ExclamationCircleIcon className="size-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-300 flex items-start gap-2">
            <CheckCircleIcon className="size-5 flex-shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        {/* Error detail */}
        {domain.error_message && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
            <span className="font-medium">Error:</span> {domain.error_message}
          </div>
        )}

        {/* DNS Instructions */}
        {(domain.status === 'pending' || domain.status === 'error') && (
          <Card className="p-5">
            <h2 className="text-lg font-medium text-[var(--gray-12)] mb-3">DNS Configuration</h2>
            <p className="text-sm text-[var(--gray-11)] mb-4">
              Point your domain to our servers by adding the DNS records below with your registrar.
            </p>

            <div className="space-y-3 mb-4">
              {domain.cname_target && !domain.is_apex && (
                <div className="rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-[var(--gray-a9)] uppercase">CNAME Record</span>
                    <button
                      onClick={() => copyToClipboard(domain.cname_target!)}
                      className="text-xs text-[var(--accent-11)] hover:underline flex items-center gap-1"
                    >
                      <ClipboardDocumentIcon className="size-3" />
                      Copy target
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <span className="text-[var(--gray-a9)] text-xs block">Type</span>
                      <span className="font-mono text-[var(--gray-12)]">CNAME</span>
                    </div>
                    <div>
                      <span className="text-[var(--gray-a9)] text-xs block">Name</span>
                      <span className="font-mono text-[var(--gray-12)]">{domain.domain}</span>
                    </div>
                    <div>
                      <span className="text-[var(--gray-a9)] text-xs block">Target</span>
                      <span className="font-mono text-[var(--gray-12)]">{domain.cname_target}</span>
                    </div>
                  </div>
                </div>
              )}

              {domain.expected_ip && (
                <div className="rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-[var(--gray-a9)] uppercase">A Record</span>
                    <button
                      onClick={() => copyToClipboard(domain.expected_ip!)}
                      className="text-xs text-[var(--accent-11)] hover:underline flex items-center gap-1"
                    >
                      <ClipboardDocumentIcon className="size-3" />
                      Copy IP
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <span className="text-[var(--gray-a9)] text-xs block">Type</span>
                      <span className="font-mono text-[var(--gray-12)]">A</span>
                    </div>
                    <div>
                      <span className="text-[var(--gray-a9)] text-xs block">Name</span>
                      <span className="font-mono text-[var(--gray-12)]">{domain.domain}</span>
                    </div>
                    <div>
                      <span className="text-[var(--gray-a9)] text-xs block">Target</span>
                      <span className="font-mono text-[var(--gray-12)]">{domain.expected_ip}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <Button onClick={handleVerify} disabled={verifying}>
              {verifying ? (
                <ArrowPathIcon className="size-4 animate-spin" />
              ) : (
                <CheckCircleIcon className="size-4" />
              )}
              Verify DNS
            </Button>
          </Card>
        )}

        {/* Content Assignment */}
        <Card className="p-5">
          <h2 className="text-lg font-medium text-[var(--gray-12)] mb-3">Content Assignment</h2>
          <p className="text-sm text-[var(--gray-11)] mb-4">
            Assign this domain to a specific piece of content (e.g. an event, portal, or page).
          </p>

          {domain.content_id ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-3">
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-[var(--gray-a9)] text-xs block">Content Type</span>
                    <span className="text-[var(--gray-12)]">{domain.content_type}</span>
                  </div>
                  <div>
                    <span className="text-[var(--gray-a9)] text-xs block">Content ID</span>
                    <span className="font-mono text-[var(--gray-12)] text-xs">{domain.content_id}</span>
                  </div>
                  <div>
                    <span className="text-[var(--gray-a9)] text-xs block">Slug</span>
                    <span className="text-[var(--gray-12)]">{domain.content_slug || '-'}</span>
                  </div>
                </div>
              </div>
              <Button variant="outline" color="red" size="sm" onClick={handleUnassign} disabled={assigning}>
                Unassign
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Step 1: Select content type */}
              <div>
                <label className="block text-xs font-medium text-[var(--gray-a9)] mb-1">Content Type</label>
                <select
                  value={assignContentType}
                  onChange={(e) => {
                    setAssignContentType(e.target.value);
                    setAssignContentId('');
                    setAssignContentSlug('');
                  }}
                  className="w-full max-w-xs px-3 py-2 rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a7)]"
                >
                  <option value="">Select type...</option>
                  {availableContentTypes.map(ct => (
                    <option key={ct.value} value={ct.value}>{ct.label}</option>
                  ))}
                </select>
              </div>

              {/* Step 2: Choose top-level or specific */}
              {assignContentType && (
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-a9)] mb-2">Map to</label>
                  <div className="flex gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="assignMode"
                        checked={assignMode === 'top-level'}
                        onChange={() => {
                          setAssignMode('top-level');
                          setAssignContentId('__top_level__');
                          setAssignContentSlug(selectedContentType?.topLevelSlug || '');
                        }}
                        className="accent-[var(--accent-9)]"
                      />
                      <span className="text-sm text-[var(--gray-12)]">
                        All {selectedContentType?.label} <span className="text-[var(--gray-a9)]">(/{assignContentType})</span>
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="assignMode"
                        checked={assignMode === 'specific'}
                        onChange={() => {
                          setAssignMode('specific');
                          setAssignContentId('');
                          setAssignContentSlug('');
                        }}
                        className="accent-[var(--accent-9)]"
                      />
                      <span className="text-sm text-[var(--gray-12)]">A specific {selectedContentType?.label.toLowerCase().replace(/s$/, '')}</span>
                    </label>
                  </div>
                </div>
              )}

              {/* Step 3: Select specific item (if specific mode) */}
              {assignContentType && assignMode === 'specific' && (
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-a9)] mb-1">Select {selectedContentType?.label.toLowerCase().replace(/s$/, '')}</label>
                  {loadingItems ? (
                    <div className="flex items-center gap-2 text-sm text-[var(--gray-a9)] py-2">
                      <ArrowPathIcon className="size-4 animate-spin" /> Loading...
                    </div>
                  ) : contentItems.length === 0 ? (
                    <p className="text-sm text-[var(--gray-a9)] py-2">No {selectedContentType?.label.toLowerCase()} found. Create some first.</p>
                  ) : (
                    <select
                      value={assignContentId}
                      onChange={(e) => handleSelectItem(e.target.value)}
                      className="w-full max-w-md px-3 py-2 rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a7)]"
                    >
                      <option value="">Select...</option>
                      {contentItems.map(item => (
                        <option key={item.id} value={item.id}>{item.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Assign button */}
              {assignContentType && (assignMode === 'top-level' || assignContentId) && (
                <Button
                  onClick={handleAssign}
                  disabled={assigning}
                  size="sm"
                >
                  {assigning ? 'Assigning...' : `Assign to ${assignMode === 'top-level' ? `All ${selectedContentType?.label}` : 'Selected Item'}`}
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* Branding Settings */}
        <Card className="p-5">
          <h2 className="text-lg font-medium text-[var(--gray-12)] mb-3">Branding</h2>
          <p className="text-sm text-[var(--gray-11)] mb-4">
            Customize how this domain appears in the browser tab and on the page.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-[var(--gray-a9)] mb-1">Page Title</label>
              <input
                type="text"
                value={pageTitle}
                onChange={(e) => setPageTitle(e.target.value)}
                placeholder="My Conference Portal"
                className="w-full max-w-md px-3 py-2 rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] text-[var(--gray-12)] placeholder:text-[var(--gray-a8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a7)]"
              />
              <p className="text-xs text-[var(--gray-a9)] mt-1">Displayed in the browser tab title.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--gray-a9)] mb-1">Favicon URL</label>
              <input
                type="url"
                value={faviconUrl}
                onChange={(e) => setFaviconUrl(e.target.value)}
                placeholder="https://example.com/favicon.ico"
                className="w-full max-w-md px-3 py-2 rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] text-[var(--gray-12)] placeholder:text-[var(--gray-a8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a7)]"
              />
              <p className="text-xs text-[var(--gray-a9)] mt-1">URL to a .ico or .png favicon file.</p>
            </div>

            <Button onClick={handleSaveBranding} disabled={savingBranding} size="sm">
              {savingBranding ? 'Saving...' : 'Save Branding'}
            </Button>
          </div>
        </Card>

        {/* Confirm Remove Modal */}
        <ConfirmModal
          isOpen={showConfirmRemove}
          onClose={() => setShowConfirmRemove(false)}
          onConfirm={handleRemove}
          title="Remove Domain"
          message={`Are you sure you want to remove "${domain.domain}"? This will delete the domain configuration, TLS certificate, and stop serving content on this domain.`}
          confirmText="Remove Domain"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
