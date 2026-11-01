// @ts-nocheck — bullmq/supabase types are resolved at module-host install time.
/**
 * Every 5 minutes: check the addresses that are due, newest prospects first.
 *
 * Each run stops after a time budget (2 minutes by default) and a batch size,
 * so a first run over a big people table is spread across many runs rather
 * than holding a worker slot. Paid checks also stop at the daily limits.
 */

import { createClient } from '@supabase/supabase-js';
import { promises as dns } from 'node:dns';
import type { Job } from 'bullmq';
import { parseConfig, providerDailyLimit, PROVIDER_PREFIX, type VerificationConfig } from '../lib/config';
import { loadProviders, type LoadedProvider } from '../lib/load-providers';
import { lookupDomain, type DomainResult } from '../lib/mx';
import { unsealSecret } from '../lib/secret-envelope';
import { sampleBucket, verifyAddress, type ProviderCall, type ProviderSlot } from '../lib/verify';

const MODULE_ID = 'email-verification';
// A domain's DNS changes rarely; look again after this long.
const DOMAIN_TTL_MS = 30 * 24 * 3_600_000;
const DNS_TIMEOUT_MS = 3_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const WRITE_BATCH = 100;
// With no paid provider, addresses are checked this many at a time (DNS only).
const BUILTIN_CONCURRENCY = 20;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('email-verification: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function unseal(v: unknown): string | null {
  return typeof v === 'string' ? unsealSecret(v) : null;
}

/** Providers in the configured order; with no order set, every enabled provider by id. */
export function orderProviders(loaded: LoadedProvider[], config: VerificationConfig): {
  primary: LoadedProvider[]; escalation: LoadedProvider | null; compare: LoadedProvider | null;
} {
  const byId = new Map(loaded.map((p) => [p.id, p]));
  const special = new Set([config.escalationProvider, config.compareProvider].filter(Boolean));
  const ordered = config.providerOrder.length > 0
    ? config.providerOrder.map((id) => byId.get(id)).filter(Boolean)
    : [...loaded].filter((p) => !special.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
  // A provider set only for escalation or compare is not also a first choice,
  // unless the order names it.
  return {
    primary: ordered as LoadedProvider[],
    escalation: config.escalationProvider ? byId.get(config.escalationProvider) ?? null : null,
    compare: config.compareProvider ? byId.get(config.compareProvider) ?? null : null,
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export default async function handleTick(_job: Job) {
  const started = Date.now();
  const supabase = client();

  const { data: mods, error: modsErr } = await supabase
    .from('installed_modules')
    .select('id, config')
    .eq('status', 'enabled')
    // Constants only; PostgREST reads * as the like wildcard.
    .or(`id.eq.${MODULE_ID},id.like.${PROVIDER_PREFIX}*`);
  if (modsErr) throw new Error(`[email-verification] installed_modules read failed: ${modsErr.message}`);
  const core = (mods ?? []).find((m) => m.id === MODULE_ID);
  if (!core) return { skipped: 'module not enabled' };
  const config = parseConfig((core.config ?? {}) as Record<string, unknown>);
  const overBudget = () => Date.now() - started > config.budgetMs;

  // One run at a time, so two runs cannot spend the same paid budget. The
  // lease outlives the budget by a margin and expires if this run dies.
  const holder = `${process.env.HOSTNAME ?? 'worker'}:${process.pid}:${started}`;
  const { data: leased, error: leaseErr } = await supabase.rpc('email_verification_try_lease', {
    p_holder: holder,
    p_seconds: Math.ceil(config.budgetMs / 1000) + 120,
  });
  if (leaseErr) throw new Error(`[email-verification] lease failed: ${leaseErr.message}`);
  if (!leased) return { skipped: 'another run is in progress' };
  try {
    return await run(supabase, mods ?? [], config, started, overBudget);
  } finally {
    await supabase.rpc('email_verification_release_lease', { p_holder: holder });
  }
}

async function run(supabase, mods, config: VerificationConfig, started: number, overBudget: () => boolean) {
  // Providers that are enabled, load, and have what they need (an API key).
  const loaded = (await loadProviders(
    (mods ?? []).filter((m) => m.id !== MODULE_ID).map((m) => ({ id: m.id, config: (m.config ?? {}) as Record<string, unknown> })),
  )).filter((p) => {
    try { return p.provider.isConfigured({ config: p.config, unsealSecret: unseal }); } catch { return false; }
  });

  // Daily limits: one across all providers, plus any a provider sets itself.
  const today = new Date().toISOString().slice(0, 10);
  const { data: usageRows } = await supabase.from('email_verification_usage').select('provider, checks').eq('day', today);
  const usedBy = new Map<string, number>((usageRows ?? []).map((u) => [u.provider, u.checks]));
  let paidLeft = Math.max(0, config.dailyPaidLimit - [...usedBy.values()].reduce((a, b) => a + b, 0));
  const providerLeft = new Map<string, number>();
  for (const p of loaded) {
    const cap = providerDailyLimit(p.config);
    providerLeft.set(p.id, cap === null ? Infinity : Math.max(0, cap - (usedBy.get(p.id) ?? 0)));
  }
  const spent = new Map<string, number>();

  const { primary, escalation, compare } = config.dailyPaidLimit > 0 ? orderProviders(loaded, config) : { primary: [], escalation: null, compare: null };
  const slot = (p: LoadedProvider | null): ProviderSlot | null => (p ? { id: p.id, provider: p.provider, config: p.config } : null);
  const concurrency = primary.length > 0
    ? Math.max(1, Math.min(...primary.map((p) => p.provider.concurrency || 1)))
    : BUILTIN_CONCURRENCY;

  // DNS, cached in the table and in memory for this run.
  const domainCache = new Map<string, Promise<DomainResult>>();
  const domainWrites: DomainResult[] = [];
  const resolver = { resolveMx: dns.resolveMx, resolve4: dns.resolve4, resolve6: dns.resolve6 };
  const domainFor = (domain: string): Promise<DomainResult> => {
    let p = domainCache.get(domain);
    if (!p) {
      p = (async () => {
        const { data } = await supabase.from('email_verification_domains')
          .select('domain, outcome, mailbox_provider, mx_host, error, checked_at').eq('domain', domain).maybeSingle();
        if (data && Date.now() - Date.parse(data.checked_at) < DOMAIN_TTL_MS) {
          return { domain, outcome: data.outcome, mailboxProvider: data.mailbox_provider, mxHost: data.mx_host, error: data.error };
        }
        const fresh = await lookupDomain(domain, resolver, DNS_TIMEOUT_MS);
        if (fresh.outcome !== 'temporary') domainWrites.push(fresh);
        return fresh;
      })();
      domainCache.set(domain, p);
    }
    return p;
  };

  const { data: due, error: dueErr } = await supabase.rpc('email_verification_due', { p_limit: config.checksPerRun });
  if (dueErr) throw new Error(`[email-verification] due failed: ${dueErr.message}`);
  const emails = ((due ?? []) as Array<{ email: string }>).map((d) => d.email);

  const result = { due: emails.length, checked: 0, valid: 0, risky: 0, invalid: 0, retry: 0, paid: 0, paidPending: 0, stoppedEarly: false, providers: primary.map((p) => p.id) };
  const records: Record<string, unknown>[] = [];
  const calls: Array<ProviderCall & { email: string }> = [];
  const stopped = new Set<string>();
  const recheckAt = () => new Date(Date.now() + config.recheckDays * 86_400_000).toISOString();
  // Providers exist but did not answer (limit reached, errors): try for a
  // mailbox check again tomorrow rather than in six months.
  const pendingAt = () => new Date(Date.now() + 86_400_000).toISOString();

  await mapLimit(emails, concurrency, async (email) => {
    if (overBudget()) { result.stoppedEarly = true; return; }
    try {
      const r = await verifyAddress(email, {
        domain: domainFor,
        primary: primary.map(slot),
        escalation: slot(escalation),
        compare: slot(compare),
        inCompareSample: (e) => sampleBucket(e) < config.comparePercent,
        take: (id) => {
          const left = providerLeft.get(id) ?? 0;
          if (paidLeft <= 0 || left <= 0) return false;
          paidLeft--; providerLeft.set(id, left - 1);
          return true;
        },
        giveBack: (id) => { paidLeft++; providerLeft.set(id, (providerLeft.get(id) ?? 0) + 1); },
        stopped,
        call: async (s, e) => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS);
          try {
            return await s.provider.verify(e, { config: s.config, unsealSecret: unseal, fetch, signal: ac.signal });
          } finally {
            clearTimeout(timer);
          }
        },
      });
      for (const c of r.calls) {
        calls.push({ ...c, email });
        if (c.result) { spent.set(c.provider, (spent.get(c.provider) ?? 0) + 1); result.paid++; }
      }
      if (!r.outcome) { records.push({ email, retry: true }); result.retry++; return; }
      if (r.paidPending) result.paidPending++;
      result.checked++;
      result[r.outcome.status]++;
      records.push({
        email: r.outcome.email,
        status: r.outcome.status,
        reason: r.outcome.reason,
        level: r.outcome.level,
        decided_by: r.outcome.decidedBy,
        mailbox_provider: r.outcome.mailboxProvider,
        suggestion: r.outcome.suggestion,
        next_check_at: r.paidPending ? pendingAt() : recheckAt(),
      });
    } catch (e) {
      console.warn(`[email-verification] check failed: ${(e as Error).message}`);
      records.push({ email, retry: true });
      result.retry++;
    }
  });

  if (domainWrites.length > 0) {
    const { error } = await supabase.from('email_verification_domains').upsert(
      domainWrites.map((d) => ({ domain: d.domain, outcome: d.outcome, mailbox_provider: d.mailboxProvider, mx_host: d.mxHost, error: d.error, checked_at: new Date().toISOString() })),
      { onConflict: 'domain' },
    );
    if (error) console.warn(`[email-verification] domain cache write failed: ${error.message}`);
  }

  for (let i = 0; i < calls.length; i += WRITE_BATCH) {
    const { error } = await supabase.from('email_verification_provider_results').insert(
      calls.slice(i, i + WRITE_BATCH).map((c) => ({
        email: c.email, provider: c.provider, purpose: c.purpose,
        status: c.result?.status ?? null, reason: c.result?.reason ?? null,
        error_kind: c.errorKind, error: c.error, raw: c.result?.raw ?? null,
      })),
    );
    if (error) { console.warn(`[email-verification] provider results write failed: ${error.message}`); break; }
  }
  for (const [provider, n] of spent) {
    const { error } = await supabase.rpc('email_verification_add_usage', { p_provider: provider, p_checks: n });
    if (error) console.warn(`[email-verification] usage write failed for ${provider}: ${error.message}`);
  }

  for (let i = 0; i < records.length; i += WRITE_BATCH) {
    const { error } = await supabase.rpc('email_verification_record', {
      p_rows: records.slice(i, i + WRITE_BATCH),
      p_suppress: config.suppressInvalid,
    });
    if (error) throw new Error(`[email-verification] record failed: ${error.message}`);
  }

  if (stopped.size > 0) console.warn(`[email-verification] providers stopped this run: ${[...stopped].join(', ')}`);
  console.log(`[email-verification] tick ${JSON.stringify(result)} ms=${Date.now() - started}`);
  return result;
}
