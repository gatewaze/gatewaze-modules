// @ts-nocheck — supabase client resolved at module-host install time.
/**
 * Microsoft Clarity live-insights feed for the test-environment Overview.
 *
 * The pr-view test envs are instrumented with Clarity by the staging box's
 * routing layer (gatewaze-environments/scripts/staging-html-injector.py — no
 * LFX repo code was changed to add it). This module pulls the aggregate
 * signals back so the Environments section can show how the envs are actually
 * behaving: sessions, rage clicks, dead clicks, quick-backs, script errors.
 *
 * THE BUDGET IS THE DESIGN CONSTRAINT
 * -----------------------------------
 * Clarity's Data Export API allows 10 requests per project PER DAY, and
 * `numOfDays` only accepts 1, 2 or 3 — there is no arbitrary date range and no
 * pagination beyond 1000 rows. Docs:
 * learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api
 *
 * Consequences, all enforced below:
 *   * Nothing calls Clarity on a page render or a poll. The admin reads the
 *     cached snapshot (migration 027) and nothing else.
 *   * A refresh happens at most once every REFRESH_INTERVAL_MS (3h → 8/day),
 *     ridden in on the same admin poll that ingests env events, and only up to
 *     SCHEDULED_CAP calls a day. That deliberately leaves headroom.
 *   * The operator's "Refresh now" button may spend up to DAILY_CAP, i.e. the
 *     two calls the scheduled path will not touch. When they are gone it
 *     refuses until 00:00 UTC rather than getting a 429 from Microsoft.
 *   * Every call is counted BEFORE it is made, by a guarded UPDATE, so a
 *     crashed or timed-out request still costs its slot — the alternative
 *     (count on success) would let a flapping network burn the quota
 *     invisibly.
 *
 * PER-ENVIRONMENT ATTRIBUTION
 * ---------------------------
 * Custom tags (we set env=<label> on every session) are NOT a dimension in the
 * export API — they are a dashboard filter only. The API's dimensions are
 * Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel and
 * URL. So attribution rides `URL`: every env has its own hostname, so when the
 * URL values carry a host we can group by env for free. They may instead be
 * bare paths, which are identical across envs; `attributeByEnv` returns null
 * in that case and the UI shows project-wide totals rather than inventing
 * per-env numbers. Replays themselves stay in Clarity — there is no public
 * API for session recordings — hence the deep link.
 *
 * SECRET HANDLING
 * ---------------
 * CLARITY_DATA_EXPORT_TOKEN is a long-lived bearer JWT. It is read from the
 * API container's environment, used only in an Authorization header, and
 * never logged, never persisted, and never included in any response. Error
 * text stored in the snapshot row is the HTTP status and nothing else.
 */

const API_URL = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';

/** Hard ceiling from Microsoft. Everything else is a self-imposed sub-budget. */
export const DAILY_CAP = 10;
/** What the automatic path may spend, leaving DAILY_CAP - SCHEDULED_CAP manual calls. */
export const SCHEDULED_CAP = 8;
/** 3h → 8 automatic calls in a 24h day, matching SCHEDULED_CAP exactly. */
export const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Only value Clarity documents beyond 1 and 2; 3 is the longest lookback. */
const NUM_OF_DAYS = 3;
const FETCH_TIMEOUT_MS = 20_000;
/** Defensive cap on what we are willing to store from a third party. */
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_ROWS_PER_METRIC = 200;

/** UTC day key — the quota resets at 00:00 UTC, not in the box's timezone. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function clarityConfig(env = process.env) {
  const projectId = String(env.CLARITY_PROJECT_ID || '').trim();
  const token = String(env.CLARITY_DATA_EXPORT_TOKEN || '').trim();
  // The project id is public (it ships in every instrumented page); the token
  // is not. Both must be present for the export feed to be considered on.
  const validId = /^[A-Za-z0-9]{5,32}$/.test(projectId);
  return {
    projectId: validId ? projectId : null,
    token: token || null,
    configured: Boolean(validId && token),
  };
}

/** Recordings list for the project. Undocumented filter params are avoided. */
export function clarityDashboardUrl(projectId: string): string {
  return `https://clarity.microsoft.com/projects/view/${encodeURIComponent(projectId)}/impressions`;
}

/**
 * Shape-check and cap a Data Export response.
 *
 * Real shape: [{ metricName: "Traffic", information: [ {…}, … ] }, …]. Rows
 * are free-form key/value bags whose keys vary per metric, so they are kept as
 * objects but bounded in count and in serialized size.
 */
export function parseInsights(raw: unknown): { metricName: string; information: Record<string, unknown>[] }[] | null {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const metricName = String((entry as Record<string, unknown>).metricName ?? '');
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(metricName)) continue;
    const info = (entry as Record<string, unknown>).information;
    const information = Array.isArray(info)
      ? info.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, MAX_ROWS_PER_METRIC)
      : [];
    out.push({ metricName, information });
  }
  if (!out.length && Array.isArray(raw) && raw.length) return null;
  return out;
}

/** Total sessions across a Traffic metric's rows, or null when absent. */
export function totalSessions(metrics: { metricName: string; information: Record<string, unknown>[] }[]): number | null {
  const traffic = metrics.find((m) => m.metricName === 'Traffic');
  if (!traffic || !traffic.information.length) return null;
  let total = 0;
  for (const row of traffic.information) {
    const n = Number(row.totalSessionCount ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/** Sum of a count-shaped metric (rage clicks etc.) across its rows. */
export function totalCount(
  metrics: { metricName: string; information: Record<string, unknown>[] }[],
  metricName: string,
): number | null {
  const m = metrics.find((x) => x.metricName === metricName);
  if (!m || !m.information.length) return null;
  let total = 0;
  for (const row of m.information) {
    // Clarity names the count column after the metric in some responses and
    // uses a generic key in others; take the first finite numeric value that
    // is not an obvious dimension.
    for (const [k, v] of Object.entries(row)) {
      if (k === 'URL' || k === 'Url') continue;
      const n = Number(v);
      if (Number.isFinite(n)) { total += n; break; }
    }
  }
  return total;
}

/**
 * Group rows by pr-view env label using the URL dimension.
 *
 * Returns null when no row carries a hostname — meaning Clarity gave us bare
 * paths and per-env attribution is not available from this API. Callers must
 * fall back to project-wide totals rather than guessing.
 */
export function attributeByEnv(
  metrics: { metricName: string; information: Record<string, unknown>[] }[],
  rootEnvLabel: string | null,
): Record<string, Record<string, number>> | null {
  const byEnv: Record<string, Record<string, number>> = {};
  let sawHost = false;
  for (const metric of metrics) {
    for (const row of metric.information) {
      const url = String(row.URL ?? row.Url ?? '');
      const host = hostOf(url);
      if (!host) continue;
      sawHost = true;
      const label = envLabelForHost(host, rootEnvLabel);
      if (!label) continue;
      const bucket = (byEnv[label] ||= {});
      const n = Number(row.totalSessionCount ?? firstNumber(row) ?? 0);
      if (Number.isFinite(n)) bucket[metric.metricName] = (bucket[metric.metricName] || 0) + n;
    }
  }
  return sawHost ? byEnv : null;
}

function firstNumber(row: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(row)) {
    if (k === 'URL' || k === 'Url') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Hostname out of a full URL or a `host/path` value; null for a bare path. */
export function hostOf(value: string): string | null {
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  if (value.startsWith('/')) return null;
  try {
    return new URL(withScheme).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** pr-view hostname → env label. lfx.pr-view.com resolves to the root holder. */
export function envLabelForHost(host: string, rootEnvLabel: string | null): string | null {
  const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.pr-view\.com$/.exec(host);
  if (!m) return null;
  const label = m[1];
  if (label === 'lfx') return rootEnvLabel && rootEnvLabel !== 'primary' ? rootEnvLabel : 'primary';
  if (label === 'lfx--main') return 'primary';
  return label.startsWith('lfx--') ? label : null;
}

/** Today's spend, for display. */
export async function budgetState(supabase, day = utcDay()) {
  const { data } = await supabase.from('se_clarity_budget').select('calls').eq('day', day).maybeSingle();
  const calls = Number(data?.calls ?? 0);
  return { day, calls, dailyCap: DAILY_CAP, scheduledCap: SCHEDULED_CAP, remaining: Math.max(0, DAILY_CAP - calls) };
}

/** The newest cached snapshot, or null before the first fetch. */
export async function latestSnapshot(supabase) {
  const { data } = await supabase
    .from('se_clarity_snapshots')
    .select('fetched_at, num_of_days, ok, error, payload')
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * One live call. Never invoked directly by a route — go through
 * `refreshIfStale`, which owns the budget.
 *
 * The URL is fully static apart from constants defined in this file: no
 * request value of any kind reaches it, so there is nothing to inject.
 */
async function fetchInsights(token: string) {
  const url = `${API_URL}?numOfDays=${NUM_OF_DAYS}&dimension1=URL`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!resp.ok) return { ok: false, error: `clarity http ${resp.status}`, payload: null };
    const text = await resp.text();
    if (text.length > MAX_PAYLOAD_BYTES) return { ok: false, error: 'clarity response too large', payload: null };
    let raw;
    try { raw = JSON.parse(text); } catch { return { ok: false, error: 'clarity response not json', payload: null }; }
    const payload = parseInsights(raw);
    if (!payload) return { ok: false, error: 'clarity response shape unrecognised', payload: null };
    return { ok: true, error: null, payload };
  } catch (e) {
    // Deliberately not `${e}` — an abort/DNS error can echo the request URL,
    // and while this URL has no secret in it, the habit is the wrong one for
    // a function that holds a bearer token.
    return { ok: false, error: ac.signal.aborted ? 'clarity request timed out' : 'clarity request failed', payload: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the cache when it is stale enough and the budget allows.
 *
 * `force` is the operator's "Refresh now": it ignores the interval and may
 * spend up to DAILY_CAP; the automatic path stops at SCHEDULED_CAP. Returns a
 * short reason string when nothing was fetched, so the UI can say why.
 */
export async function refreshIfStale(supabase, { force = false, env = process.env, now = Date.now() } = {}) {
  const cfg = clarityConfig(env);
  if (!cfg.configured) return { fetched: false, reason: 'not_configured' };

  const latest = await latestSnapshot(supabase);
  const age = latest?.fetched_at ? now - Date.parse(latest.fetched_at) : Infinity;
  if (!force && age < REFRESH_INTERVAL_MS) return { fetched: false, reason: 'fresh' };

  const day = utcDay(new Date(now));
  const cap = force ? DAILY_CAP : SCHEDULED_CAP;
  const spent = await spendSlot(supabase, cap, day);
  if (!spent) return { fetched: false, reason: force ? 'budget_exhausted' : 'scheduled_budget_spent' };

  const result = await fetchInsights(cfg.token);
  await supabase.from('se_clarity_snapshots').insert({
    fetched_at: new Date(now).toISOString(),
    num_of_days: NUM_OF_DAYS,
    ok: result.ok,
    error: result.error,
    payload: result.payload,
  });
  // Keep the table small — the UI only ever reads the newest row, and the
  // history is only useful for eyeballing recent failures.
  const { data: keep } = await supabase
    .from('se_clarity_snapshots')
    .select('id')
    .order('fetched_at', { ascending: false })
    .limit(30);
  const ids = (keep ?? []).map((r) => r.id);
  if (ids.length === 30) await supabase.from('se_clarity_snapshots').delete().lt('id', Math.min(...ids));
  return { fetched: true, ok: result.ok, reason: result.ok ? 'refreshed' : result.error };
}

/**
 * Increment today's counter iff it is below `cap`.
 *
 * Compare-and-swap rather than read-then-write: the observed value is part of
 * the UPDATE predicate, so if two admin polls race, exactly one UPDATE matches
 * a row and the loser fails closed (no call, no spend). Failing closed is the
 * right direction — an unspent slot costs nothing, a double-spend costs 10% of
 * the day's quota.
 */
async function spendSlot(supabase, cap: number, day: string): Promise<boolean> {
  await supabase.from('se_clarity_budget').upsert({ day, calls: 0 }, { onConflict: 'day', ignoreDuplicates: true });
  const { data: cur } = await supabase.from('se_clarity_budget').select('calls').eq('day', day).maybeSingle();
  const calls = Number(cur?.calls ?? 0);
  if (calls >= cap) return false;
  const { data: updated } = await supabase
    .from('se_clarity_budget')
    .update({ calls: calls + 1, updated_at: new Date().toISOString() })
    .eq('day', day)
    .eq('calls', calls)
    .select('calls');
  return Array.isArray(updated) && updated.length === 1;
}
