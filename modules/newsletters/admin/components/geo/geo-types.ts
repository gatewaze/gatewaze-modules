/** Types + small pure helpers for the geo-engagement RPC contracts (spec §7). */

export const RPC_SCHEMA_VERSION = 1;

export interface GeoMeta {
  schema_version: number;
  total_events: number;
  coverage_pct: number;
  suppressed_buckets: number;
  tz_fallback: number;
}

export interface GeoEnvelope<T> {
  data: T[];
  meta: GeoMeta;
}

export type GeoMetric = 'open' | 'click';
export type GeoLevel = 'country' | 'city';

/** R1 newsletter_geo_engagement row. */
export interface GeoEngagementRow {
  region_code: string;
  region_name: string;
  level: GeoLevel;
  delivered_profile: number;
  engaged_profile: number;
  rate_profile: number | null;
  count_ip: number;
  geo_source: string;
}

/** R2 newsletter_local_time_engagement row. */
export interface LocalTimeRow {
  dow: number;       // 0=Sun..6=Sat
  hour: number;      // 0..23
  event_count: number;
  recipients_in_tz: number;
  rate: number | null;
}

/** R3 newsletter_block_geo row. */
export interface BlockGeoRow {
  block_id: string;
  block_type: string;
  block_label: string;
  region_code: string;
  region_name: string;
  clicks: number;
}

/** R4 newsletter_block_option_geo row. */
export interface OptionGeoRow {
  edition_link_id: string;
  option_label: string;
  region_code: string;
  region_name: string;
  clicks: number;
  share: number | null;
}

/** newsletter_block_effectiveness row (cross-edition block performance). */
export interface BlockEffectivenessRow {
  edition_id: string;
  edition_date: string | null;
  edition_title: string;
  block_type: string;
  clickers: number;
  events: number;
  delivered: number;
  ctr: number | null;
}

/** R5 newsletter_engagement_timeline row. */
export interface TimelineRow {
  bucket_start: string;
  region_code: string;
  region_name: string;
  opens: number;
  clicks: number;
}

/** True when an RPC envelope's contract version matches what the UI expects. */
export function schemaMatches(meta: GeoMeta | undefined): boolean {
  return !!meta && meta.schema_version === RPC_SCHEMA_VERSION;
}

/** True when an envelope carries no usable events (drives the empty state). */
export function isEmpty(env: GeoEnvelope<unknown> | null | undefined): boolean {
  return !env || !env.meta || env.meta.total_events === 0 || env.data.length === 0;
}
