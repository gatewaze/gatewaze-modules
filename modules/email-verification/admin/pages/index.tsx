/**
 * Email Verification — how many addresses are checked, what was found, which
 * paid providers are on and how much of today's limit they have used, and a
 * lookup for one address.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { WorkspaceLayout, Card, Button, Input } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { REASON_LABEL, STATUS_LABEL, formatCount, percent } from '../../lib/labels';

interface Summary {
  people: number;
  checked: number;
  waiting_for_dns: number;
  by_status: Record<string, number>;
  by_reason: Array<{ status: string; reason: string; count: number }>;
  by_level: Record<string, number>;
  by_mailbox_provider: Record<string, number>;
  prospects: { total: number; by_status: Record<string, number> };
}

interface VerificationRow {
  email: string;
  status: string | null;
  reason: string | null;
  level: string | null;
  decided_by: string | null;
  mailbox_provider: string | null;
  suggestion: string | null;
  checked_at: string | null;
  next_check_at: string;
}

interface ProviderResultRow {
  id: number;
  provider: string;
  purpose: string;
  status: string | null;
  reason: string | null;
  error_kind: string | null;
  error: string | null;
  created_at: string;
}

interface ProviderModule { id: string; status: string }

const STATUS_TONE: Record<string, string> = {
  valid: 'text-[var(--green-11)]',
  risky: 'text-[var(--amber-11)]',
  invalid: 'text-[var(--red-11)]',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-[var(--gray-11)]">{label}</div>
      <div className="text-2xl font-semibold text-[var(--gray-12)] mt-1">{value}</div>
      {note && <div className="text-xs text-[var(--gray-10)] mt-1">{note}</div>}
    </Card>
  );
}

export default function EmailVerificationPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [providers, setProviders] = useState<ProviderModule[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [dailyLimit, setDailyLimit] = useState<number>(500);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ row: VerificationRow | null; results: ProviderResultRow[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // Provider settings hold API keys, so only their id and status are read.
    const [{ data: s, error: sErr }, { data: core }, { data: mods }, { data: u }] = await Promise.all([
      supabase.rpc('email_verification_summary'),
      supabase.from('installed_modules').select('config').eq('id', 'email-verification').maybeSingle(),
      supabase.from('installed_modules').select('id, status').like('id', 'email-verification-%'),
      supabase.from('email_verification_usage').select('provider, checks').eq('day', new Date().toISOString().slice(0, 10)),
    ]);
    if (sErr) toast.error(sErr.message);
    setSummary((s ?? null) as Summary | null);
    const raw = (core?.config as Record<string, unknown> | null)?.daily_paid_limit;
    const limit = Number(raw);
    setDailyLimit(raw !== undefined && raw !== null && raw !== '' && Number.isFinite(limit) ? limit : 500);
    setProviders((mods ?? []) as ProviderModule[]);
    setUsage(Object.fromEntries(((u ?? []) as Array<{ provider: string; checks: number }>).map((r) => [r.provider, r.checks])));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault();
    const email = query.trim().toLowerCase();
    if (!email) return;
    const [{ data: row, error }, { data: results }] = await Promise.all([
      supabase.from('email_verifications').select('*').eq('email', email).maybeSingle(),
      supabase.from('email_verification_provider_results')
        .select('id, provider, purpose, status, reason, error_kind, error, created_at')
        .eq('email', email).order('created_at', { ascending: false }).limit(20),
    ]);
    if (error) { toast.error(error.message); return; }
    setFound({ row: (row ?? null) as VerificationRow | null, results: (results ?? []) as ProviderResultRow[] });
  };

  const recheck = async () => {
    if (!found?.row) return;
    const { error } = await supabase.rpc('email_verification_request_recheck', { p_email: found.row.email });
    if (error) { toast.error(error.message); return; }
    toast.success('It will be checked again within 5 minutes.');
  };

  const lift = async () => {
    if (!found?.row) return;
    if (!window.confirm(`Let broadcasts send to ${found.row.email} again? Only do this if you know the address works.`)) return;
    const { data, error } = await supabase.rpc('email_verification_lift_suppression', { p_email: found.row.email });
    if (error) { toast.error(error.message); return; }
    toast.success(Number(data) > 0 ? 'Broadcasts can send to this address again.' : 'This module had not suppressed this address.');
  };

  const requeue = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('email_verification_requeue_domain_level');
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`${formatCount(Number(data ?? 0))} addresses will get a mailbox check, within the daily limit.`);
  };

  const enabledProviders = providers.filter((p) => p.status === 'enabled');
  const usedToday = Object.values(usage).reduce((a, b) => a + b, 0);
  const s = summary;

  return (
    <Page title="Email Verification">
      <WorkspaceLayout title="Email Verification">
        {loading ? (
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>
        ) : !s ? (
          <p className="py-12 text-sm text-[var(--gray-11)]">The summary could not be loaded.</p>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-[var(--gray-11)] max-w-3xl">
              Every address is checked for format, common typos, disposable domains and whether its domain takes mail.
              Enabled provider modules also check the mailbox itself. Results are on each person as{' '}
              <code>email_check</code> (valid, risky or invalid) and <code>email_provider</code>, for segments.
              Invalid addresses and hard bounces are kept out of broadcasts.
            </p>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Stat label="Checked" value={formatCount(s.checked)} note={`of ${formatCount(s.people)} addresses (${percent(s.checked, s.people)})`} />
              {(['valid', 'risky', 'invalid'] as const).map((k) => (
                <Stat key={k} label={STATUS_LABEL[k]} value={formatCount(s.by_status[k] ?? 0)} note={percent(s.by_status[k] ?? 0, s.checked)} />
              ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-6">
              <Card className="p-4">
                <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Prospects</h2>
                {s.prospects.total === 0 ? (
                  <p className="text-sm text-[var(--gray-11)]">No prospects yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {(['valid', 'risky', 'invalid', 'unchecked'] as const).map((k) => (
                        <tr key={k} className="border-t border-[var(--gray-a4)] first:border-t-0">
                          <td className="py-1.5 text-[var(--gray-11)]">{k === 'unchecked' ? 'Not checked yet' : STATUS_LABEL[k]}</td>
                          <td className="py-1.5 text-right tabular-nums text-[var(--gray-12)]">{formatCount(s.prospects.by_status[k] ?? 0)}</td>
                          <td className="py-1.5 text-right tabular-nums text-[var(--gray-10)] w-16">{percent(s.prospects.by_status[k] ?? 0, s.prospects.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card className="p-4">
                <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Who runs the inbox</h2>
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(s.by_mailbox_provider).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                      <tr key={k} className="border-t border-[var(--gray-a4)] first:border-t-0">
                        <td className="py-1.5 text-[var(--gray-11)] capitalize">{k}</td>
                        <td className="py-1.5 text-right tabular-nums text-[var(--gray-12)]">{formatCount(v)}</td>
                        <td className="py-1.5 text-right tabular-nums text-[var(--gray-10)] w-16">{percent(v, s.checked)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-[var(--gray-10)] mt-2">From each domain&apos;s MX records, so company domains on Google Workspace count as Google.</p>
              </Card>
            </div>

            <Card className="p-4">
              <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Why</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--gray-10)]">
                    <th className="pb-2 font-normal">Result</th>
                    <th className="pb-2 font-normal">Reason</th>
                    <th className="pb-2 font-normal text-right">Addresses</th>
                  </tr>
                </thead>
                <tbody>
                  {s.by_reason.map((r) => (
                    <tr key={`${r.status}:${r.reason}`} className="border-t border-[var(--gray-a4)]">
                      <td className={`py-1.5 ${STATUS_TONE[r.status] ?? ''}`}>{STATUS_LABEL[r.status] ?? r.status}</td>
                      <td className="py-1.5 text-[var(--gray-11)]">{REASON_LABEL[r.reason] ?? r.reason}</td>
                      <td className="py-1.5 text-right tabular-nums text-[var(--gray-12)]">{formatCount(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-[var(--gray-10)] mt-2">
                Domain-level results: {formatCount(s.by_level.domain ?? 0)}. Mailbox checks: {formatCount(s.by_level.mailbox ?? 0)}.
                Hard bounces: {formatCount(s.by_level.delivery ?? 0)}.
                {s.waiting_for_dns > 0 && ` Waiting for DNS to answer: ${formatCount(s.waiting_for_dns)}.`}
              </p>
            </Card>

            <Card className="p-4">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--gray-12)]">Paid providers</h2>
                  <p className="text-xs text-[var(--gray-10)] mt-1">
                    {formatCount(usedToday)} of {formatCount(dailyLimit)} paid checks used today (UTC). Set the order, escalation and compare providers in this module&apos;s settings.
                  </p>
                </div>
                {enabledProviders.length > 0 && (
                  <Button variant="outlined" onClick={() => void requeue()} disabled={busy}>
                    {busy ? 'Queuing…' : 'Give domain-level results a mailbox check'}
                  </Button>
                )}
              </div>
              {providers.length === 0 ? (
                <p className="text-sm text-[var(--gray-11)]">
                  None installed. The free checks run on their own. Enable a module such as Email Verification: Debounce to check mailboxes too.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {providers.map((p) => (
                      <tr key={p.id} className="border-t border-[var(--gray-a4)] first:border-t-0">
                        <td className="py-1.5 text-[var(--gray-12)]">{p.id.replace('email-verification-', '')}</td>
                        <td className="py-1.5 text-[var(--gray-11)]">{p.status === 'enabled' ? 'Enabled' : 'Disabled'}</td>
                        <td className="py-1.5 text-right tabular-nums text-[var(--gray-12)]">{formatCount(usage[p.id] ?? 0)} today</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Look up an address</h2>
              <form onSubmit={(e) => void lookup(e)} className="flex gap-2 max-w-xl">
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="name@company.com" type="email" />
                <Button type="submit" variant="solid">Look up</Button>
              </form>
              {found && (
                <div className="mt-4 text-sm space-y-3">
                  {!found.row ? (
                    <p className="text-[var(--gray-11)]">Not checked yet.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                        <span className={`font-medium ${STATUS_TONE[found.row.status ?? ''] ?? 'text-[var(--gray-11)]'}`}>
                          {found.row.status ? STATUS_LABEL[found.row.status] : 'Waiting for DNS'}
                        </span>
                        {found.row.reason && <span className="text-[var(--gray-11)]">{REASON_LABEL[found.row.reason] ?? found.row.reason}</span>}
                        {found.row.suggestion && <span className="text-[var(--gray-11)]">Did they mean {found.row.suggestion}?</span>}
                        <span className="text-[var(--gray-10)]">Checked {when(found.row.checked_at)} by {found.row.decided_by ?? '—'}</span>
                        <span className="text-[var(--gray-10)]">Next check {when(found.row.next_check_at)}</span>
                        <Button variant="outlined" onClick={() => void recheck()}>Check again</Button>
                        {found.row.status === 'invalid' && (
                          <Button variant="outlined" onClick={() => void lift()}>Allow broadcasts again</Button>
                        )}
                      </div>
                      {found.results.length > 0 && (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-[var(--gray-10)]">
                              <th className="pb-1 font-normal">When</th>
                              <th className="pb-1 font-normal">Provider</th>
                              <th className="pb-1 font-normal">Why asked</th>
                              <th className="pb-1 font-normal">Answer</th>
                            </tr>
                          </thead>
                          <tbody>
                            {found.results.map((r) => (
                              <tr key={r.id} className="border-t border-[var(--gray-a4)]">
                                <td className="py-1 text-[var(--gray-11)]">{when(r.created_at)}</td>
                                <td className="py-1 text-[var(--gray-12)]">{r.provider.replace('email-verification-', '')}</td>
                                <td className="py-1 text-[var(--gray-11)]">{r.purpose}</td>
                                <td className="py-1 text-[var(--gray-11)]">
                                  {r.status ? `${STATUS_LABEL[r.status] ?? r.status}, ${REASON_LABEL[r.reason ?? ''] ?? r.reason}` : `Error (${r.error_kind}): ${r.error ?? ''}`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}
      </WorkspaceLayout>
    </Page>
  );
}
