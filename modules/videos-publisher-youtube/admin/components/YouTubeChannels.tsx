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
  const [busy, setBusy] = useState<'load' | 'save' | 'connect' | null>('load');

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const [s, c] = await Promise.all([getYouTubeSettings(), listYouTubeConnections()]);
      setSettings(s);
      setClientId(s.clientId);
      setConnections(c);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the YouTube settings');
    } finally {
      setBusy(null);
    }
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
              {settings?.redirectUri ?? 'API_URL is not set on the API, so the redirect URI cannot be built'}
            </code>
          </div>
          <label className="block text-sm">
            <span className="font-medium">Client ID</span>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789-abc.apps.googleusercontent.com"
              className="mt-1 font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Client secret</span>
            <Input
              type="password"
              autoComplete="off"
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
          <Button onClick={save} disabled={busy !== null}>
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

          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels connected yet.</p>
          ) : (
            <ul className="divide-y">
              {connections.map((c) => (
                <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.label ?? c.external_account_id}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.external_account_id}</div>
                    {c.state_detail && <div className="text-xs text-muted-foreground">{c.state_detail}</div>}
                  </div>
                  <Badge color={stateColor(c.state)} variant="soft">{c.state}</Badge>
                </li>
              ))}
            </ul>
          )}

          <Button onClick={connect} disabled={busy !== null || !configured}>
            <PlusIcon className="h-4 w-4 mr-2" />
            {busy === 'connect' ? 'Opening Google…' : 'Connect a channel'}
          </Button>
          {!configured && (
            <p className="text-xs text-muted-foreground">Save the OAuth client first.</p>
          )}
        </Card>
      </div>
    </WorkspaceLayout>
  );
}
