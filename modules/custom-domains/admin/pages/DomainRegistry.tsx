import { useState, useEffect, useCallback } from 'react';
import {
  GlobeAltIcon,
  PlusIcon,
  ArrowPathIcon,
  TrashIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  XMarkIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui';
import { Badge } from '@/components/ui/Badge';
import { Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
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
  created_at: string;
  updated_at: string;
}

interface DnsInstructions {
  cname?: { type: string; name: string; target: string };
  a_record: { type: string; name: string; target: string };
  note: string;
}

interface NewDomainResponse extends CustomDomain {
  is_apex: boolean;
  dns_instructions: DnsInstructions;
}

const API_BASE = '/api/modules/custom-domains';

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

export default function DomainRegistry() {
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add domain form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dnsInstructions, setDnsInstructions] = useState<DnsInstructions | null>(null);
  const [addedDomainName, setAddedDomainName] = useState<string | null>(null);

  // Verify / remove state
  const [verifying, setVerifying] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CustomDomain | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const fetchDomains = useCallback(async () => {
    try {
      setError(null);
      const data = await apiFetch<CustomDomain[]>('/');
      setDomains(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  const handleAddDomain = async () => {
    const cleaned = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!cleaned) {
      setAddError('Please enter a domain name.');
      return;
    }

    setAdding(true);
    setAddError(null);
    setDnsInstructions(null);
    try {
      const result = await apiFetch<NewDomainResponse>('/', {
        method: 'POST',
        body: JSON.stringify({ domain: cleaned }),
      });
      setDnsInstructions(result.dns_instructions);
      setAddedDomainName(result.domain);
      setNewDomain('');
      await fetchDomains();
    } catch (err: any) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleVerify = async (domainId: string) => {
    setVerifying(domainId);
    try {
      const result = await apiFetch<{ verified: boolean; status: string }>(`/${domainId}/verify`, {
        method: 'POST',
      });
      if (!result.verified) {
        setError('DNS records not detected yet. Please check your configuration and try again in a few minutes.');
        setTimeout(() => setError(null), 6000);
      }
      await fetchDomains();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVerifying(null);
    }
  };

  const handleRemove = async (domainId: string) => {
    setRemoving(domainId);
    setConfirmRemove(null);
    try {
      await apiFetch(`/${domainId}`, { method: 'DELETE' });
      await fetchDomains();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRemoving(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getAssignedTo = (domain: CustomDomain) => {
    if (!domain.content_type) return null;
    return `${domain.content_type}${domain.content_slug ? ` / ${domain.content_slug}` : ''}`;
  };

  return (
    <Page title="Custom Domains">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Custom Domains</h1>
            <p className="text-[var(--gray-11)] mt-1">
              Manage custom domains for your portal content
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={fetchDomains} disabled={loading}>
              <ArrowPathIcon className="size-4" />
              Refresh
            </Button>
            <Button onClick={() => { setShowAddForm(true); setDnsInstructions(null); setAddError(null); }}>
              <PlusIcon className="size-4" />
              Add Domain
            </Button>
          </div>
        </div>

        {/* Global error */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
            <ExclamationCircleIcon className="size-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Add Domain Form */}
        {showAddForm && (
          <Card className="p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium text-[var(--gray-12)]">Register New Domain</h2>
              <Button
                isIcon
                variant="ghost"
                onClick={() => { setShowAddForm(false); setDnsInstructions(null); setAddError(null); }}
              >
                <XMarkIcon className="size-5" />
              </Button>
            </div>

            {!dnsInstructions ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                    Domain Name
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newDomain}
                      onChange={(e) => { setNewDomain(e.target.value); setAddError(null); }}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddDomain()}
                      placeholder="events.example.com"
                      className="flex-1 px-3 py-2 rounded-md border border-[var(--gray-a6)] bg-[var(--gray-a2)] text-[var(--gray-12)] placeholder:text-[var(--gray-a8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a7)]"
                    />
                    <Button onClick={handleAddDomain} disabled={adding || !newDomain.trim()}>
                      {adding ? 'Adding...' : 'Register'}
                    </Button>
                  </div>
                  <p className="text-xs text-[var(--gray-a9)] mt-1">
                    Enter a bare hostname (e.g. events.example.com). Do not include https://.
                  </p>
                  {addError && (
                    <p className="text-sm text-[var(--red-11)] mt-2">{addError}</p>
                  )}
                </div>
              </div>
            ) : (
              <DnsInstructionsPanel
                domain={addedDomainName!}
                instructions={dnsInstructions}
                onCopy={copyToClipboard}
                onDone={() => { setShowAddForm(false); setDnsInstructions(null); }}
              />
            )}
          </Card>
        )}

        {/* Domain List */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner size="medium" />
          </div>
        ) : domains.length === 0 ? (
          <div className="text-center py-16 text-[var(--gray-a9)]">
            <GlobeAltIcon className="size-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium text-[var(--gray-11)]">No custom domains yet</p>
            <p className="text-sm mt-1">Add a custom domain to serve your content on your own hostname.</p>
          </div>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>Domain</Th>
                    <Th>Status</Th>
                    <Th>Assigned To</Th>
                    <Th>Added</Th>
                    <Th />
                  </Tr>
                </THead>
                <TBody>
                  {domains.map((domain) => {
                    const statusCfg = STATUS_CONFIG[domain.status] || STATUS_CONFIG.pending;
                    const assignedTo = getAssignedTo(domain);
                    return (
                      <Tr key={domain.id}>
                        <Td>
                          <div className="flex items-center gap-2">
                            <GlobeAltIcon className="size-4 text-[var(--gray-a9)] flex-shrink-0" />
                            <span className="font-medium text-[var(--gray-12)]">{domain.domain}</span>
                          </div>
                          {domain.error_message && (
                            <p className="text-xs text-[var(--red-11)] mt-1 ml-6">{domain.error_message}</p>
                          )}
                        </Td>
                        <Td>
                          <Badge color={statusCfg.color} variant="soft">
                            {statusCfg.label}
                          </Badge>
                        </Td>
                        <Td>
                          {assignedTo ? (
                            <span className="text-sm text-[var(--gray-11)]">{assignedTo}</span>
                          ) : (
                            <span className="text-sm text-[var(--gray-a8)] italic">Unassigned</span>
                          )}
                        </Td>
                        <Td>
                          <span className="text-sm text-[var(--gray-11)]">{formatDate(domain.created_at)}</span>
                        </Td>
                        <Td>
                          <div className="flex items-center justify-end gap-2">
                            {(domain.status === 'pending' || domain.status === 'error') && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleVerify(domain.id)}
                                disabled={verifying === domain.id}
                              >
                                {verifying === domain.id ? (
                                  <ArrowPathIcon className="size-4 animate-spin" />
                                ) : (
                                  <CheckCircleIcon className="size-4" />
                                )}
                                Verify DNS
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              color="red"
                              onClick={() => setConfirmRemove(domain)}
                              disabled={removing === domain.id || domain.status === 'removing'}
                            >
                              <TrashIcon className="size-4" />
                              Remove
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </Card>
        )}

        {/* Confirm Remove Modal */}
        <ConfirmModal
          isOpen={!!confirmRemove}
          onClose={() => setConfirmRemove(null)}
          onConfirm={() => confirmRemove && handleRemove(confirmRemove.id)}
          title="Remove Domain"
          message={`Are you sure you want to remove "${confirmRemove?.domain}"? This will delete the domain configuration and any associated TLS certificate. The domain will stop serving content.`}
          confirmText="Remove Domain"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}

// -------------------------------------------------------------------
// DNS Instructions sub-component
// -------------------------------------------------------------------

function DnsInstructionsPanel({
  domain,
  instructions,
  onCopy,
  onDone,
}: {
  domain: string;
  instructions: DnsInstructions;
  onCopy: (text: string) => void;
  onDone: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircleIcon className="size-5 text-[var(--green-11)]" />
        <span className="font-medium text-[var(--gray-12)]">
          Domain <span className="font-mono">{domain}</span> registered
        </span>
      </div>

      <p className="text-sm text-[var(--gray-11)]">
        Add the following DNS record(s) with your domain registrar, then click "Verify DNS" on the domain row.
      </p>

      <div className="space-y-3">
        {instructions.cname && (
          <div className="rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[var(--gray-a9)] uppercase">CNAME Record (recommended for subdomains)</span>
              <button
                onClick={() => onCopy(instructions.cname!.target)}
                className="text-xs text-[var(--accent-11)] hover:underline flex items-center gap-1"
              >
                <ClipboardDocumentIcon className="size-3" />
                Copy
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <span className="text-[var(--gray-a9)] text-xs block">Type</span>
                <span className="font-mono text-[var(--gray-12)]">{instructions.cname.type}</span>
              </div>
              <div>
                <span className="text-[var(--gray-a9)] text-xs block">Name</span>
                <span className="font-mono text-[var(--gray-12)]">{instructions.cname.name}</span>
              </div>
              <div>
                <span className="text-[var(--gray-a9)] text-xs block">Target</span>
                <span className="font-mono text-[var(--gray-12)]">{instructions.cname.target}</span>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-[var(--gray-a5)] bg-[var(--gray-a2)] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[var(--gray-a9)] uppercase">
              A Record {instructions.cname ? '(alternative / apex domains)' : '(required)'}
            </span>
            <button
              onClick={() => onCopy(instructions.a_record.target)}
              className="text-xs text-[var(--accent-11)] hover:underline flex items-center gap-1"
            >
              <ClipboardDocumentIcon className="size-3" />
              Copy
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <span className="text-[var(--gray-a9)] text-xs block">Type</span>
              <span className="font-mono text-[var(--gray-12)]">{instructions.a_record.type}</span>
            </div>
            <div>
              <span className="text-[var(--gray-a9)] text-xs block">Name</span>
              <span className="font-mono text-[var(--gray-12)]">{instructions.a_record.name}</span>
            </div>
            <div>
              <span className="text-[var(--gray-a9)] text-xs block">Target</span>
              <span className="font-mono text-[var(--gray-12)]">{instructions.a_record.target}</span>
            </div>
          </div>
        </div>
      </div>

      {instructions.note && (
        <p className="text-xs text-[var(--gray-a9)] bg-[var(--gray-a2)] rounded p-2">
          {instructions.note}
        </p>
      )}

      <div className="flex justify-end">
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
