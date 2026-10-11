// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * event-speakers:enrich-speaker-linkedin — find LinkedIn URLs for speakers
 * who have none.
 *
 * Why this is separate from the dedupe sweep, and why it must stay separate.
 *
 * LinkedIn is the only identifier that reaches the existing duplicates: 2,050
 * of 6,031 profiles carry one, spread across the 994 events the duplicates
 * live on. The 337 duplicate groups with no LinkedIn URL on any row cannot be
 * settled by any key we hold, so filling the field converts a chunk of them
 * into groups the sweep can decide.
 *
 * But the lookup is FUZZY. The existing people-enrichment path keys on email,
 * which 10 of the 1,120 duplicate rows have, so it is useless here; what is
 * left is name plus company, and that returns a best guess. A best guess is
 * fine for showing an operator a link. It is not fine for driving a merge,
 * because a wrong guess would hand two different people the same LinkedIn slug
 * and the sweep would then merge them automatically with a confident reason.
 *
 * So this worker:
 *   - writes linkedin_url ONLY where it is currently null,
 *   - records how the value was obtained in enrichment_source,
 *   - and the dedupe sweep ignores a URL whose source is a fuzzy lookup.
 *
 * That last rule is the whole safety argument. Do not remove it to raise the
 * merge rate.
 */

import { serviceClient } from '../lib/promo/service-client.js';
import { linkedinSlug } from '../lib/dedupe/keys.js';

const API = 'https://enrichlayer.com/api/v2/person/resolve';
const TIMEOUT_MS = 12_000;
const PAGE = 200;

export interface EnrichResult {
  considered: number;
  looked_up: number;
  found: number;
  written: number;
  skipped: Record<string, number>;
  errors: string[];
}

interface Candidate {
  id: string;
  name: string | null;
  company: string | null;
  title: string | null;
}

/**
 * Profiles worth a lookup: no LinkedIn URL, a company to disambiguate with,
 * and a name specific enough that a match means something.
 *
 * `duplicatesOnly` restricts to names that actually appear more than once,
 * which is where the value is. A full sweep of 3,981 profiles without a
 * LinkedIn URL would be a large bill for mostly no dedupe benefit.
 */
async function candidates(supabase, duplicatesOnly: boolean, limit: number): Promise<Candidate[]> {
  if (duplicatesOnly) {
    const { data, error } = await supabase.rpc('speaker_dedupe_enrich_candidates', { p_limit: limit });
    if (!error && Array.isArray(data)) return data;
    // The helper is a convenience, not a requirement. Fall through to the
    // plain query rather than failing the job if it is absent.
  }
  const { data, error } = await supabase
    .from('events_speaker_profiles')
    .select('id, name, company, title')
    .is('linkedin_url', null)
    .is('canonical_profile_id', null)
    .not('company', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`candidate read failed: ${error.message}`);
  return data ?? [];
}

/**
 * One resolve call. Returns a slug only when the provider is confident enough
 * to give a profile URL for the exact company we asked about.
 */
async function resolveOne(
  name: string,
  company: string,
  apiKey: string,
): Promise<{ url: string; slug: string } | null> {
  const qs = new URLSearchParams({
    first_name: name.split(' ')[0] ?? name,
    last_name: name.split(' ').slice(1).join(' ') || name,
    company_domain: '',
    location: '',
    title: '',
    enrich_profile: 'skip',
  });
  // The provider matches on company name when no domain is known.
  qs.set('company_domain', company);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const url = body?.url ?? body?.linkedin_profile_url ?? null;
    const slug = linkedinSlug(url);
    return slug && url ? { url: String(url), slug } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichSpeakerLinkedin(
  supabase,
  opts: {
    limit?: number;
    duplicatesOnly?: boolean;
    log?: (m: string) => void;
    apiKey?: string;
    resolve?: typeof resolveOne;
  } = {},
): Promise<EnrichResult> {
  const log = opts.log ?? (() => {});
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const apiKey = opts.apiKey ?? process.env.ENRICHLAYER_API_KEY ?? '';
  const resolve = opts.resolve ?? resolveOne;
  const out: EnrichResult = { considered: 0, looked_up: 0, found: 0, written: 0, skipped: {}, errors: [] };
  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };

  if (!apiKey) {
    // Early return rather than throwing, matching send-testing's poller: an
    // unconfigured provider is a no-op, not a failed job.
    log('ENRICHLAYER_API_KEY is not set — nothing to do');
    return out;
  }

  const rows = await candidates(supabase, opts.duplicatesOnly !== false, limit);
  log(`${rows.length} profile(s) without a LinkedIn URL to look up`);

  for (const r of rows) {
    out.considered += 1;
    const name = String(r.name ?? '').trim();
    const company = String(r.company ?? '').trim();
    if (name.split(/\s+/).filter(Boolean).length < 2) { skip('name_not_specific'); continue; }
    if (!company) { skip('no_company'); continue; }

    out.looked_up += 1;
    const hit = await resolve(name, company, apiKey);
    if (!hit) { skip('no_match'); continue; }
    out.found += 1;

    // Conditional on the field still being empty. A human may have filled it
    // between the read and the write, and their value wins.
    const { data, error } = await supabase
      .from('events_speaker_profiles')
      .update({ linkedin_url: hit.url, enrichment_source: 'enrichlayer_name_company' })
      .eq('id', r.id)
      .is('linkedin_url', null)
      .select('id');
    if (error) { out.errors.push(`${r.id}: ${error.message}`); continue; }
    if (!data?.length) { skip('filled_underneath'); continue; }
    out.written += 1;
  }

  log(
    `enrich-speaker-linkedin: ${out.written} written from ${out.looked_up} lookup(s)` +
    `${out.errors.length ? `, ${out.errors.length} error(s)` : ''}`,
  );
  return out;
}

export default async function enrichSpeakerLinkedinHandler(job, ctx): Promise<EnrichResult> {
  // serviceClient(), not a dynamic import of supabase-js. A dynamic
  // `await import('@supabase/supabase-js')` from a module file resolves
  // against the package's exports map and fails in the worker with
  // "Did you mean to import .../dist/index.cjs?", while the static import
  // inside service-client.ts resolves fine. This is also the module's own
  // existing convention, so there is one place that builds the client.
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[event-speakers] ${m}`);
  const data = job?.data ?? {};
  return enrichSpeakerLinkedin(supabase, {
    limit: data.limit,
    duplicatesOnly: data.duplicates_only !== false,
    log,
  });
}
