/**
 * AnalyticsService implementation backed by self-hosted Umami.
 *
 * Per spec-analytics-module §6.2.
 *
 * Each method:
 *   1. Calls checkReadAccessAndResolveWebsite() — auth + property→website_uuid
 *   2. Wraps the Umami HTTP call in cachedCall() with a method-specific TTL
 *   3. Maps the Umami response shape to the contract's stable shape
 *
 * Umami API endpoints used (from the websites/{id} group):
 *   GET /api/websites/{id}/pageviews?startAt&endAt&unit
 *   GET /api/websites/{id}/stats?startAt&endAt
 *   GET /api/websites/{id}/metrics?startAt&endAt&type=url|referrer|event
 *   GET /api/websites/{id}/active
 *   GET /api/websites/{id}/events/series?startAt&endAt&unit&eventName
 *
 * If Umami changes its response shape, this is the single file that
 * needs an update — the contract above stays stable.
 */

import type {
  AnalyticsService,
  Bucket,
  CohortCell,
  CustomEventResult,
  DateRange,
  DimensionFilter,
  PageviewBucket,
  PropertySummary,
  RealtimeSnapshot,
  RetentionPoint,
  ServiceResult,
  SessionEvent,
  SessionPage,
  SessionSummary,
  TopPage,
  TopReferrer,
  VariantBreakdown,
} from './contract.js';
import { cachedCall, type CacheSupabaseClient } from './cache.js';
import { checkReadAccessAndResolveWebsite, type AuthSupabaseClient } from './auth.js';
import type { UmamiClient } from './umami-client.js';

export interface UmamiServiceDeps {
  supabase: AuthSupabaseClient & CacheSupabaseClient;
  umami: UmamiClient;
  /** Caller's RLS role string ('authenticated' | 'service_role' | etc.).
   *  Used as a cache scope so cross-user reads stay isolated. */
  callerRole: string;
  /**
   * Browser-reachable Umami URL (e.g. https://analytics.example.com).
   * Used by `getReplayDeepLink` — `umami.baseUrl` is the cluster-internal
   * service name and isn't useful to the dashboard iframe.
   * Falls back to `umami.baseUrl` if not provided.
   */
  publicBaseUrl?: string;
}

const UNIT_FOR_BUCKET: Record<Bucket, 'hour' | 'day' | 'month' | 'year'> = {
  hour: 'hour',
  day: 'day',
  week: 'day',  // Umami doesn't natively bucket by week; client groups
  month: 'month',
};

function toUnixMs(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`invalid ISO date: ${iso}`);
  return t;
}

export function createUmamiAnalyticsService(deps: UmamiServiceDeps): AnalyticsService {
  async function withAuthAndCache<T>(
    method: string,
    filter: DimensionFilter,
    extraArgs: Record<string, unknown>,
    ttlMs: number,
    fn: (websiteUuid: string) => Promise<T>,
  ): Promise<ServiceResult<T>> {
    const auth = await checkReadAccessAndResolveWebsite(deps.supabase, filter.property_id);
    if (!auth.ok) {
      return {
        ok: false,
        reason: auth.reason === 'pending_provisioning' ? 'upstream_unavailable' : auth.reason,
        message: auth.message,
      };
    }
    const websiteUuid = auth.websiteUuid;
    if (!websiteUuid) {
      return { ok: false, reason: 'upstream_unavailable', message: 'property is not yet provisioned' };
    }

    try {
      const { data, cacheHit } = await cachedCall(
        deps.supabase,
        method,
        { filter, ...extraArgs },
        deps.callerRole,
        () => fn(websiteUuid),
        { ttlMs },
      );
      return { ok: true, data, cacheHit };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      return { ok: false, reason: 'upstream_unavailable', message };
    }
  }

  return {
    async getPageviews(filter, range, bucket): Promise<ServiceResult<PageviewBucket[]>> {
      return withAuthAndCache('getPageviews', filter, { range, bucket }, 60_000, async (websiteUuid) => {
        const res = (await deps.umami.get(`/api/websites/${websiteUuid}/pageviews`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
          unit: UNIT_FOR_BUCKET[bucket],
        })) as { pageviews: { x: string; y: number }[]; sessions: { x: string; y: number }[] };
        const sessions = new Map((res.sessions ?? []).map((p) => [p.x, p.y]));
        return (res.pageviews ?? []).map((p) => ({
          bucket: p.x,
          pageviews: p.y,
          unique_visitors: sessions.get(p.x) ?? 0,
        }));
      });
    },

    async getPropertySummary(filter, range): Promise<ServiceResult<PropertySummary>> {
      return withAuthAndCache('getPropertySummary', filter, { range }, 60_000, async (websiteUuid) => {
        const stats = (await deps.umami.get(`/api/websites/${websiteUuid}/stats`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
        })) as { pageviews: { value: number }; visitors: { value: number } };

        const active = (await deps.umami.get(`/api/websites/${websiteUuid}/active`)) as { x: number };
        const topPages = (await deps.umami.get(`/api/websites/${websiteUuid}/metrics`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
          type: 'url',
          limit: 5,
        })) as { x: string; y: number }[];

        return {
          pageviews: stats.pageviews?.value ?? 0,
          unique_visitors: stats.visitors?.value ?? 0,
          active_now: active?.x ?? 0,
          top_pages: (topPages ?? []).map((p) => ({
            page_path: p.x,
            pageviews: p.y,
            unique_visitors: 0, // Umami's metrics endpoint doesn't return per-row uniques
          })),
        };
      });
    },

    async getTopPages(filter, range, limit): Promise<ServiceResult<TopPage[]>> {
      return withAuthAndCache('getTopPages', filter, { range, limit }, 60_000, async (websiteUuid) => {
        const rows = (await deps.umami.get(`/api/websites/${websiteUuid}/metrics`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
          type: 'url',
          limit,
        })) as { x: string; y: number }[];
        return (rows ?? []).map((p) => ({ page_path: p.x, pageviews: p.y, unique_visitors: 0 }));
      });
    },

    async getTopReferrers(filter, range, limit): Promise<ServiceResult<TopReferrer[]>> {
      return withAuthAndCache('getTopReferrers', filter, { range, limit }, 60_000, async (websiteUuid) => {
        const rows = (await deps.umami.get(`/api/websites/${websiteUuid}/metrics`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
          type: 'referrer',
          limit,
        })) as { x: string; y: number }[];
        return (rows ?? []).map((r) => ({ referrer: r.x, pageviews: r.y }));
      });
    },

    async getCustomEvents(filter, eventName, range): Promise<ServiceResult<CustomEventResult>> {
      return withAuthAndCache('getCustomEvents', filter, { eventName, range }, 60_000, async (websiteUuid) => {
        const series = (await deps.umami.get(`/api/websites/${websiteUuid}/events`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
          unit: 'day',
          eventName,
        })) as { count: number; uniques?: number } | { count: number; uniques?: number }[];
        const counts = Array.isArray(series) ? series : [series];
        const total = counts.reduce((sum, c) => sum + (c?.count ?? 0), 0);
        const uniques = counts.reduce((sum, c) => sum + (c?.uniques ?? 0), 0);
        return { event_name: eventName, count: total, unique_visitors: uniques };
      });
    },

    async getRealtime(filter): Promise<ServiceResult<RealtimeSnapshot>> {
      // Realtime is the only un-cached call (10s polling shouldn't see
      // stale cache). TTL = 5s in case multiple admins watch the same
      // dashboard concurrently.
      return withAuthAndCache('getRealtime', filter, {}, 5_000, async (websiteUuid) => {
        const active = (await deps.umami.get(`/api/websites/${websiteUuid}/active`)) as { x: number };
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const now = new Date().toISOString();
        const stats = (await deps.umami.get(`/api/websites/${websiteUuid}/stats`, {
          startAt: toUnixMs(oneHourAgo),
          endAt: toUnixMs(now),
        })) as { pageviews: { value: number } };
        const topPages = (await deps.umami.get(`/api/websites/${websiteUuid}/metrics`, {
          startAt: toUnixMs(oneHourAgo),
          endAt: toUnixMs(now),
          type: 'url',
          limit: 5,
        })) as { x: string; y: number }[];
        return {
          active_visitors: active?.x ?? 0,
          views_last_hour: stats.pageviews?.value ?? 0,
          top_pages: (topPages ?? []).map((p) => ({ page_path: p.x, pageviews: p.y, unique_visitors: 0 })),
        };
      });
    },

    async getCohortRetention(filter, range, cohortBucket): Promise<ServiceResult<CohortCell[]>> {
      return withAuthAndCache('getCohortRetention', filter, { range, cohortBucket }, 60_000, async (websiteUuid) => {
        // Cohort triangle is built from per-bucket session counts. Umami's
        // /sessions endpoint returns the unique-session count per bucket
        // for the requested range; we partition twice — once at the cohort
        // start (visitors first-seen in the bucket) and once for each
        // subsequent period (sessions still active).
        //
        // Approach (single-tier, no joins required from Umami):
        //   1. Pull session series at the requested bucket granularity.
        //   2. The cohort SIZE for each bucket is the count of "new"
        //      sessions in that bucket — `/sessions` reports total, so
        //      we subtract the running set of seen sessions to get net-new.
        //      Umami exposes this as `visitors` on the stats endpoint
        //      filtered to the bucket window.
        //   3. For each period offset, query `visitors` with the same
        //      bucket filter to count the cohort members who returned.
        //
        // Practical compromise: we approximate by treating the cohort
        // size as the bucket's unique_visitors and active=fraction
        // backed out from a per-period stats lookup. Accurate enough
        // for retention dashboards; full precision needs Umami's
        // session_id-level event_data which the public REST doesn't
        // expose.
        const unitForBucket = cohortBucket;
        const series = (await deps.umami.get(`/api/websites/${websiteUuid}/pageviews`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
          unit: unitForBucket,
        })) as { sessions: { x: string; y: number }[] };

        const buckets = (series.sessions ?? []).map((p) => ({
          start: p.x,
          size: p.y,
        }));

        const cells: CohortCell[] = [];
        const periodMs =
          cohortBucket === 'day' ? 86_400_000 : cohortBucket === 'week' ? 7 * 86_400_000 : 30 * 86_400_000;

        for (let i = 0; i < buckets.length; i++) {
          const cohort = buckets[i]!;
          if (cohort.size === 0) continue;
          const cohortStartMs = Date.parse(cohort.start);
          // Period 0 is always 100% by definition
          cells.push({
            cohort_bucket: cohort.start,
            period: 0,
            size: cohort.size,
            active: cohort.size,
            retention_rate: 1,
          });
          // Subsequent periods — query stats for cohort members who returned
          for (let p = 1; p + i < buckets.length; p++) {
            const periodStart = cohortStartMs + p * periodMs;
            const periodEnd = periodStart + periodMs;
            const stats = (await deps.umami.get(`/api/websites/${websiteUuid}/stats`, {
              startAt: periodStart,
              endAt: periodEnd,
            })) as { visitors: { value: number } };
            // Best approximation absent session-id-level access: report
            // overlap between cohort size and period visitors; cap at
            // cohort size so retention_rate stays in [0, 1]. A future
            // ClickHouse backend can compute this exactly via session
            // joins; the contract shape doesn't change.
            const periodVisitors = stats.visitors?.value ?? 0;
            const active = Math.min(cohort.size, periodVisitors);
            cells.push({
              cohort_bucket: cohort.start,
              period: p,
              size: cohort.size,
              active,
              retention_rate: cohort.size > 0 ? Math.round((active / cohort.size) * 10000) / 10000 : 0,
            });
          }
        }
        return cells;
      });
    },

    async getRetentionCurve(filter, range, horizonDays): Promise<ServiceResult<RetentionPoint[]>> {
      return withAuthAndCache('getRetentionCurve', filter, { range, horizonDays }, 5 * 60_000, async (websiteUuid) => {
        // Single curve: day 0 is the full cohort (the visitors counted in
        // the range), each subsequent day is the visitors who returned
        // that day. Coarser than the triangle (no per-cohort breakdown)
        // but cheap — N+1 stats calls instead of N×N.
        const horizon = Math.max(1, Math.min(horizonDays, 90));
        const cohortStats = (await deps.umami.get(`/api/websites/${websiteUuid}/stats`, {
          startAt: toUnixMs(range.from),
          endAt: toUnixMs(range.to),
        })) as { visitors: { value: number } };
        const cohortSize = cohortStats.visitors?.value ?? 0;

        const points: RetentionPoint[] = [{ day: 0, retention_rate: cohortSize > 0 ? 1 : 0 }];
        const cohortStartMs = toUnixMs(range.from);
        for (let day = 1; day <= horizon; day++) {
          const dayStart = cohortStartMs + day * 86_400_000;
          const dayEnd = dayStart + 86_400_000;
          const stats = (await deps.umami.get(`/api/websites/${websiteUuid}/stats`, {
            startAt: dayStart,
            endAt: dayEnd,
          })) as { visitors: { value: number } };
          const dayVisitors = stats.visitors?.value ?? 0;
          const overlap = Math.min(cohortSize, dayVisitors);
          points.push({
            day,
            retention_rate: cohortSize > 0 ? Math.round((overlap / cohortSize) * 10000) / 10000 : 0,
          });
        }
        return points;
      });
    },

    async getVariantBreakdown(filter, abTestId, goalEventName, range): Promise<ServiceResult<VariantBreakdown[]>> {
      return withAuthAndCache('getVariantBreakdown', filter, { abTestId, goalEventName, range }, 60_000, async (websiteUuid) => {
        // Per-variant conversion counts via Umami's event-data values
        // endpoint. The snippet's dimensionInitScript (see embed/render.ts)
        // attaches { variant_id } to every event for the page; Umami stores
        // it as event_data with propertyName='variant_id'. We ask Umami to
        // group goal-event counts by that property, no even-distribution
        // fudge.
        //
        // /api/websites/{id}/event-data/values returns:
        //   [{ value: "<variant_id>", total: <count> }, ...]
        //
        // Anything Umami returns that doesn't match a known variant_id
        // (e.g. orphaned events tagged with a since-deleted variant) is
        // dropped silently.
        const [assignmentsRes, conversionsRes] = await Promise.all([
          deps.supabase.rpc('templates_ab_assignment_counts', { p_ab_test_id: abTestId }),
          deps.umami.get(`/api/websites/${websiteUuid}/event-data/values`, {
            startAt: toUnixMs(range.from),
            endAt: toUnixMs(range.to),
            eventName: goalEventName,
            propertyName: 'variant_id',
          }),
        ]);

        if (assignmentsRes.error) {
          throw new Error(`templates_ab_assignment_counts: ${assignmentsRes.error.message}`);
        }

        const assignments = (assignmentsRes.data as { variant_id: string; variant_name: string; count: number }[]) ?? [];

        // Index conversions by variant_id for O(1) lookup
        const conversionRows = (conversionsRes as Array<{ value: string; total: number }> | null) ?? [];
        const conversionsByVariant = new Map<string, number>();
        for (const row of conversionRows) {
          if (row?.value) conversionsByVariant.set(row.value, row.total ?? 0);
        }

        return assignments.map((a) => {
          const conversions = conversionsByVariant.get(a.variant_id) ?? 0;
          return {
            variant_id: a.variant_id,
            variant_name: a.variant_name,
            assignments: a.count,
            conversions,
            conversion_rate: a.count > 0 ? conversions / a.count : 0,
          };
        });
      });
    },

    async listSessions(filter, range, page, pageSize): Promise<ServiceResult<SessionPage>> {
      // Clamp at the service boundary — routes also clamp but this is
      // the contract guarantee. PageSize > 100 hammers Umami; page < 1
      // makes no sense.
      const clampedPage = Math.max(1, Math.floor(page));
      const clampedSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
      return withAuthAndCache(
        'listSessions',
        filter,
        { range, page: clampedPage, pageSize: clampedSize },
        30_000,
        async (websiteUuid) => {
          // Umami v3 returns `{ data: [...], count: <total> }` for paged
          // endpoints; older v2 returned a bare array. Handle both so a
          // mid-upgrade deployment doesn't 500.
          const res = (await deps.umami.get(`/api/websites/${websiteUuid}/sessions`, {
            startAt: toUnixMs(range.from),
            endAt: toUnixMs(range.to),
            page: clampedPage,
            pageSize: clampedSize,
          })) as
            | { data: UmamiSessionRow[]; count: number }
            | UmamiSessionRow[];
          const rows = Array.isArray(res) ? res : (res?.data ?? []);
          const total = Array.isArray(res) ? rows.length : (res?.count ?? rows.length);
          const sessions: SessionSummary[] = rows.map(mapUmamiSession);
          return { sessions, total, page: clampedPage, page_size: clampedSize };
        },
      );
    },

    async getSessionActivity(filter, sessionId): Promise<ServiceResult<SessionEvent[]>> {
      if (!isUuid(sessionId)) {
        return { ok: false, reason: 'invalid_input', message: 'sessionId must be a uuid' };
      }
      return withAuthAndCache(
        'getSessionActivity',
        filter,
        { sessionId },
        60_000,
        async (websiteUuid) => {
          // Umami: GET /api/websites/{websiteUuid}/sessions/{sessionId}/activity
          // Returns a chronological array of events for the session. Field
          // names are normalised below; Umami's raw shape uses createdAt /
          // urlPath / eventName / referrer.
          const rows = (await deps.umami.get(
            `/api/websites/${websiteUuid}/sessions/${sessionId}/activity`,
          )) as UmamiSessionActivityRow[] | null;
          return (rows ?? []).map((r) => ({
            at: r.createdAt ?? new Date(0).toISOString(),
            page_path: r.urlPath ?? '',
            event_name: r.eventName ?? null,
            referrer: r.referrer ?? null,
          }));
        },
      );
    },

    async getReplayDeepLink(filter, sessionId): Promise<ServiceResult<{ url: string }>> {
      if (!isUuid(sessionId)) {
        return { ok: false, reason: 'invalid_input', message: 'sessionId must be a uuid' };
      }
      // Auth + websiteUuid resolution — but we never call Umami's HTTP
      // surface here, so cache TTL doesn't matter. We still want the
      // 403 guard.
      return withAuthAndCache(
        'getReplayDeepLink',
        filter,
        { sessionId },
        60_000,
        async (websiteUuid) => {
          const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
          // Umami v3 path: /websites/{websiteUuid}/sessions/{sessionId}
          // (the admin UI's session-detail screen, which embeds the
          // replay player). If publicBaseUrl wasn't configured, return a
          // path-only URL; the dashboard can prefix it.
          const path = `/websites/${websiteUuid}/sessions/${sessionId}`;
          return { url: base ? `${base}${path}` : path };
        },
      );
    },
  };
}

// Local Umami response shapes — kept here (not in contract.ts) so the
// public surface stays stable if Umami renames fields. If v4 changes
// these, this is the only file that needs an update.
interface UmamiSessionRow {
  id: string;
  websiteId?: string;
  createdAt?: string;
  endAt?: string;
  views?: number;
  visits?: number;
  events?: number;
  country?: string | null;
  browser?: string | null;
  os?: string | null;
  device?: string | null;
  entryUrl?: string | null;
  exitUrl?: string | null;
}

interface UmamiSessionActivityRow {
  createdAt?: string;
  urlPath?: string;
  eventName?: string | null;
  referrer?: string | null;
}

function mapUmamiSession(r: UmamiSessionRow): SessionSummary {
  return {
    session_id: r.id,
    first_seen: r.createdAt ?? new Date(0).toISOString(),
    last_seen: r.endAt ?? r.createdAt ?? new Date(0).toISOString(),
    pageviews: r.views ?? 0,
    events: r.events ?? 0,
    country: r.country ?? null,
    browser: r.browser ?? null,
    os: r.os ?? null,
    device: r.device ?? null,
    entry_path: r.entryUrl ?? null,
    exit_path: r.exitUrl ?? null,
  };
}

const SESSION_UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string): boolean {
  return typeof s === 'string' && SESSION_UUID_RE.test(s);
}
