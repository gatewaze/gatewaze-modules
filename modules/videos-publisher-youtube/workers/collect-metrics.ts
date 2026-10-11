// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos-publisher-youtube:collect-metrics — yesterday's numbers for every
 * published video on every connected channel.
 *
 * Daily, because every platform settles its own figures on a day boundary and
 * polling more often spends quota for nothing. The Data API charges one unit
 * per call of up to 50 ids, so this batches and a 160-video channel costs
 * four units rather than 160.
 *
 * The rule that matters most here is the honest one: a video the API does not
 * return is recorded as `no_data`, never as zero. A deleted or newly-private
 * video stored as 0 views reads as a real audience vanishing, and once that
 * is in a chart nobody goes back to check whether it was a collection
 * failure.
 */

import { collectMetrics } from '../lib/adapter.js';
import { serviceClient } from '../lib/service-client.js';
import { unsealSecret } from '../lib/secret-envelope.js';

const PAGE = 500;

export interface CollectResult {
  connections: number;
  publications: number;
  written: number;
  by_status: Record<string, number>;
  errors: string[];
}

/** The OAuth client, from this module's own sealed config. */
async function clientCredentials(supabase): Promise<{ clientId: string; clientSecret: string } | null> {
  const { data } = await supabase
    .from('installed_modules').select('config').eq('id', 'videos-publisher-youtube').maybeSingle();
  const cfg = (data?.config ?? {}) as Record<string, unknown>;
  const clientId = String(cfg.clientId ?? '');
  const raw = String(cfg.clientSecret ?? '');
  if (!clientId || !raw) return null;
  return { clientId, clientSecret: unsealSecret(raw) ?? raw };
}

export async function collectAll(
  supabase,
  opts: { log?: (m: string) => void; forDate?: string } = {},
): Promise<CollectResult> {
  const log = opts.log ?? (() => {});
  const out: CollectResult = { connections: 0, publications: 0, written: 0, by_status: {}, errors: [] };
  const bump = (s: string) => { out.by_status[s] = (out.by_status[s] ?? 0) + 1; };

  // Yesterday by default: today's figures are still moving, and storing a
  // partial day under today's date then never revisiting it bakes in an
  // undercount.
  const day = opts.forDate ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const client = await clientCredentials(supabase);
  if (!client) {
    log('the YouTube OAuth client is not configured — nothing to collect');
    return out;
  }

  const { data: connections, error: connErr } = await supabase
    .from('video_platform_connections')
    .select('id, label, external_account_id, encrypted_credentials, state')
    .eq('platform', 'youtube')
    .eq('state', 'connected')
    .eq('collection_enabled', true);
  if (connErr) {
    out.errors.push(`connection read failed: ${connErr.message}`);
    return out;
  }

  for (const conn of connections ?? []) {
    out.connections += 1;
    const refreshToken = unsealSecret(conn.encrypted_credentials);
    if (!refreshToken) {
      // The envelope could not be opened: a rotated key, or a row written
      // when no key was configured. Either way a human has to reconnect.
      await supabase.from('video_platform_connections').update({
        state: 'needs_reauth',
        state_detail: 'stored credentials could not be unsealed',
        last_collect_status: 'auth',
        last_collected_at: new Date().toISOString(),
      }).eq('id', conn.id);
      out.errors.push(`${conn.label}: credentials could not be unsealed`);
      continue;
    }

    // Published videos on THIS connection that actually have a YouTube id.
    const pubs: Array<{ id: string; external_id: string }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('video_publications')
        .select('id, external_id')
        .eq('connection_id', conn.id)
        .eq('state', 'published')
        .not('external_id', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) { out.errors.push(`${conn.label}: ${error.message}`); break; }
      const batch = data ?? [];
      pubs.push(...batch);
      if (batch.length < PAGE) break;
    }
    out.publications += pubs.length;
    if (pubs.length === 0) { log(`${conn.label}: nothing published yet`); continue; }

    const byExternal = new Map(pubs.map((p) => [String(p.external_id), p.id]));
    const results = await collectMetrics(client, refreshToken, [...byExternal.keys()]);

    // One auth failure on this channel means the credential is dead; say so
    // once rather than writing an auth row per video.
    const authFailed = [...results.values()].some((r) => r.status === 'auth');
    if (authFailed) {
      await supabase.from('video_platform_connections').update({
        state: 'needs_reauth',
        state_detail: 'YouTube rejected the stored credentials',
        last_collect_status: 'auth',
        last_collect_detail: 'reconnect this channel',
        last_collected_at: new Date().toISOString(),
      }).eq('id', conn.id);
      out.errors.push(`${conn.label}: needs reconnecting`);
      bump('auth');
      continue;
    }

    const rows = [];
    for (const [externalId, r] of results) {
      const publicationId = byExternal.get(externalId);
      if (!publicationId) continue;
      bump(r.status);
      rows.push({
        publication_id: publicationId,
        connection_id: conn.id,
        collected_for: day,
        status: r.status,
        status_detail: r.detail ?? null,
        // Left NULL rather than 0 when there is no figure. A zero here would
        // be indistinguishable from a video nobody watched.
        views: r.views ?? null,
        likes: r.likes ?? null,
        comments: r.comments ?? null,
        raw: r.raw ?? {},
        collected_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      // Re-running for the same day replaces that day's figures rather than
      // duplicating them, which is what makes a manual re-run safe.
      const { error } = await supabase
        .from('video_metrics')
        .upsert(rows, { onConflict: 'publication_id,collected_for' });
      if (error) out.errors.push(`${conn.label}: metric write failed: ${error.message}`);
      else out.written += rows.length;
    }

    const anyOk = rows.some((r) => r.status === 'ok');
    await supabase.from('video_platform_connections').update({
      last_collected_at: new Date().toISOString(),
      last_collect_status: anyOk ? 'ok' : 'no_data',
      last_collect_detail: anyOk ? null : 'the API returned no figures for any published video',
    }).eq('id', conn.id);

    log(`${conn.label}: ${rows.length} publication(s) for ${day}`);
  }

  log(
    `collect-metrics: ${out.written} row(s) across ${out.connections} connection(s)` +
    `${out.errors.length ? `, ${out.errors.length} problem(s)` : ''}`,
  );
  return out;
}

export default async function collectMetricsHandler(job, ctx): Promise<CollectResult> {
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos-publisher-youtube] ${m}`);
  return collectAll(supabase, { log, forDate: job?.data?.for_date });
}
