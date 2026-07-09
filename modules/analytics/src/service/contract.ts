/**
 * analyticsService contract — the single chokepoint every dashboard,
 * admin panel, and API route goes through. Designed to outlive the
 * Umami backend (Path 2 = swap to ClickHouse / Tinybird is one file).
 *
 * Per spec-analytics-module §6.1.
 *
 * Every method:
 *   1. Calls can_read_analytics_property(filter.property_id) first; 403s
 *      if the caller lacks access.
 *   2. Computes a cache key including caller_role so cross-user reads
 *      are impossible.
 *   3. Returns a uniform result shape — no Umami-specific fields leak.
 */

export type DateRange = {
  /** ISO 8601 start (inclusive). */
  from: string;
  /** ISO 8601 end (exclusive). */
  to: string;
};

export type Bucket = 'hour' | 'day' | 'week' | 'month';

export interface DimensionFilter {
  /** ALWAYS required — every query is scoped to one property. */
  property_id: string;
  page_id?: string;
  page_path?: string;
  variant_id?: string;
  ab_test_id?: string;
}

export interface PageviewBucket {
  bucket: string;             // ISO 8601 bucket start
  pageviews: number;
  unique_visitors: number;
}

export interface TopPage {
  page_path: string;
  pageviews: number;
  unique_visitors: number;
}

export interface TopReferrer {
  referrer: string;           // domain only — Umami strips query strings
  pageviews: number;
}

export interface PropertySummary {
  pageviews: number;
  unique_visitors: number;
  active_now: number;         // sessions in the last 5 min
  top_pages: TopPage[];
}

export interface CustomEventResult {
  event_name: string;
  count: number;
  unique_visitors: number;
}

export interface RealtimeSnapshot {
  active_visitors: number;
  views_last_hour: number;
  top_pages: TopPage[];
}

export interface VariantBreakdown {
  variant_id: string;
  variant_name: string;
  assignments: number;
  conversions: number;
  conversion_rate: number;    // 0..1
}

/**
 * One cohort cell — N visitors who first arrived in `cohort_bucket`,
 * `period` periods later, of whom `active` are still active.
 *
 * Used to render the standard cohort retention triangle. `period=0`
 * is the cohort itself (always active=size). period=1 is one bucket
 * later (e.g. one week, one month).
 */
export interface CohortCell {
  /** ISO 8601 start of the cohort acquisition bucket. */
  cohort_bucket: string;
  /** 0-indexed period offset from the cohort. */
  period: number;
  /** Number of original cohort members. Constant within a cohort. */
  size: number;
  /** How many of those members were active in this period. */
  active: number;
  /** active / size, rounded to 4dp. Convenience for chart code. */
  retention_rate: number;
}

/**
 * Single retention curve — sessions returning N days after first visit.
 * Derived from event_data on cohort start dates; cheaper than full
 * cohort triangle when only the headline curve is needed.
 */
export interface RetentionPoint {
  /** Days since first visit (0..N). */
  day: number;
  /** Fraction of original cohort still active that day (0..1). */
  retention_rate: number;
}

/**
 * Single session row — one visitor's session as seen by Umami.
 *
 * Umami v3 surfaces these via `/api/websites/{id}/sessions`. Used to
 * feed the "Session list" pane in the property dashboard; clicking a
 * row drills into `SessionEvent[]` via `getSessionActivity`.
 *
 * Field set is the intersection that's stable across Umami versions —
 * we deliberately omit anything Umami might rename (raw IP, fingerprint).
 */
export interface SessionSummary {
  /** Umami session uuid; opaque to callers. */
  session_id: string;
  /** ISO 8601 of the first event in the session. */
  first_seen: string;
  /** ISO 8601 of the last event. */
  last_seen: string;
  /** Number of pageviews recorded. */
  pageviews: number;
  /** Number of custom events recorded. */
  events: number;
  country: string | null;     // ISO-3166 alpha-2; null if Umami couldn't resolve
  browser: string | null;
  os: string | null;
  device: string | null;      // 'desktop' | 'mobile' | 'tablet' — Umami's classification
  /** Entry page path. */
  entry_path: string | null;
  /** Exit page path. */
  exit_path: string | null;
}

/**
 * One event within a session — a pageview, a custom event, or a tracker
 * heartbeat. Pageviews have `event_name === null`; custom events carry
 * the registered name. Used to drive the session-replay timeline.
 *
 * Note: this is the *event log*, not DOM-mutation replay frames. v3's
 * built-in session-replay UI is the authoritative replay player; this
 * surface is for analytics-side timelines (entry → conversion path).
 */
export interface SessionEvent {
  /** ISO 8601 event timestamp. */
  at: string;
  /** Page path the event fired on. */
  page_path: string;
  /** Custom event name; null for pageviews. */
  event_name: string | null;
  /** UTM / referrer info if present at session entry. */
  referrer: string | null;
}

/** Pagination envelope for `listSessions`. */
export interface SessionPage {
  sessions: SessionSummary[];
  /** Total session count for the range — for "page X of Y". */
  total: number;
  page: number;
  page_size: number;
}

/**
 * Result of an auth-failed call. Methods return this discriminated
 * union rather than throwing because callers (admin UI, API routes)
 * already know how to surface 403s but exception types vary by host.
 */
export type ServiceResult<T> =
  | { ok: true; data: T; cacheHit: boolean }
  | { ok: false; reason: 'forbidden' | 'property_not_found' | 'upstream_unavailable' | 'invalid_input'; message: string };

/**
 * The contract. Implementations: src/service/umami.ts (v1). Future:
 * src/service/clickhouse.ts.
 */
/** Umami-style headline overview: views/visits/visitors/bounce/duration
 *  with previous-period comparison, per spec §12.2 (v1 dashboard). */
export interface OverviewStats {
  pageviews: number;
  visitors: number;
  visits: number;
  /** 0..1 — bounces / visits. */
  bounce_rate: number;
  /** Mean visit duration in seconds. */
  avg_visit_seconds: number;
  active_now: number;
  /** Previous-period values for delta chips (same field meanings). */
  comparison: {
    pageviews: number;
    visitors: number;
    visits: number;
    bounce_rate: number;
    avg_visit_seconds: number;
  };
}

/** Dimensions the generic breakdown endpoint accepts — mirrors Umami v3's
 *  /metrics `type` values (path, not v2's url). */
export type BreakdownType =
  | 'path' | 'referrer' | 'browser' | 'os' | 'device'
  | 'country' | 'region' | 'city' | 'language' | 'title'
  | 'event' | 'hostname' | 'query' | 'tag';

export interface BreakdownRow {
  label: string;
  count: number;
}

/** One step of a funnel definition + its computed result. Mirrors
 *  Umami v3's POST /api/reports/funnel response rows. */
export interface FunnelStepDef {
  type: 'path' | 'event';
  value: string;
}
export interface FunnelStepResult extends FunnelStepDef {
  visitors: number;
  previous: number;
  dropped: number;
  /** Fraction dropped vs previous step (null on the first step). */
  dropoff: number | null;
  /** Fraction of the original cohort remaining at this step. */
  remaining: number;
}

/** One observed visitor path (pageviews + event names interleaved);
 *  null-padded to the requested step count. */
export interface JourneyPath {
  items: (string | null)[];
  count: number;
}

/** UTM dimension breakdowns — one list per utm_* parameter. */
export interface UtmReport {
  utm_source: BreakdownRow[];
  utm_medium: BreakdownRow[];
  utm_campaign: BreakdownRow[];
  utm_term: BreakdownRow[];
  utm_content: BreakdownRow[];
}

export interface AnalyticsService {
  /** Pageviews-over-time chart. */
  getPageviews(filter: DimensionFilter, range: DateRange, bucket: Bucket): Promise<ServiceResult<PageviewBucket[]>>;

  /** Headline summary card for the property dashboard. */
  getPropertySummary(filter: DimensionFilter, range: DateRange): Promise<ServiceResult<PropertySummary>>;

  /** Full Umami-style overview (views/visits/visitors/bounce/duration +
   *  previous-period comparison + active-now). */
  getOverview(filter: DimensionFilter, range: DateRange): Promise<ServiceResult<OverviewStats>>;

  /** Generic dimension breakdown (pages/referrers/browsers/os/devices/
   *  countries/languages/titles/events/hosts). */
  getBreakdown(filter: DimensionFilter, range: DateRange, type: BreakdownType, limit: number): Promise<ServiceResult<BreakdownRow[]>>;

  /** Ad-hoc funnel report (Umami v3 reports API). */
  runFunnel(filter: DimensionFilter, range: DateRange, steps: FunnelStepDef[], windowMinutes: number): Promise<ServiceResult<FunnelStepResult[]>>;

  /** Ad-hoc journey report — the most common N-step visitor paths. */
  runJourney(filter: DimensionFilter, range: DateRange, steps: number, startStep?: string, endStep?: string): Promise<ServiceResult<JourneyPath[]>>;

  /** UTM campaign breakdowns for the range. */
  runUtm(filter: DimensionFilter, range: DateRange): Promise<ServiceResult<UtmReport>>;

  /** Top pages by pageviews. */
  getTopPages(filter: DimensionFilter, range: DateRange, limit: number): Promise<ServiceResult<TopPage[]>>;

  /** Top referrers. */
  getTopReferrers(filter: DimensionFilter, range: DateRange, limit: number): Promise<ServiceResult<TopReferrer[]>>;

  /** Custom-event counts (cards, one per registered event). */
  getCustomEvents(filter: DimensionFilter, eventName: string, range: DateRange): Promise<ServiceResult<CustomEventResult>>;

  /** Realtime "active now" snapshot. */
  getRealtime(filter: DimensionFilter): Promise<ServiceResult<RealtimeSnapshot>>;

  /**
   * A/B variant comparison. Reads the templates_ab_assignments table for
   * the assignment count and Umami event_data for the conversion count.
   * goal_event_name comes from templates_ab_tests.goal_event_name.
   */
  getVariantBreakdown(filter: DimensionFilter, abTestId: string, goalEventName: string, range: DateRange): Promise<ServiceResult<VariantBreakdown[]>>;

  /**
   * Cohort retention triangle. Buckets visitors by their first-seen
   * date (per `cohortBucket`), then for each subsequent period reports
   * how many of those visitors were still active.
   *
   * Maps directly to the standard "users-acquired-this-week, % still
   * active week N" table — Umami's session-based aggregation gives us
   * the underlying counts; this method just shapes them.
   */
  getCohortRetention(
    filter: DimensionFilter,
    range: DateRange,
    cohortBucket: 'day' | 'week' | 'month',
  ): Promise<ServiceResult<CohortCell[]>>;

  /**
   * Single retention curve — fraction of the cohort still active N days
   * after first visit. Cheaper to compute than the full triangle when
   * only the headline curve is needed (e.g. for a sparkline on the
   * property summary card).
   */
  getRetentionCurve(
    filter: DimensionFilter,
    range: DateRange,
    horizonDays: number,
  ): Promise<ServiceResult<RetentionPoint[]>>;

  /**
   * Paginated list of sessions in `range`. Powers the session-replay
   * panel's left rail (clickable list) — the actual replay UI lives in
   * Umami v3 itself; we surface session metadata so the dashboard can
   * deep-link to the right replay (`getReplayDeepLink`).
   *
   * `pageSize` is clamped to 1..100. `page` is 1-indexed.
   */
  listSessions(
    filter: DimensionFilter,
    range: DateRange,
    page: number,
    pageSize: number,
  ): Promise<ServiceResult<SessionPage>>;

  /**
   * Per-session event log — pageview + custom-event timeline for a
   * single session. Used by the dashboard's "session detail" drawer
   * for showing the conversion path; *not* the DOM-mutation replay
   * stream (Umami v3's UI owns that).
   */
  getSessionActivity(
    filter: DimensionFilter,
    sessionId: string,
  ): Promise<ServiceResult<SessionEvent[]>>;

  /**
   * Returns a same-origin URL to Umami v3's built-in session replay
   * for `sessionId`. The dashboard embeds this in an iframe rather
   * than rebuilding the player. Returns `forbidden` if the caller
   * lacks read access to the property; `property_not_found` if the
   * session doesn't belong to it.
   */
  getReplayDeepLink(
    filter: DimensionFilter,
    sessionId: string,
  ): Promise<ServiceResult<{ url: string }>>;
}
