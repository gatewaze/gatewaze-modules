import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheckIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  EyeIcon,
  TrashIcon,
  DocumentArrowDownIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { Card, Input, Button, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';

type RequestType = 'data_export' | 'data_deletion' | 'data_correction' | 'data_portability' | 'consent_withdrawal' | 'processing_restriction';
type Status = 'pending' | 'in_progress' | 'completed' | 'rejected';

interface PlanTable { table: string; entry: string; owner: string; action: 'delete' | 'anonymise'; rows: number; retain?: { reason: string; basis: string; period: string } | null; note?: string | null }
interface PlanIssue { kind: string; table?: string; column?: string; entry?: string; rows?: number; detail: string }
interface Plan { built_at: string; summary: { emails: number; people: number; auth_users: number; tables: number; rows: number }; tables: PlanTable[]; blockers: PlanIssue[]; warnings: PlanIssue[] }
interface Processor { id: string; name: string; status: 'erased' | 'not_found' | 'manual' | 'failed' | 'skipped'; detail?: string; at: string }
interface ChecklistItem { id: string; title: string; detail?: string; done: boolean; done_by?: string | null; done_at?: string | null }

interface PrivacyRequest {
  id: string;
  subject_email: string;
  subject_emails: string[] | null;
  request_type: RequestType;
  status: Status;
  requested_at: string;
  due_at: string | null;
  source: string | null;
  notes: string | null;
  requester_email: string;
  submitted_via: 'admin' | 'api' | 'mcp' | null;
  submitted_by: string | null;
  identifiers: { emails?: string[] | number; person_ids?: string[]; auth_user_ids?: string[] } | null;
  plan: Plan | null;
  plan_status: 'none' | 'queued' | 'running' | 'ready' | 'failed';
  plan_error: string | null;
  plan_built_at: string | null;
  execute_status: 'none' | 'queued' | 'running' | 'erased' | 'failed';
  executed_at: string | null;
  executed_by: string | null;
  error_message: string | null;
  processors: Processor[];
  checklist: ChecklistItem[];
  processing_completed_at: string | null;
  redacted_at: string | null;
}

type StatusFilter = 'all' | Status;
type RequestTypeFilter = 'all' | RequestType;

const REQUEST_TYPE_LABELS: Record<string, string> = {
  data_export: 'Data Export (DSAR)',
  data_deletion: 'Right to Erasure',
  data_correction: 'Data Correction',
  data_portability: 'Data Portability',
  consent_withdrawal: 'Consent Withdrawal',
  processing_restriction: 'Processing Restriction',
};

const STATUS_LABELS: Record<Status, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  rejected: 'Rejected',
};

const SELECT_CLASS = 'px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white';

/**
 * Calls the compliance module's admin API. Those routes check the session and
 * admin role themselves, so attach the Supabase access token and target the
 * API host, as other module admin pages do.
 */
async function apiFetch(path: string, init?: RequestInit): Promise<any> {
  const base = (import.meta as any).env?.VITE_API_URL ?? '';
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (data.session?.access_token) headers.set('Authorization', `Bearer ${data.session.access_token}`);
  const res = await fetch(`${base}/api/modules/compliance${path}`, { ...init, headers });
  if (path.endsWith('.md')) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body.data;
}

const emailsOf = (r: PrivacyRequest) => (r.redacted_at ? [] : r.subject_emails ?? [r.subject_email]);
const isBusy = (r: PrivacyRequest) => ['queued', 'running'].includes(r.plan_status) || ['queued', 'running'].includes(r.execute_status);

function daysLeft(due: string | null): number | null {
  if (!due) return null;
  return Math.ceil((new Date(due).getTime() - Date.now()) / 86_400_000);
}

function formatDate(v?: string | null) {
  return v ? new Date(v).toLocaleString() : '-';
}

function StatusBadge({ status }: { status: Status }) {
  const styles: Record<Status, string> = {
    pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
    in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200',
    rejected: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
  };
  const Icon = status === 'completed' ? CheckCircleIcon : status === 'rejected' ? XCircleIcon : status === 'in_progress' ? ArrowPathIcon : ClockIcon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full ${styles[status]}`}>
      <Icon className="size-3" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function DueBadge({ r }: { r: PrivacyRequest }) {
  const d = daysLeft(r.due_at);
  if (d === null || r.status === 'completed' || r.status === 'rejected') return <span>-</span>;
  const cls = d < 0 ? 'text-red-600 font-semibold' : d <= 5 ? 'text-orange-600 font-semibold' : '';
  return <span className={cls}>{d < 0 ? `${-d}d overdue` : `${d}d left`}</span>;
}

export function PrivacyRequestsTab() {
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<RequestTypeFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const fetchRequests = useCallback(async () => {
    let query = supabase.from('compliance_privacy_requests').select('*').order('requested_at', { ascending: false }).limit(500);
    if (statusFilter !== 'all') query = query.eq('status', statusFilter);
    if (typeFilter !== 'all') query = query.eq('request_type', typeFilter);
    const { data, error } = await query;
    if (error) console.error('Error fetching privacy requests:', error);
    setRequests((data as PrivacyRequest[]) ?? []);
    setLoading(false);
  }, [statusFilter, typeFilter]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // Poll while a preview or erasure is running.
  useEffect(() => {
    if (!requests.some(isBusy)) return;
    const t = setInterval(fetchRequests, 3000);
    return () => clearInterval(t);
  }, [requests, fetchRequests]);

  // Search runs over the loaded rows, so the search box never reaches a
  // PostgREST filter.
  const visible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((r) =>
      emailsOf(r).some((e) => e.includes(q)) ||
      r.requester_email?.toLowerCase().includes(q) ||
      r.source?.toLowerCase().includes(q));
  }, [requests, searchQuery]);

  const stats = useMemo(() => ({
    total: requests.length,
    pending: requests.filter((r) => r.status === 'pending').length,
    inProgress: requests.filter((r) => r.status === 'in_progress').length,
    completed: requests.filter((r) => r.status === 'completed').length,
    dueSoon: requests.filter((r) => r.status !== 'completed' && r.status !== 'rejected' && (daysLeft(r.due_at) ?? 99) <= 5).length,
  }), [requests]);

  const selected = requests.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Requests</div>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-yellow-900 dark:text-yellow-200">{stats.pending}</div>
          <div className="text-sm text-yellow-600 dark:text-yellow-400">Pending</div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-blue-900 dark:text-blue-200">{stats.inProgress}</div>
          <div className="text-sm text-blue-600 dark:text-blue-400">In Progress</div>
        </div>
        <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-green-900 dark:text-green-200">{stats.completed}</div>
          <div className="text-sm text-green-600 dark:text-green-400">Completed</div>
        </div>
        <div className="bg-orange-50 dark:bg-orange-900/20 p-4 rounded-lg">
          <div className="text-2xl font-bold text-orange-900 dark:text-orange-200">{stats.dueSoon}</div>
          <div className="text-sm text-orange-600 dark:text-orange-400">Due within 5 days</div>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Search</label>
            <div className="relative">
              <MagnifyingGlassIcon className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input placeholder="Email or source..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className={SELECT_CLASS}>
              <option value="all">All Status</option>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Request Type</label>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as RequestTypeFilter)} className={SELECT_CLASS}>
              <option value="all">All Types</option>
              {Object.entries(REQUEST_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <Button onClick={() => setShowNew(true)} className="gap-1">
            <PlusIcon className="size-4" />
            New request
          </Button>
        </div>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-12"><LoadingSpinner size="medium" /></div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <ShieldCheckIcon className="size-12 mx-auto mb-4 opacity-50" />
          <p>No privacy requests found.</p>
          <p className="text-sm mt-2">Requests filed here, through the public API or through MCP appear in this list.</p>
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Subject</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th>Received</Th>
                  <Th>Due</Th>
                  <Th>Filed via</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {visible.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      <div className="text-sm font-medium">{r.redacted_at ? 'Erased (addresses hashed)' : emailsOf(r).join(', ')}</div>
                      {r.source && <div className="text-xs text-gray-500">{r.source}</div>}
                    </Td>
                    <Td>{REQUEST_TYPE_LABELS[r.request_type] ?? r.request_type}</Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td>{formatDate(r.requested_at)}</Td>
                    <Td><DueBadge r={r} /></Td>
                    <Td>{r.submitted_via ?? 'admin'}</Td>
                    <Td>
                      <RowActions actions={[{ label: 'Open', icon: <EyeIcon className="size-4" />, onClick: () => setSelectedId(r.id) }]} />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )}

      {showNew && <NewRequestModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); fetchRequests(); setSelectedId(id); }} />}
      {selected && <RequestModal request={selected} onClose={() => setSelectedId(null)} onChanged={fetchRequests} />}
    </div>
  );
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-start">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
            {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{subtitle}</p>}
          </div>
          <Button isIcon variant="ghost" onClick={onClose}><XCircleIcon className="size-6" /></Button>
        </div>
        <div className="p-6 space-y-5">{children}</div>
      </div>
    </div>
  );
}

function NewRequestModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [emails, setEmails] = useState('');
  const [type, setType] = useState<RequestType>('data_deletion');
  const [source, setSource] = useState('');
  const [requestedAt, setRequestedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const row = await apiFetch('/privacy-requests', {
        method: 'POST',
        body: JSON.stringify({
          emails,
          request_type: type,
          source: source || undefined,
          requested_at: requestedAt ? new Date(requestedAt).toISOString() : undefined,
          notes: notes || undefined,
        }),
      });
      onCreated(row.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New privacy request" onClose={onClose}>
      <div>
        <label className="block text-sm font-medium mb-1">Email addresses</label>
        <textarea value={emails} onChange={(e) => setEmails(e.target.value)} rows={2} placeholder="One or more, separated by commas"
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800" />
        <p className="text-xs text-gray-500 mt-1">The preview also finds other addresses recorded for the same person.</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as RequestType)} className={`${SELECT_CLASS} w-full`}>
            {Object.entries(REQUEST_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Received</label>
          <Input type="datetime-local" value={requestedAt} onChange={(e) => setRequestedAt(e.target.value)} />
          <p className="text-xs text-gray-500 mt-1">When the person asked. Due one month later.</p>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Source</label>
        <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. LF Privacy team, DL ticket" />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving || !emails.trim()}>{saving ? 'Saving...' : 'Create request'}</Button>
      </div>
    </Modal>
  );
}

function RequestModal({ request: r, onClose, onChanged }: { request: PrivacyRequest; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const isErasure = r.request_type === 'data_deletion';
  const plan = r.plan;
  const planFresh = !!r.plan_built_at && Date.now() - new Date(r.plan_built_at).getTime() < 24 * 3600_000;
  const canErase = isErasure && r.plan_status === 'ready' && planFresh && (plan?.blockers.length ?? 1) === 0
    && ['none', 'failed'].includes(r.execute_status) && emailsOf(r).includes(confirm.trim().toLowerCase());

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const downloadReport = () => run(async () => {
    const md = await apiFetch(`/privacy-requests/${r.id}/report.md`);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `erasure-report-${r.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const setStatus = (status: Status) => run(() => apiFetch(`/privacy-requests/${r.id}/status`, { method: 'POST', body: JSON.stringify({ status }) }));

  const identifiedEmails = Array.isArray(r.identifiers?.emails) ? r.identifiers!.emails as string[] : [];

  return (
    <Modal title={REQUEST_TYPE_LABELS[r.request_type] ?? r.request_type} subtitle={`Request ${r.id}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div><div className="text-xs uppercase text-gray-500">Subject</div>{r.redacted_at ? 'Addresses replaced with hashes' : emailsOf(r).join(', ')}</div>
        <div><div className="text-xs uppercase text-gray-500">Status</div><StatusBadge status={r.status} /></div>
        <div><div className="text-xs uppercase text-gray-500">Received</div>{formatDate(r.requested_at)}</div>
        <div><div className="text-xs uppercase text-gray-500">Due</div>{formatDate(r.due_at)} (<DueBadge r={r} />)</div>
        <div><div className="text-xs uppercase text-gray-500">Source</div>{r.source ?? '-'}</div>
        <div><div className="text-xs uppercase text-gray-500">Filed by</div>{r.submitted_by ?? '-'}</div>
      </div>
      {r.notes && <p className="text-sm whitespace-pre-wrap">{r.notes}</p>}

      {isErasure && r.execute_status === 'none' && r.status === 'pending' && (
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setStatus('rejected')}>Reject request</Button>
        </div>
      )}

      {!isErasure && r.status !== 'completed' && r.status !== 'rejected' && (
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setStatus('in_progress')}>Mark in progress</Button>
          <Button variant="outline" disabled={busy} onClick={() => setStatus('completed')}>Mark completed</Button>
          <Button variant="outline" disabled={busy} onClick={() => setStatus('rejected')}>Reject</Button>
        </div>
      )}

      {isErasure && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold">1. Preview</h4>
              {r.execute_status !== 'erased' && !r.redacted_at && (
                <Button variant="outline" disabled={busy || ['queued', 'running'].includes(r.plan_status)} onClick={() => run(() => apiFetch(`/privacy-requests/${r.id}/preview`, { method: 'POST' }))} className="gap-1">
                  <ArrowPathIcon className="size-4" />
                  {r.plan_status === 'none' ? 'Build preview' : 'Rebuild preview'}
                </Button>
              )}
            </div>
            {['queued', 'running'].includes(r.plan_status) && <p className="text-sm text-gray-500">Building the preview. This can take a minute on large databases.</p>}
            {r.plan_status === 'failed' && <p className="text-sm text-red-600">Preview failed: {r.plan_error}</p>}
            {plan && r.plan_status === 'ready' && (
              <div className="space-y-3 text-sm">
                <p>
                  Matched {plan.summary.people} person record(s), {plan.summary.emails} email address(es) and {plan.summary.auth_users} sign-in account(s).
                  {' '}{plan.summary.rows} rows across {plan.summary.tables} tables. Built {formatDate(plan.built_at)}{planFresh ? '' : ' (more than 24 hours ago; rebuild before erasing)'}.
                </p>
                {identifiedEmails.length > 0 && <p className="text-xs text-gray-500">Addresses: {identifiedEmails.join(', ')}</p>}
                {plan.blockers.map((b, i) => (
                  <div key={`b${i}`} className="flex gap-2 p-2 rounded bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200">
                    <ExclamationTriangleIcon className="size-4 shrink-0 mt-0.5" />
                    <span><strong>{b.table}{b.column ? `.${b.column}` : ''}</strong>{b.rows ? ` (${b.rows} rows)` : ''}: {b.detail}</span>
                  </div>
                ))}
                {plan.warnings.map((w, i) => (
                  <div key={`w${i}`} className="flex gap-2 p-2 rounded bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200">
                    <ExclamationTriangleIcon className="size-4 shrink-0 mt-0.5" />
                    <span>{w.table ? <strong>{w.table}: </strong> : null}{w.detail}</span>
                  </div>
                ))}
                {plan.tables.length > 0 && (
                  <Table>
                    <THead><Tr><Th>Table</Th><Th>Action</Th><Th>Rows</Th><Th>Notes</Th></Tr></THead>
                    <TBody>
                      {plan.tables.map((t) => (
                        <Tr key={`${t.table}/${t.entry}`}>
                          <Td>{t.table}{t.entry !== 'default' ? ` (${t.entry})` : ''}</Td>
                          <Td>{t.action === 'delete' ? 'Delete' : 'Remove identifiers'}</Td>
                          <Td>{t.rows}</Td>
                          <Td className="text-xs">{t.retain ? `Kept: ${t.retain.reason}` : t.note ?? ''}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                )}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h4 className="font-semibold">2. Erase</h4>
            {r.execute_status === 'erased' ? (
              <p className="text-sm text-green-700 dark:text-green-300">Database erasure committed {formatDate(r.executed_at)} by {r.executed_by}. Every address is now suppressed.</p>
            ) : ['queued', 'running'].includes(r.execute_status) ? (
              <p className="text-sm text-gray-500">Erasure running. It runs as one transaction: either everything is removed or nothing is.</p>
            ) : (
              <>
                {r.execute_status === 'failed' && <p className="text-sm text-red-600">The last attempt failed and was rolled back: {r.error_message}</p>}
                <p className="text-sm">This permanently deletes or anonymises every row in the preview and cannot be undone. Type one of the request addresses to confirm.</p>
                <div className="flex gap-2">
                  <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Email address" className="flex-1" />
                  <Button color="red" disabled={busy || !canErase} onClick={() => run(() => apiFetch(`/privacy-requests/${r.id}/execute`, { method: 'POST', body: JSON.stringify({ confirm_email: confirm }) }))} className="gap-1">
                    <TrashIcon className="size-4" />
                    Erase
                  </Button>
                </div>
              </>
            )}
          </section>

          {r.execute_status === 'erased' && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold">3. Outside services and manual steps</h4>
                {!r.redacted_at && r.processors.some((p) => p.status === 'failed') && (
                  <Button variant="outline" disabled={busy} onClick={() => run(() => apiFetch(`/privacy-requests/${r.id}/retry-processors`, { method: 'POST' }))}>Retry failed</Button>
                )}
              </div>
              <ul className="text-sm space-y-1">
                {r.processors.map((p) => (
                  <li key={p.id}><strong>{p.name}</strong>: {p.status}{p.detail ? `. ${p.detail}` : ''}</li>
                ))}
              </ul>
              {r.checklist.length > 0 && (
                <ul className="text-sm space-y-2">
                  {r.checklist.map((c) => (
                    <li key={c.id} className="flex gap-2 items-start">
                      <input type="checkbox" checked={c.done} disabled={busy || !!r.redacted_at} className="mt-1"
                        onChange={(e) => run(() => apiFetch(`/privacy-requests/${r.id}/checklist/${encodeURIComponent(c.id)}`, { method: 'POST', body: JSON.stringify({ done: e.target.checked }) }))} />
                      <span><strong>{c.title}</strong>{c.detail ? `. ${c.detail}` : ''}{c.done_at ? <span className="text-xs text-gray-500"> (done {formatDate(c.done_at)})</span> : null}</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.redacted_at && <p className="text-sm text-green-700 dark:text-green-300">Completed {formatDate(r.processing_completed_at)}. The request now holds only hashes of the addresses.</p>}
            </section>
          )}

          <div className="flex justify-end">
            <Button variant="outline" disabled={busy} onClick={downloadReport} className="gap-1">
              <DocumentArrowDownIcon className="size-4" />
              Download report
            </Button>
          </div>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
