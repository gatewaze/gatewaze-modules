/**
 * YouTube channels: the OAuth client, and the channels connected through it.
 *
 * One OAuth client per deployment, many channels. Connecting opens Google's
 * consent screen in a new tab; the channel picked there is the one stored.
 * Everything here talks to super_admin-only routes.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowPathIcon, PlusIcon } from '@heroicons/react/24/outline';

import { Badge, Button, Card, Input, WorkspaceLayout } from '@/components/ui';

import {
  disconnectYouTubeChannel,
  syncYouTubeChannel,
  getYouTubeSettings,
  listYouTubeConnections,
  saveYouTubeSettings,
  startYouTubeConnect,
  type YouTubeClientSettings,
  type YouTubeConnection,
} from '../utils/youtubePublisherService';

const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

// video_platform_connections.state: disconnected | connected | needs_reauth | revoked.
function stateColor(state: string): 'green' | 'red' | 'amber' | 'gray' {
  if (state === 'connected') return 'green';
  if (state === 'revoked') return 'red';
  if (state === 'needs_reauth') return 'amber';
  return 'gray';
}

export default function YouTubeChannels() {
  const [settings, setSettings] = useState<YouTubeClientSettings | null>(null);
  const [connections, setConnections] = useState<YouTubeConnection[]>([]);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'connect' | 'disconnect' | 'sync' | null>('load');
  // Loaded separately, so one failing call does not blank the other card, and
  // so "loading" and "failed" are never shown as "not configured" or "none".
  const [settingsState, setSettingsState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [connectionsState, setConnectionsState] = useState<'loading' | 'error' | 'ready'>('loading');

  const load = useCallback(async () => {
    setBusy('load');
    setSettingsState('loading');
    setConnectionsState('loading');
    await Promise.all([
      getYouTubeSettings()
        .then((s) => {
          setSettings(s);
          setClientId(s.clientId);
          setSettingsState('ready');
        })
        .catch((err) => {
          setSettingsState('error');
          toast.error(err instanceof Error ? err.message : 'Could not load the YouTube settings');
        }),
      listYouTubeConnections()
        .then((c) => {
          setConnections(c);
          setConnectionsState('ready');
        })
        .catch((err) => {
          setConnectionsState('error');
          toast.error(err instanceof Error ? err.message : 'Could not load the connected channels');
        }),
    ]);
    setBusy(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const id = clientId.trim();
    if (!CLIENT_ID_RE.test(id)) return toast.error('The client ID ends in .apps.googleusercontent.com');
    if (!settings?.clientSecretSet && !clientSecret.trim()) return toast.error('Paste the client secret too');
    setBusy('save');
    try {
      await saveYouTubeSettings({ clientId: id, ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) });
      setClientSecret('');
      toast.success('Saved');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    // Open the tab synchronously so the popup blocker treats it as a click,
    // then point it at Google once the one-time URL arrives.
    const tab = window.open('about:blank', '_blank');
    setBusy('connect');
    try {
      const r = await startYouTubeConnect();
      if (tab) {
        tab.opener = null;
        tab.location.href = r.authorize_url;
      } else {
        window.location.href = r.authorize_url;
      }
      toast.success('Pick the channel in the Google tab, then come back and refresh this list.');
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error ? err.message : 'Could not start the connection');
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (c: YouTubeConnection) => {
    const name = c.label ?? c.external_account_id;
    if (!window.confirm(`Disconnect ${name}? Gatewaze stops reading its uploads and statistics, and its access is revoked at Google. Videos already discovered and their history are kept. You can connect it again at any time.`)) return;
    setBusy('disconnect');
    try {
      const r = await disconnectYouTubeChannel(c.id);
      toast.success(r.revoked === false
        ? `${name} disconnected, but Google did not confirm the revoke. It stays listed below until you remove the app from the channel account's third-party access.`
        : `${name} disconnected`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  };

  const sync = async (c: YouTubeConnection) => {
    setBusy('sync');
    try {
      await syncYouTubeChannel(c.id);
      toast.success(`Sync of ${c.label ?? c.external_account_id} queued. Its uploads appear under Unassigned videos over the next few minutes.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue the sync');
    } finally {
      setBusy(null);
    }
  };

  // Disconnected rows are kept for their history but not shown as channels,
  // except one whose revoke Google never confirmed: its grant may still be
  // live, so it stays visible with what to do about it.
  const shown = connections.filter((c) => c.state !== 'disconnected' || c.needs_manual_revoke);
  const configured = Boolean(settings?.clientId && settings.clientSecretSet && settings.clientSecretReadable);

  return (
    <WorkspaceLayout title="YouTube channels">
      <p className="text-sm text-muted-foreground mb-4">
        Connect the YouTube channels Gatewaze reads uploads and statistics from, and publishes to. Each connected
        channel&apos;s uploads are discovered every morning and appear under Videos.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Google OAuth client</h2>
            <p className="text-sm text-muted-foreground mt-1">
              From the Google Cloud console, APIs &amp; Services, Credentials: an OAuth 2.0 client of type
              &quot;Web application&quot;. The project needs the YouTube Data API v3 and the YouTube Analytics API
              enabled, and this redirect URI registered on the client:
            </p>
            <code className="mt-2 block break-all rounded bg-muted px-2 py-1 text-xs">
              {settingsState === 'loading'
                ? 'Loading…'
                : settingsState === 'error'
                  ? 'Could not load the settings. Refresh to try again.'
                  : settings?.redirectUri ?? 'API_URL is not set on the API, so the redirect URI cannot be built'}
            </code>
          </div>
          <label className="block text-sm">
            <span className="font-medium">Client ID</span>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789-abc.apps.googleusercontent.com"
              // Not a login: keep browser and password-manager autofill out.
              name="gw-youtube-oauth-client-id"
              autoComplete="off"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              className="mt-1 font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Client secret</span>
            <Input
              type="password"
              // "new-password" is the value browsers honour for "do not fill
              // a saved login here"; "off" alone is ignored on password fields.
              name="gw-youtube-oauth-client-secret"
              autoComplete="new-password"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={settings?.clientSecretSet ? 'Stored. Leave blank to keep it.' : 'Paste the client secret'}
              className="mt-1 font-mono"
            />
          </label>
          {settings?.clientSecretSet && !settings.clientSecretReadable && (
            <p className="text-sm text-red-600">
              The stored secret can no longer be decrypted (the server&apos;s secrets key has changed). Paste it again.
            </p>
          )}
          <Button onClick={save} disabled={busy !== null || settingsState !== 'ready'}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </Card>

        <Card className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">Connected channels</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Connect opens Google in a new tab. Sign in as someone who manages the channel and pick it in the
                account chooser. The link is good for ten minutes.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy !== null} aria-label="Refresh">
              <ArrowPathIcon className="h-4 w-4" />
            </Button>
          </div>

          {connectionsState === 'loading' ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : connectionsState === 'error' ? (
            <p className="text-sm text-red-600">Could not load the connected channels. Refresh to try again.</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels connected yet.</p>
          ) : (
            <ul className="divide-y">
              {shown.map((c) => (
                <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.label ?? c.external_account_id}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.external_account_id}</div>
                    {c.state_detail && <div className="text-xs text-muted-foreground">{c.state_detail}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge color={stateColor(c.state)} variant="soft">{c.state}</Badge>
                    {c.state === 'connected' && (
                      <Button variant="ghost" size="sm" onClick={() => void sync(c)} disabled={busy !== null}>
                        Sync now
                      </Button>
                    )}
                    {c.state !== 'disconnected' && (
                      <Button variant="ghost" size="sm" color="red" onClick={() => void disconnect(c)} disabled={busy !== null}>
                        Disconnect
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Button onClick={connect} disabled={busy !== null || !configured}>
            <PlusIcon className="h-4 w-4 mr-2" />
            {busy === 'connect' ? 'Opening Google…' : 'Connect a channel'}
          </Button>
          {settingsState === 'ready' && !configured && (
            <p className="text-xs text-muted-foreground">Save the OAuth client first.</p>
          )}
        </Card>
      </div>
    </WorkspaceLayout>
  );
}
