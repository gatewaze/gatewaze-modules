// @ts-nocheck — bullmq/supabase types are resolved at module-host install time.
/**
 * Every 30 minutes: measure sends by mailbox provider, look up MX records for
 * recipient domains, and check sends that are 24 hours old.
 *
 * Each run stops after a time budget (60s by default). On 8 Oct 2026 the
 * newsletter snapshot cron, which had no budget, held both worker slots for
 * 25 minutes and delayed a live send, so long work here is always split
 * across runs.
 */

import { createClient } from '@supabase/supabase-js';
import { promises as dns } from 'node:dns';
import type { Job } from 'bullmq';
import { parseConfig } from '../lib/config';
import { detect } from '../lib/detector';
import { isLookupableDomain, providerForMx } from '../lib/providers';

const MODULE_ID = 'email-reputation';
// Most opens arrive within a day, so a send is judged once it is this old.
const EVALUATE_AFTER_MS = 24 * 3_600_000;
// Alerts on sends older than this are recorded but not posted to Slack, so a
// first-time backfill does not post weeks of history.
const NOTIFY_WITHIN_MS = 3 * 24 * 3_600_000;
const DNS_TIMEOUT_MS = 3_000;
const DNS_CONCURRENCY = 20;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('email-reputation: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Slack mrkdwn treats <...> as links and mentions (<!channel>); show it as text. */
function slackText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function lookupDomain(domain: string) {
  try {
    const records = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS);
    const { provider, mxHost } = providerForMx(records);
    return { domain, provider, mx_host: mxHost, error: null };
  } catch (e) {
    const code = (e as { code?: string })?.code ?? (e as Error)?.message ?? 'lookup failed';
    // A domain with no MX (ENODATA/ENOTFOUND) is recorded so it is not retried
    // every run; it stays 'unknown' and is excluded from comparisons.
    return { domain, provider: 'unknown', mx_host: null, error: String(code).slice(0, 80) };
  }
}

export default async function handleTick(_job: Job) {
  const started = Date.now();
  const supabase = client();
  const { data: mod } = await supabase.from('installed_modules').select('config').eq('id', MODULE_ID).maybeSingle();
  const config = parseConfig((mod?.config ?? {}) as Record<string, unknown>);
  const overBudget = () => Date.now() - started > config.budgetMs;
  const result = { computed: 0, domains: 0, evaluated: 0, alerts: 0, notified: 0, stoppedEarly: false };

  // 1. Measure sends.
  const { data: due, error: dueErr } = await supabase.rpc('email_reputation_due_sends', {
    p_recent_days: config.recentDays,
    p_backfill_days: config.backfillDays,
    p_limit: 50,
  });
  if (dueErr) throw new Error(`[email-reputation] due_sends failed: ${dueErr.message}`);
  for (const s of (due ?? []) as Array<{ send_kind: string; send_id: string }>) {
    if (overBudget()) { result.stoppedEarly = true; break; }
    const { error } = await supabase.rpc('email_reputation_compute_send', { p_kind: s.send_kind, p_send_id: s.send_id });
    if (error) { console.warn(`[email-reputation] compute ${s.send_kind}/${s.send_id} failed: ${error.message}`); continue; }
    result.computed++;
  }

  // 2. Look up MX records for recipient domains with no provider yet.
  if (!overBudget() && config.domainLookupsPerRun > 0) {
    const { data: doms, error } = await supabase.rpc('email_reputation_unresolved_domains', {
      p_days: config.backfillDays,
      p_limit: config.domainLookupsPerRun,
    });
    if (error) {
      console.warn(`[email-reputation] unresolved_domains failed: ${error.message}`);
    } else {
      const list = ((doms ?? []) as Array<{ domain: string }>).map((d) => d.domain).filter(isLookupableDomain);
      for (let i = 0; i < list.length; i += DNS_CONCURRENCY) {
        if (overBudget()) { result.stoppedEarly = true; break; }
        const rows = await Promise.all(list.slice(i, i + DNS_CONCURRENCY).map(lookupDomain));
        const { error: upErr } = await supabase
          .from('email_reputation_domain_providers')
          .upsert(rows.map((r) => ({ ...r, checked_at: new Date().toISOString() })), { onConflict: 'domain' });
        if (upErr) { console.warn(`[email-reputation] provider upsert failed: ${upErr.message}`); break; }
        result.domains += rows.length;
      }
    }
  }

  // 3. Judge sends that are a day old and were measured after that point.
  if (!overBudget()) {
    const cutoff = new Date(Date.now() - EVALUATE_AFTER_MS).toISOString();
    const { data: ready, error } = await supabase
      .from('email_reputation_sends')
      .select('send_kind, send_id, sending_domain, send_label, send_started_at, computed_at')
      .is('evaluated_at', null)
      .lt('send_started_at', cutoff)
      .order('send_started_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(`[email-reputation] ready sends failed: ${error.message}`);

    for (const s of ready ?? []) {
      if (overBudget()) { result.stoppedEarly = true; break; }
      // Counts taken before the 24h mark miss late opens: wait for a recompute.
      if (!s.computed_at || Date.parse(s.computed_at) < Date.parse(s.send_started_at) + EVALUATE_AFTER_MS) continue;

      const { data: stats, error: sErr } = await supabase
        .from('email_reputation_send_stats')
        .select('provider, delivered, opened')
        .eq('send_kind', s.send_kind)
        .eq('send_id', s.send_id);
      if (sErr) { console.warn(`[email-reputation] stats read failed: ${sErr.message}`); continue; }

      const alerts = detect(stats ?? [], config.thresholds);
      for (const a of alerts) {
        const notify = !!config.slackWebhookUrl && Date.now() - Date.parse(s.send_started_at) < NOTIFY_WITHIN_MS;
        const { data: inserted, error: aErr } = await supabase
          .from('email_reputation_alerts')
          .upsert({
            send_kind: s.send_kind,
            send_id: s.send_id,
            provider: a.provider,
            sending_domain: s.sending_domain,
            provider_open_rate: a.providerOpenRate,
            baseline_open_rate: a.baselineOpenRate,
            delivered: a.delivered,
          }, { onConflict: 'send_kind,send_id,provider', ignoreDuplicates: true })
          .select('id');
        if (aErr) { console.warn(`[email-reputation] alert insert failed: ${aErr.message}`); continue; }
        if (!inserted || inserted.length === 0) continue; // already alerted
        result.alerts++;
        if (notify) {
          try {
            const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
            const text = `:warning: *${a.provider}* opened ${pct(a.providerOpenRate)} of "${slackText(s.send_label ?? 'a send')}" from ${slackText(s.sending_domain ?? 'unknown domain')} ` +
              `(${a.delivered.toLocaleString()} delivered), against ${pct(a.baselineOpenRate)} at other providers. ` +
              `Mail to ${a.provider} is probably going to spam.`;
            const res = await withTimeout(fetch(config.slackWebhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
              redirect: 'error',
            }), 5_000);
            if (res.ok) {
              await supabase.from('email_reputation_alerts').update({ notified_at: new Date().toISOString() }).eq('id', inserted[0].id);
              result.notified++;
            }
          } catch (e) {
            console.warn(`[email-reputation] slack notify failed: ${(e as Error).message}`);
          }
        }
      }

      await supabase.from('email_reputation_sends')
        .update({ evaluated_at: new Date().toISOString() })
        .eq('send_kind', s.send_kind).eq('send_id', s.send_id);
      result.evaluated++;
    }
  }

  console.log(`[email-reputation] tick ${JSON.stringify(result)} ms=${Date.now() - started}`);
  return result;
}
