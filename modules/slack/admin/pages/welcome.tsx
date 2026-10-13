import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowPathIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, CopyButton, Input, Select, Switch, Textarea } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { Page } from '@/components/shared/Page';
import {
  slackWelcome, type MemberSyncStatus, type PeopleSyncMode, type WelcomeLogRow, type WelcomeStatus,
} from '@/utils/slackWelcomeService';

/**
 * Slack welcome DM: when someone joins the workspace, a message goes to them
 * from a real person's account (replacing the old make.com scenario).
 *
 * Every hook sits above the single early return (see .claude/rules/react-patterns.md).
 */

const STATUS_COLOR: Record<WelcomeLogRow['status'], 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
  sent: 'success',
  pending: 'info',
  sending: 'info',
  failed: 'error',
  skipped: 'neutral',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const RESULT_LABELS: Record<string, string> = {
  created: 'people created',
  updated: 'people updated',
  unchanged: 'already up to date',
  unmatched: 'no matching person',
  no_email: 'no email visible',
  invalid: 'invalid',
};

/**
 * Slack members in People: each member's Slack user ID is written onto the
 * person with the same email (attributes.slack_user_id), on join and by a
 * full sync. Self-contained: its own state, and it polls while a sync runs.
 */
function MembersSyncCard() {
  const [data, setData] = useState<MemberSyncStatus | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [savingMode, setSavingMode] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await slackWelcome.membersSync());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const latest = data?.runs[0];
  const running = latest?.status === 'queued' || latest?.status === 'running';

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [running, load]);

  const changeMode = async (mode: PeopleSyncMode) => {
    setSavingMode(true);
    try {
      await slackWelcome.savePeopleSync(mode);
      toast.success('Saved.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSavingMode(false);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await slackWelcome.startMembersSync();
      toast.success('Sync started. It takes about a minute per 4,000 members.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the sync');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card skin="bordered" className="p-5 space-y-4">
      <h2 className="text-lg font-medium">Slack members in People</h2>
      <p className="text-sm text-[var(--gray-11)]">
        Each member&apos;s Slack user ID is added to the person with the same email, as{' '}
        <code>slack_user_id</code>. This happens when someone joins; a full sync covers everyone already in the workspace.
      </p>
      {error && <p className="text-sm text-[var(--red-11)]">Could not load: {error}</p>}
      {data && (
        <>
          <div className="max-w-sm">
            <Select
              label="When a member has no matching person"
              value={data.mode}
              disabled={savingMode}
              onChange={(e) => changeMode(e.target.value as PeopleSyncMode)}
            >
              <option value="off">Do nothing (linking off)</option>
              <option value="link">Link existing people only</option>
              <option value="create">Create a person for them</option>
            </Select>
          </div>
          <p className="text-sm">
            {data.linked_people == null ? '' : `${data.linked_people.toLocaleString()} people have a Slack user ID.`}
          </p>
          <div className="flex items-center gap-3">
            <Button onClick={start} disabled={starting || running || data.mode === 'off'}>
              {running ? 'Sync running…' : starting ? 'Starting…' : 'Sync all members now'}
            </Button>
            {running && <Spinner />}
          </div>
          {latest && (
            <div className="text-sm space-y-1">
              <div>
                Last sync: <Badge variant="soft" color={latest.status === 'failed' ? 'error' : latest.status === 'done' ? 'success' : 'info'}>{latest.status}</Badge>{' '}
                {latest.status === 'done' || latest.status === 'failed' ? `finished ${fmt(latest.finished_at)}` : `started ${fmt(latest.started_at || latest.created_at)}`}
                {' · '}{latest.members_seen.toLocaleString()} members checked ({latest.mode === 'create' ? 'creating missing people' : 'linking only'})
              </div>
              {Object.keys(latest.results || {}).length > 0 && (
                <div className="text-[var(--gray-11)]">
                  {Object.entries(latest.results)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => `${n.toLocaleString()} ${RESULT_LABELS[k] || k}`)
                    .join(' · ')}
                </div>
              )}
              {latest.error && <div className="text-[var(--red-11)]">{latest.error}</div>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function SetupItem({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CheckCircleIcon : XCircleIcon;
  return (
    <li className="flex items-center gap-2 text-sm">
      <Icon className={`w-4 h-4 ${ok ? 'text-[var(--green-11)]' : 'text-[var(--red-11)]'}`} />
      <span className={ok ? '' : 'text-[var(--red-11)]'}>{label}</span>
    </li>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <div className="text-[var(--gray-11)] mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-[var(--gray-a3)] px-2 py-1">{value}</code>
        <CopyButton value={value}>
          {({ copy, copied }) => (
            <Button variant="outlined" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          )}
        </CopyButton>
      </div>
    </div>
  );
}

export default function SlackWelcomePage() {
  const [status, setStatus] = useState<WelcomeStatus | null>(null);
  const [rows, setRows] = useState<WelcomeLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [delay, setDelay] = useState('5');
  const [saving, setSaving] = useState(false);

  const [senderEmail, setSenderEmail] = useState('');
  const [link, setLink] = useState<{ url: string; name: string; expires: string } | null>(null);
  const [linking, setLinking] = useState(false);

  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([slackWelcome.status(), slackWelcome.log()]);
      setStatus(s);
      setRows(l.rows);
      setEnabled(s.settings.enabled);
      setMessage(s.settings.message);
      setDelay(String(s.settings.delay_minutes));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const minutes = Number(delay);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      toast.error('The delay must be between 0 and 1440 minutes.');
      return;
    }
    setSaving(true);
    try {
      await slackWelcome.saveSettings({ enabled, message, delay_minutes: minutes });
      toast.success(enabled ? 'Saved — welcome DMs are on.' : 'Saved — welcome DMs are off.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const createLink = async () => {
    setLinking(true);
    setLink(null);
    try {
      const r = await slackWelcome.connectLink(senderEmail);
      setLink({ url: r.authorize_url, name: r.for.name, expires: r.expires_at });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the link');
    } finally {
      setLinking(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await slackWelcome.disconnect();
      toast.success('Disconnected. No welcome DMs will be sent until someone is connected again.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await slackWelcome.test(testEmail, message);
      toast.success(`Test sent to ${r.to} from ${r.from}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const retry = async (includeFailed: boolean) => {
    setBusy(true);
    try {
      const r = await slackWelcome.retry(includeFailed);
      toast.success(`${r.queued} welcome${r.queued === 1 ? '' : 's'} queued.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not retry');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Page title="Slack welcome DM">
        <div className="flex items-center justify-center min-h-[400px]"><Spinner size="lg" /></div>
      </Page>
    );
  }

  const setup = status?.setup;
  const setupComplete = !!setup && Object.values(setup).every(Boolean);
  const sender = status?.sender ?? null;
  const counts = status?.last_30_days ?? {};

  return (
    <Page title="Slack welcome DM">
      <div className="p-6 space-y-6 max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Slack welcome DM</h1>
            <p className="text-[var(--gray-11)] mt-1">
              When someone joins the workspace, a welcome message goes to them as a DM from a real person&apos;s account.
            </p>
            <Link to="/slack/invitations" className="text-sm text-[var(--accent-11)]">← Slack invitations</Link>
          </div>
          <Button variant="outlined" isIcon onClick={() => load()} disabled={busy}>
            <ArrowPathIcon className="w-5 h-5" />
          </Button>
        </div>

        {loadError && (
          <Card skin="bordered" className="p-4 text-[var(--red-11)]">Could not load: {loadError}</Card>
        )}

        {status && (
          <Card skin="bordered" className="p-5 space-y-4">
            <h2 className="text-lg font-medium">Setup {setupComplete && <Badge variant="soft" color="success">complete</Badge>}</h2>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-1">
              <SetupItem ok={status.setup.client_id} label="Slack app client ID" />
              <SetupItem ok={status.setup.client_secret} label="Slack app client secret" />
              <SetupItem ok={status.setup.signing_secret} label="Slack app signing secret" />
              <SetupItem ok={status.setup.bot_token} label="Slack bot token" />
              <SetupItem ok={status.setup.secrets_key} label="Server encryption key" />
              <SetupItem ok={status.setup.api_url} label="Public API URL" />
            </ul>
            <p className="text-sm text-[var(--gray-11)]">
              In the Slack app settings: subscribe the bot to the <code>team_join</code> event at the first URL, add the
              second as an OAuth redirect URL, and add the user token scopes {status.user_scopes.map((s) => <code key={s} className="mx-1">{s}</code>)}.
            </p>
            <CopyRow label="Event Subscriptions → Request URL" value={status.urls.events} />
            <CopyRow label="OAuth & Permissions → Redirect URL" value={status.urls.redirect} />
          </Card>
        )}

        <Card skin="bordered" className="p-5 space-y-4">
          <h2 className="text-lg font-medium">Sender</h2>
          {sender ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium">
                  {sender.slack_user_name || sender.slack_user_id}{' '}
                  <Badge variant="soft" color={sender.status === 'connected' ? 'success' : 'error'}>{sender.status}</Badge>
                </div>
                <div className="text-sm text-[var(--gray-11)]">
                  Connected {fmt(sender.connected_at)}
                  {sender.status_detail ? ` · ${sender.status_detail}` : ''}
                </div>
              </div>
              <Button variant="outlined" color="error" onClick={disconnect} disabled={busy}>Disconnect</Button>
            </div>
          ) : (
            <p className="text-sm text-[var(--gray-11)]">Nobody is connected, so no welcome DMs are sent.</p>
          )}
          <div className="space-y-2">
            <p className="text-sm text-[var(--gray-11)]">
              {sender ? 'To change or reconnect the sender, create' : 'Create'} a link for the person the DMs should come
              from. They open it while signed in to Slack as themselves; it only works for that account.
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="Their Slack email address" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} placeholder="name@example.com" />
              </div>
              <Button color="primary" onClick={createLink} disabled={linking || !senderEmail}>
                {linking ? 'Creating…' : 'Create link'}
              </Button>
            </div>
            {link && (
              <div className="space-y-2 text-sm">
                <p>
                  Copy this link and open it in the browser (or browser profile) where you are signed in to Slack
                  as <strong>{link.name}</strong>. It is not sent anywhere, and it only works for that account.
                  Valid until {fmt(link.expires)}.
                </p>
                <code className="block select-all break-all rounded bg-[var(--gray-a3)] px-2 py-1">{link.url}</code>
                <div className="flex justify-end">
                  <CopyButton value={link.url}>
                    {({ copy, copied }) => (
                      <Button variant="outlined" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
                    )}
                  </CopyButton>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card skin="bordered" className="p-5 space-y-4">
          <h2 className="text-lg font-medium">Message</h2>
          <Switch label="Send a welcome DM to new members" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <Textarea
            label="Message"
            rows={6}
            maxLength={4000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <p className="text-xs text-[var(--gray-11)]">
            <code>{'{first_name}'}</code> and <code>{'{name}'}</code> are filled in from the new member&apos;s Slack profile.
          </p>
          <div className="max-w-xs">
            <Input label="Wait before sending (minutes)" type="number" min={0} max={1440} value={delay} onChange={(e) => setDelay(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button color="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
          <div className="border-t border-[var(--gray-a5)] pt-4 space-y-2">
            <p className="text-sm text-[var(--gray-11)]">Send the message above to one person now, from the connected sender. Nothing is recorded.</p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="Send a test to (Slack email)" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <Button variant="outlined" onClick={sendTest} disabled={testing || !testEmail || !sender}>
                {testing ? 'Sending…' : 'Send test'}
              </Button>
            </div>
          </div>
        </Card>

        <MembersSyncCard />

        <Card skin="bordered" className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-medium">Recent joins</h2>
            <div className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
              <span>Last 30 days: {counts.sent || 0} sent · {counts.skipped || 0} skipped · {counts.failed || 0} failed · {(counts.pending || 0) + (counts.sending || 0)} waiting</span>
              <Button variant="outlined" onClick={() => retry(false)} disabled={busy}>Retry waiting</Button>
              <Button variant="outlined" onClick={() => retry(true)} disabled={busy}>Retry failed</Button>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-[var(--gray-11)]">No joins recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[var(--gray-11)]">
                  <tr>
                    <th className="py-2 pr-4">Joined</th>
                    <th className="py-2 pr-4">Member</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Detail</th>
                    <th className="py-2">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--gray-a4)]">
                      <td className="py-2 pr-4 whitespace-nowrap">{fmt(r.joined_at)}</td>
                      <td className="py-2 pr-4">
                        <div>{r.display_name || r.first_name || r.slack_user_id}</div>
                        {r.email && <div className="text-xs text-[var(--gray-11)]">{r.email}</div>}
                      </td>
                      <td className="py-2 pr-4"><Badge variant="soft" color={STATUS_COLOR[r.status]}>{r.status}</Badge></td>
                      <td className="py-2 pr-4 text-xs text-[var(--gray-11)]">{r.skip_reason || r.error || ''}</td>
                      <td className="py-2 whitespace-nowrap">{fmt(r.sent_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
