import { useCallback, useEffect, useState } from 'react';
import { ExclamationTriangleIcon, PlusIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, Modal } from '@/components/ui';
import PlacementService, {
  type FilterVerdict,
  type PlacementReport,
  type PlacementTest,
  type SeedRow,
  type SenderAuth,
} from '../lib/placementService';

const inputCls =
  'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

const PROVIDERS = [
  'overall',
  'gmail',
  'outlook',
  'yahoo',
  'aol',
  'icloud',
  'gmx',
  'mail_ru',
  'zoho',
  'corporate',
  'other',
];

interface PlacementPanelProps {
  runId: string;
  run?: { status?: string; name?: string };
}

function share(part: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

/**
 * Inbox-placement panel, injected into the core run-detail page.
 *
 * Degrades on purpose: with no API key it is a manual-entry form, which is the
 * behaviour the spec commits to, because GlockApps' API access is plan-gated
 * and cannot be assumed.
 */
export default function PlacementPanel({ runId, run }: PlacementPanelProps) {
  const [mode, setMode] = useState<'api' | 'manual'>('manual');
  const [reports, setReports] = useState<PlacementReport[]>([]);
  const [test, setTest] = useState<PlacementTest | null>(null);
  const [seeds, setSeeds] = useState<SeedRow[]>([]);
  const [senderAuth, setSenderAuth] = useState<SenderAuth | null>(null);
  const [filters, setFilters] = useState<FilterVerdict[]>([]);
  const [blocklists, setBlocklists] = useState<string[]>([]);
  // Results view filters. 'all' keeps the full set.
  const [providerFilter, setProviderFilter] = useState('all');
  const [placementFilter, setPlacementFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [form, setForm] = useState({
    provider: 'overall',
    inbox: '',
    tabs: '',
    spam: '',
    missing: '',
  });
  const [testIdInput, setTestIdInput] = useState('');
  // GlockApps hands back a correlation code when a test is created. The module
  // never sends, so the operator has to paste it into the campaign themselves.
  const [insertCode, setInsertCode] = useState<{ header: string; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await PlacementService.getPlacement(runId);
      setMode(res.mode);
      setReports(res.reports);
      setTest(res.test);
      setSeeds(res.seeds ?? []);
      setSenderAuth(res.sender_auth ?? null);
      setFilters(res.filters ?? []);
      setBlocklists(res.blocklists ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load placement');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleStart() {
    setBusy(true);
    try {
      const started = await PlacementService.startTest(runId, testIdInput.trim() || undefined);
      if (started.insert_header || started.insert_in_body) {
        setInsertCode({ header: started.insert_header ?? '', body: started.insert_in_body ?? '' });
      }
      toast.success(
        started.seeds_imported
          ? `Test linked; ${started.seeds_imported} seed addresses imported`
          : 'Placement test linked',
      );
      setTestIdInput('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start placement test');
    } finally {
      setBusy(false);
    }
  }

  async function handleManualSave() {
    const counts = {
      inbox: Number(form.inbox || 0),
      tabs: Number(form.tabs || 0),
      spam: Number(form.spam || 0),
      missing: Number(form.missing || 0),
    };
    if (Object.values(counts).some((n) => !Number.isInteger(n) || n < 0)) {
      toast.error('Counts must be non-negative whole numbers');
      return;
    }
    setBusy(true);
    try {
      await PlacementService.saveManual(runId, { provider: form.provider, ...counts });
      toast.success('Placement saved');
      setShowManual(false);
      setForm({ provider: 'overall', inbox: '', tabs: '', spam: '', missing: '' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save placement');
    } finally {
      setBusy(false);
    }
  }

  const seedProviders = Array.from(new Set(seeds.map((s) => s.provider))).sort();
  const visibleSeeds = seeds.filter((s) => {
    if (providerFilter !== 'all' && s.provider !== providerFilter) return false;
    if (placementFilter === 'all') return true;
    if (placementFilter === 'unknown') return s.placement === null;
    return s.placement === placementFilter;
  });

  if (loading) return null;

  const overall = reports.find((r) => r.provider === 'overall');
  const perProvider = reports.filter((r) => r.provider !== 'overall');

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-[var(--gray-12)]">Inbox placement</div>
          <p className="text-xs text-[var(--gray-11)] mt-1 max-w-2xl">
            Where the message landed at real providers, measured by GlockApps seed mailboxes. This
            is a different question from completion: a message can be delivered perfectly and still
            sit in spam.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge color={mode === 'api' ? 'green' : 'gray'}>{mode} mode</Badge>
          <Button size="sm" variant="outline" onClick={() => setShowManual(true)}>
            <PlusIcon className="h-4 w-4 mr-1" />
            Enter results
          </Button>
        </div>
      </div>

      {insertCode && (
        <div className="mt-3 rounded-md bg-[var(--amber-a3)] p-3 text-xs text-[var(--gray-12)] space-y-1">
          <p className="font-medium">Add this code to the campaign before sending</p>
          <p>
            GlockApps uses it to match the message to this test. This module never sends, so it
            cannot add the code for you.
          </p>
          {insertCode.header && (
            <p className="break-all">
              <span className="font-medium">Header:</span> <code>{insertCode.header}</code>
            </p>
          )}
          {insertCode.body && (
            <p className="break-all">
              <span className="font-medium">Or in the body:</span> <code>{insertCode.body}</code>
            </p>
          )}
        </div>
      )}

      {test?.state === 'failed' && (
        <div className="mt-3 rounded-md bg-[var(--amber-a3)] p-3 text-xs text-[var(--gray-12)] flex gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-[var(--amber-11)] shrink-0" />
          <div>
            <p className="font-medium">Automatic polling stopped</p>
            <p className="mt-0.5 break-words">{test.last_error}</p>
            <p className="mt-0.5">
              Read the numbers off the GlockApps dashboard and enter them here instead.
            </p>
          </div>
        </div>
      )}

      {reports.length === 0 ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-[var(--gray-11)]">
            No placement results yet.
            {mode === 'api'
              ? ' Link a GlockApps test and results will be polled automatically.'
              : ' Create the test in the GlockApps dashboard, then enter the results here.'}
          </p>
          <div className="flex gap-2 items-center">
            <input
              className={`${inputCls} max-w-xs`}
              placeholder="GlockApps test id (optional)"
              value={testIdInput}
              onChange={(e) => setTestIdInput(e.target.value)}
            />
            <Button size="sm" variant="outline" onClick={handleStart} disabled={busy}>
              {mode === 'api' && !testIdInput ? 'Start test' : 'Link test'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {overall && (
            <div className="grid grid-cols-4 gap-3">
              {(['inbox', 'tabs', 'spam', 'missing'] as const).map((field) => {
                const total = overall.inbox + overall.tabs + overall.spam + overall.missing;
                return (
                  <div key={field}>
                    <div className="text-xs uppercase tracking-wide text-[var(--gray-11)]">
                      {field}
                    </div>
                    <div className="text-xl font-semibold text-[var(--gray-12)]">
                      {share(overall[field], total)}
                    </div>
                    <div className="text-xs text-[var(--gray-11)]">{overall[field]} seeds</div>
                  </div>
                );
              })}
            </div>
          )}

          {perProvider.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--gray-11)]">
                  <th className="py-1 font-medium">Provider</th>
                  <th className="py-1 font-medium text-right">Inbox</th>
                  <th className="py-1 font-medium text-right">Tabs</th>
                  <th className="py-1 font-medium text-right">Spam</th>
                  <th className="py-1 font-medium text-right">Missing</th>
                  <th className="py-1 font-medium text-right">Source</th>
                </tr>
              </thead>
              <tbody>
                {perProvider.map((report) => (
                  <tr key={report.id} className="border-t border-[var(--gray-a5)]">
                    <td className="py-1 text-[var(--gray-12)] capitalize">
                      {report.provider.replace('_', '.')}
                    </td>
                    <td className="py-1 text-right text-[var(--gray-11)]">{report.inbox}</td>
                    <td className="py-1 text-right text-[var(--gray-11)]">{report.tabs}</td>
                    <td
                      className={`py-1 text-right ${report.spam > 0 ? 'text-[var(--red-11)] font-medium' : 'text-[var(--gray-11)]'}`}
                    >
                      {report.spam}
                    </td>
                    <td className="py-1 text-right text-[var(--gray-11)]">{report.missing}</td>
                    <td className="py-1 text-right text-[var(--gray-11)] text-xs">
                      {report.entered_via}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {(senderAuth || filters.length > 0 || blocklists.length > 0 || seeds.length > 0) && (
        <div className="mt-5 space-y-4 border-t border-[var(--gray-a5)] pt-4">

          {senderAuth && (
            <div>
              <div className="text-sm font-medium text-[var(--gray-12)]">Sender authentication</div>
              <p className="text-xs text-[var(--gray-11)] mt-0.5">
                How the receiving providers saw this send. Everything here is reported by GlockApps,
                so it reflects the real message rather than the synthetic arrivals.
              </p>
              <div className="grid gap-x-6 gap-y-1 mt-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {([
                  ['SPF', senderAuth.spfAuth],
                  ['DKIM', senderAuth.dkimAuth],
                  ['DMARC', senderAuth.dmarcAuth],
                  ['Sender IP', senderAuth.senderIp],
                  ['Reverse DNS', senderAuth.rdns],
                  ['rDNS status', senderAuth.rdnsStatus],
                  ['HELO', senderAuth.helo],
                  ['Return-path', senderAuth.returnPath],
                  ['Sender score', senderAuth.senderScore === null ? null : String(senderAuth.senderScore)],
                  ['ISP', senderAuth.isp],
                  ['BIMI', senderAuth.bimi],
                ] as [string, string | null][])
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-3 border-b border-[var(--gray-a3)] py-0.5">
                      <span className="text-[var(--gray-11)]">{label}</span>
                      <span
                        className={`text-right break-all ${
                          value === 'pass'
                            ? 'text-[var(--green-11)]'
                            : value === 'fail'
                              ? 'text-[var(--red-11)] font-medium'
                              : 'text-[var(--gray-12)]'
                        }`}
                      >
                        {value}
                      </span>
                    </div>
                  ))}
              </div>
              {senderAuth.dmarcRecord && (
                <p className="text-xs text-[var(--gray-11)] mt-2 break-all">
                  <span className="font-medium">DMARC record:</span> <code>{senderAuth.dmarcRecord}</code>
                </p>
              )}
            </div>
          )}

          {filters.length > 0 && (
            <div>
              <div className="text-sm font-medium text-[var(--gray-12)]">Spam filters</div>
              <div className="flex flex-wrap gap-2 mt-2">
                {filters.map((f) => (
                  <span
                    key={f.name}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                      f.verdict === 'spam'
                        ? 'border-[var(--red-7)] bg-[var(--red-a3)] text-[var(--red-11)]'
                        : f.verdict === 'pass'
                          ? 'border-[var(--green-7)] bg-[var(--green-a3)] text-[var(--green-11)]'
                          : 'border-[var(--gray-7)] bg-[var(--gray-a3)] text-[var(--gray-11)]'
                    }`}
                  >
                    <span className="font-medium">{f.name}</span>
                    <span>{f.verdict}</span>
                    {f.score !== null && <span>({f.score})</span>}
                    {f.detail && <span className="text-[var(--gray-11)]">{f.detail}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {blocklists.length > 0 && (
            <div className="rounded-md bg-[var(--red-a3)] p-3 text-xs text-[var(--gray-12)]">
              <span className="font-medium">Listed on {blocklists.length} blocklist(s):</span>{' '}
              {blocklists.join(', ')}
            </div>
          )}

          {seeds.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-medium text-[var(--gray-12)]">
                  Seed mailboxes
                  <span className="text-[var(--gray-11)] font-normal">
                    {' '}({visibleSeeds.length} of {seeds.length})
                  </span>
                </div>
                <div className="flex gap-2">
                  <select
                    aria-label="Filter by provider"
                    className={`${inputCls} w-auto py-1 text-xs`}
                    value={providerFilter}
                    onChange={(e) => setProviderFilter(e.target.value)}
                  >
                    <option value="all">All providers</option>
                    {seedProviders.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter by placement"
                    className={`${inputCls} w-auto py-1 text-xs`}
                    value={placementFilter}
                    onChange={(e) => setPlacementFilter(e.target.value)}
                  >
                    <option value="all">All placements</option>
                    <option value="inbox">Inbox</option>
                    <option value="tabs">Tabs</option>
                    <option value="spam">Spam</option>
                    <option value="missing">Missing</option>
                    <option value="unknown">Unrecognised</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto mt-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-[var(--gray-11)]">
                      <th className="py-1 font-medium">Seed</th>
                      <th className="py-1 font-medium">Provider</th>
                      <th className="py-1 font-medium">Placement</th>
                      <th className="py-1 font-medium">SPF</th>
                      <th className="py-1 font-medium">DKIM</th>
                      <th className="py-1 font-medium">DMARC</th>
                      <th className="py-1 font-medium text-right">Delivered in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSeeds.map((seed) => (
                      <tr key={seed.email} className="border-t border-[var(--gray-a5)]">
                        <td className="py-1 text-[var(--gray-12)] break-all">{seed.email}</td>
                        <td className="py-1 text-[var(--gray-11)]">{seed.provider}</td>
                        <td className="py-1">
                          <span
                            className={
                              seed.placement === 'spam'
                                ? 'text-[var(--red-11)] font-medium'
                                : seed.placement === 'inbox'
                                  ? 'text-[var(--green-11)]'
                                  : 'text-[var(--gray-11)]'
                            }
                          >
                            {seed.placementLabel || seed.placement || 'unknown'}
                          </span>
                        </td>
                        {([seed.spf, seed.dkim, seed.dmarc] as (string | null)[]).map((v, i) => (
                          <td
                            key={i}
                            className={`py-1 ${v === 'fail' ? 'text-[var(--red-11)] font-medium' : 'text-[var(--gray-11)]'}`}
                          >
                            {v ?? '—'}
                          </td>
                        ))}
                        <td className="py-1 text-right text-[var(--gray-11)] tabular-nums">
                          {seed.deliveredIn === null ? '—' : `${seed.deliveredIn}s`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {visibleSeeds.length === 0 && (
                <p className="text-sm text-[var(--gray-11)] mt-2">No seeds match those filters.</p>
              )}
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={showManual}
        onClose={() => setShowManual(false)}
        title="Enter placement results"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setShowManual(false)}>
              Cancel
            </Button>
            <Button variant="solid" onClick={handleManualSave} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-11)]">
            Copy the per-provider counts from the GlockApps dashboard. Saving the same provider
            again replaces its row; automatic results overwrite manual ones.
          </p>
          <label className="block text-sm">
            <span className="text-[var(--gray-11)]">Provider</span>
            <select
              className={inputCls}
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-4 gap-2">
            {(['inbox', 'tabs', 'spam', 'missing'] as const).map((field) => (
              <label key={field} className="block text-sm">
                <span className="text-[var(--gray-11)] capitalize">{field}</span>
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={form[field]}
                  onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </div>
      </Modal>
    </Card>
  );
}
