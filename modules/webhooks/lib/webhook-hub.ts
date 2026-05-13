/**
 * Webhook Hub — coalesces NOTIFY events, fans them out to subscribers,
 * and best-effort purges the Cloudflare CDN.
 *
 * Responsibilities (per spec-api-cache-and-revalidation §4.6):
 *   1. Materialise surrogate keys from each mutation event using the
 *      webhook_event_topics row (literal `surrogate_key_template` + per-row
 *      `detail_key_template` filled from the event's `row` payload).
 *   2. Debounce events within a 200ms window keyed by (host_kind, host_id).
 *      Events that share that key get their surrogate-key sets unioned and
 *      delivered as one POST per matching subscription.
 *   3. SELECT matching subscriptions, INSERT a webhook_deliveries row
 *      (status='pending') BEFORE each HTTP POST so the recovery sweep on
 *      restart can pick up pending rows.
 *   4. Sign + POST the payload. Retry with exponential backoff
 *      (30s / 2m / 10m / 1h / 6h / 24h), suspend after 10 consecutive
 *      permanent failures.
 *   5. Best-effort Cloudflare zone purge for the unioned surrogate-key set.
 *
 * In-process retry queue — v1 limitation per spec §4.6: a crash loses the
 * in-memory schedule. Mitigation: on startup, the LISTEN worker calls
 * runRecoverySweep() with 60s of random jitter spread across re-enqueued
 * rows, so we don't thunder-herd subscribers.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { signWebhook } from './hmac.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw shape of a NOTIFY payload on the gatewaze.mutation channel. */
export interface MutationEvent {
  topic: string;
  op: 'insert' | 'update' | 'delete';
  row_id: string | null;
  row: Record<string, string | null>;
  host_kind: 'site' | 'list' | 'newsletter' | 'global';
  host_id: string;
  ts: number;
}

/** Topic-config row stored in webhook_event_topics. */
export interface WebhookEventTopic {
  topic: string;
  host_id_column: string | null;
  surrogate_key_template: string;
  detail_key_template: string | null;
  notify_columns: string[];
}

/** Persisted subscription row (subset used by the Hub). */
export interface WebhookSubscriptionRow {
  id: string;
  host_kind: string;
  host_id: string;
  url: string;
  topics: string[];
  secret: string;
  secret_previous: string | null;
  status: 'enabled' | 'disabled' | 'suspended';
  consecutive_failures: number;
}

export interface WebhookDeliveryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  topic: string;
  op: string;
  row_id: string | null;
  payload: WebhookOutboundPayload;
  surrogate_keys: string[];
  status: 'pending' | 'sent' | 'failed' | 'permanently_failed' | 'skipped';
  attempt_count: number;
  next_retry_at: string | null;
  created_at: string;
}

/** Outbound POST body — matches spec §5.2. */
export interface WebhookOutboundPayload {
  id: string;
  event_id: string;
  delivered_at: number;
  host_kind: string;
  host_id: string;
  topic: string;
  op: 'insert' | 'update' | 'delete' | 'burst';
  row_id: string | null;
  row: Record<string, string | null>;
  surrogate_keys: string[];
  burst?: {
    window_start: number;
    window_end: number;
    event_count: number;
    topics: string[];
  };
}

/**
 * Narrow Supabase surface used by the Hub. The platform passes the
 * service-role client (RLS bypass); we don't depend on the full type so
 * the module workspace stays free of @supabase/supabase-js as a hard dep.
 */
export interface HubSupabaseQuery {
  select(cols: string): HubSupabaseQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): HubSupabaseQuery;
  update(values: Record<string, unknown>): HubSupabaseQuery;
  eq(col: string, val: unknown): HubSupabaseQuery;
  in(col: string, vals: unknown[]): HubSupabaseQuery;
  contains(col: string, val: unknown): HubSupabaseQuery;
  or(filter: string): HubSupabaseQuery;
  lt(col: string, val: unknown): HubSupabaseQuery;
  limit(n: number): HubSupabaseQuery;
  single<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  maybeSingle<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  then<TResult>(
    onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => TResult,
  ): Promise<TResult>;
}

export interface HubSupabaseClient {
  from(table: string): HubSupabaseQuery;
}

export interface HubLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CloudflarePurger {
  /**
   * Best-effort purge of the given surrogate keys. Spec §4.6: failure is
   * logged but NOT retried (themes get the cache-bust via Layer 2 anyway).
   */
  purgeTags(tags: readonly string[]): Promise<void>;
}

/** Globally-unique UUID used as host_id for `global` topics. */
const GLOBAL_HOST_ID = '00000000-0000-0000-0000-000000000000';

/** Retry schedule per spec §4.6 + §9.1: 30s, 2m, 10m, 1h, 6h, 24h. */
const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

/** Subscription auto-suspends after this many consecutive permanent failures. */
export const SUSPEND_AFTER_CONSECUTIVE_FAILURES = 10;

/** Debounce window before fan-out (§4.6). */
export const DEFAULT_DEBOUNCE_MS = 200;

/** HTTP timeout for outbound POSTs. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;

/** v1 mitigation for thundering-herd retries on restart (§4.6). */
export const RECOVERY_JITTER_MS = 60_000;

/**
 * Idempotency cache TTL for event_id de-dup. Subscribers receive
 * X-Gatewaze-Event-Id; if we ever see the same event_id within this
 * window we short-circuit and skip the delivery. v1 keeps this in-process
 * — a restart drops the cache, which is fine because deliveries already
 * persisted as 'sent' won't be re-enqueued.
 */
const EVENT_ID_DEDUP_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Coalescing buffer
// ---------------------------------------------------------------------------

interface PendingFlushGroup {
  hostKind: string;
  hostId: string;
  events: MutationEvent[];
  timer: NodeJS.Timeout;
  surrogateKeys: Set<string>;
  topics: Set<string>;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// WebhookHub
// ---------------------------------------------------------------------------

export interface WebhookHubOptions {
  supabase: HubSupabaseClient;
  logger: HubLogger;
  /** Optional best-effort CDN purger. When null, purges are skipped. */
  cloudflarePurger?: CloudflarePurger | null;
  /** Topic registry. The Hub loads this lazily via Supabase if not passed. */
  topicProvider?: (topic: string) => Promise<WebhookEventTopic | null>;
  debounceMs?: number;
  deliveryTimeoutMs?: number;
  /** Injected HTTP client — overrideable in tests. */
  fetchImpl?: typeof fetch;
  /** Override the wallclock — used in tests for deterministic retry scheduling. */
  now?: () => number;
}

export class WebhookHub {
  private readonly supabase: HubSupabaseClient;
  private readonly logger: HubLogger;
  private readonly cloudflarePurger: CloudflarePurger | null;
  private readonly topicProvider: (topic: string) => Promise<WebhookEventTopic | null>;
  private readonly debounceMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private readonly pending = new Map<string, PendingFlushGroup>();
  private readonly seenEventIds = new Map<string, number>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();

  // In-process topic cache. Cleared by clearTopicCache().
  private readonly topicCache = new Map<string, WebhookEventTopic | null>();

  constructor(opts: WebhookHubOptions) {
    this.supabase = opts.supabase;
    this.logger = opts.logger;
    this.cloudflarePurger = opts.cloudflarePurger ?? null;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.deliveryTimeoutMs = opts.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());

    this.topicProvider = opts.topicProvider ?? (async (topic) => {
      if (this.topicCache.has(topic)) {
        return this.topicCache.get(topic) ?? null;
      }
      const res = await this.supabase
        .from('webhook_event_topics')
        .select('topic, host_id_column, surrogate_key_template, detail_key_template, notify_columns')
        .eq('topic', topic)
        .maybeSingle<WebhookEventTopic>();
      const value = res.data ?? null;
      this.topicCache.set(topic, value);
      return value;
    });
  }

  /** Clears the in-process topic cache (used after migrations). */
  clearTopicCache(): void {
    this.topicCache.clear();
  }

  /**
   * Public entry point — called from listen-worker.ts on every NOTIFY.
   * Adds the event to a debounce bucket keyed by (host_kind, host_id);
   * flushes after debounceMs of inactivity.
   */
  enqueue(event: MutationEvent): void {
    const bucketKey = `${event.host_kind} ${event.host_id}`;
    let group = this.pending.get(bucketKey);
    if (!group) {
      group = {
        hostKind: event.host_kind,
        hostId: event.host_id,
        events: [],
        surrogateKeys: new Set(),
        topics: new Set(),
        timer: setTimeout(() => {
          this.pending.delete(bucketKey);
          void this.flushGroup(group as PendingFlushGroup);
        }, this.debounceMs),
        windowStart: event.ts,
      };
      this.pending.set(bucketKey, group);
    }
    group.events.push(event);
    group.topics.add(event.topic);
  }

  /** Flush all pending groups immediately. Used for shutdown. */
  async flushAll(): Promise<void> {
    const groups = Array.from(this.pending.values());
    this.pending.clear();
    for (const g of groups) clearTimeout(g.timer);
    await Promise.all(groups.map((g) => this.flushGroup(g)));
  }

  /**
   * Stop pending debounce + retry timers. Used in tests and on graceful
   * shutdown.
   */
  shutdown(): void {
    for (const g of this.pending.values()) clearTimeout(g.timer);
    this.pending.clear();
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
  }

  /**
   * Apply a single mutation event to its debounce group:
   *   1. Resolve topic config
   *   2. Materialise surrogate keys for this row
   *   3. Add them to the group's union set
   */
  private async materialiseGroup(group: PendingFlushGroup): Promise<void> {
    for (const ev of group.events) {
      const topic = await this.topicProvider(ev.topic);
      if (!topic) {
        this.logger.warn('webhooks.unknown_topic', { topic: ev.topic, op: ev.op });
        continue;
      }

      // Bulk surrogate key (literal — no placeholders in v1).
      group.surrogateKeys.add(topic.surrogate_key_template);

      // Detail key — fill {field} placeholders from ev.row. Missing fields
      // cause that specific detail key to be skipped, not the entire event.
      const detailTemplate = topic.detail_key_template;
      if (detailTemplate) {
        const filled = fillTemplate(detailTemplate, ev.row);
        if (filled) {
          group.surrogateKeys.add(filled);
        } else {
          this.logger.warn('webhooks.detail_key_skipped', {
            topic: ev.topic,
            template: detailTemplate,
            available: Object.keys(ev.row ?? {}),
          });
        }
      }
    }
  }

  /**
   * Flush a debounce group:
   *   1. Materialise surrogate keys
   *   2. SELECT matching subscriptions
   *   3. INSERT webhook_deliveries pending rows
   *   4. POST in parallel (with per-subscription delivery state)
   *   5. Best-effort Cloudflare purge for the unioned key set
   */
  private async flushGroup(group: PendingFlushGroup): Promise<void> {
    try {
      await this.materialiseGroup(group);
      if (group.surrogateKeys.size === 0) {
        // All events were for unknown topics — nothing to do.
        return;
      }
      const surrogateKeys = Array.from(group.surrogateKeys);
      const topics = Array.from(group.topics);

      // Best-effort CDN purge runs in parallel with the fan-out.
      const cdnPurge = this.cloudflarePurger
        ? this.cloudflarePurger.purgeTags(surrogateKeys).catch((err: unknown) => {
            this.logger.warn('webhooks.cloudflare_purge_failed', {
              error: err instanceof Error ? err.message : String(err),
              tags: surrogateKeys,
            });
          })
        : Promise.resolve();

      // Find subscriptions matching this host_kind/host_id whose topics
      // overlap (or are wildcard). topics: '{}' means "all"; otherwise the
      // subscription is interested only if at least one of its topics is in
      // the event set.
      const subs = await this.findMatchingSubscriptions(group.hostKind, group.hostId, topics);

      // event_id correlates the fan-out from this group across N subscribers.
      const eventId = randomUUID();
      const isBurst = group.events.length > 5; // heuristic: >5 events in 200ms is "burst-y"

      // Build per-subscription deliveries (one delivery row per (sub, event)).
      // For v1 we coalesce all events in this group into a single payload per
      // sub — that's the whole point of the debounce window.
      const op: WebhookOutboundPayload['op'] = isBurst ? 'burst' : (group.events[0]?.op ?? 'update');
      const representativeEvent = group.events[group.events.length - 1] ?? null;
      const rowId = isBurst ? null : (representativeEvent?.row_id ?? null);
      const row = isBurst ? {} : (representativeEvent?.row ?? {});
      const burstEnvelope = isBurst
        ? {
            window_start: group.windowStart,
            window_end: representativeEvent?.ts ?? group.windowStart,
            event_count: group.events.length,
            topics,
          }
        : undefined;
      const representativeTopic = isBurst ? 'burst' : (representativeEvent?.topic ?? topics[0] ?? 'unknown');

      for (const sub of subs) {
        const deliveryId = randomUUID();
        const payload: WebhookOutboundPayload = {
          id: deliveryId,
          event_id: eventId,
          delivered_at: Math.floor(this.now() / 1000),
          host_kind: group.hostKind,
          host_id: group.hostId,
          topic: representativeTopic,
          op,
          row_id: rowId,
          row,
          surrogate_keys: surrogateKeys,
          ...(burstEnvelope ? { burst: burstEnvelope } : {}),
        };

        // INSERT pending row BEFORE the HTTP call so the recovery sweep
        // catches in-flight deliveries on api restart.
        const insertRes = await this.supabase.from('webhook_deliveries').insert({
          id: deliveryId,
          subscription_id: sub.id,
          event_id: eventId,
          topic: representativeTopic,
          op,
          row_id: rowId,
          payload,
          surrogate_keys: surrogateKeys,
          status: 'pending',
        });
        const err = (insertRes as unknown as { error?: { message: string } | null }).error;
        if (err) {
          this.logger.error('webhooks.delivery_insert_failed', {
            subscription_id: sub.id,
            error: err.message,
          });
          continue;
        }

        // Fire-and-forget per-sub delivery. We don't await the whole loop —
        // each subscription gets its own retry timeline so a slow one
        // doesn't block faster siblings.
        void this.attemptDelivery(sub, deliveryId, payload, 0);
      }

      await cdnPurge;
    } catch (err) {
      this.logger.error('webhooks.flush_group_failed', {
        host_kind: group.hostKind,
        host_id: group.hostId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * SELECT subscriptions whose host matches AND whose topic filter accepts
   * at least one of the event's topics.
   *
   * Postgres-side filter: status='enabled' AND host_kind=? AND host_id=?.
   * The topics overlap is enforced in JS — Supabase doesn't expose `&&` for
   * text[] arrays cleanly and the list of enabled subs per host is small.
   */
  private async findMatchingSubscriptions(
    hostKind: string,
    hostId: string,
    eventTopics: string[],
  ): Promise<WebhookSubscriptionRow[]> {
    const baseQuery = this.supabase
      .from('webhook_subscriptions')
      .select('id, host_kind, host_id, url, topics, secret, secret_previous, status, consecutive_failures')
      .eq('host_kind', hostKind)
      .eq('host_id', hostId)
      .eq('status', 'enabled');

    const res = await baseQuery;
    if (res.error) {
      this.logger.error('webhooks.subscription_lookup_failed', { error: res.error.message });
      return [];
    }
    const rows = (res.data ?? []) as unknown as WebhookSubscriptionRow[];

    // Global topics: any subscription with host_kind='global' on
    // host_id=GLOBAL_HOST_ID matches every global-topic event for any
    // host. The trigger function already writes host_id=GLOBAL_HOST_ID
    // for global topics, so the SQL eq() does the right thing.
    void GLOBAL_HOST_ID; // referenced for documentation; logic above already enforces.

    // Topics filter — empty array means "all".
    return rows.filter((s) => {
      if (!Array.isArray(s.topics) || s.topics.length === 0) return true;
      for (const t of s.topics) {
        if (eventTopics.includes(t)) return true;
      }
      return false;
    });
  }

  /**
   * Per-subscription delivery loop. Retries up to RETRY_DELAYS_MS.length
   * attempts; auto-suspends the subscription after
   * SUSPEND_AFTER_CONSECUTIVE_FAILURES permanent failures.
   */
  private async attemptDelivery(
    sub: WebhookSubscriptionRow,
    deliveryId: string,
    payload: WebhookOutboundPayload,
    attemptIndex: number,
  ): Promise<void> {
    if (this.seenEventIds.has(`${sub.id}:${payload.event_id}:${attemptIndex}`)) {
      this.logger.warn('webhooks.delivery_dedup_skipped', {
        subscription_id: sub.id,
        event_id: payload.event_id,
        attempt: attemptIndex,
      });
      return;
    }
    this.seenEventIds.set(
      `${sub.id}:${payload.event_id}:${attemptIndex}`,
      this.now() + EVENT_ID_DEDUP_TTL_MS,
    );
    this.pruneEventIdCache();

    const rawBody = JSON.stringify(payload);
    const { signature, timestamp } = signWebhook(sub.secret, rawBody);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-gatewaze-signature': signature,
      'x-gatewaze-timestamp': String(timestamp),
      'x-gatewaze-event-id': payload.event_id,
      'x-gatewaze-delivery-id': deliveryId,
      'user-agent': 'Gatewaze-Webhook/1.0',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);

    let responseStatus: number | null = null;
    let responseBody = '';
    let networkError: string | null = null;

    try {
      const res = await this.fetchImpl(sub.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal,
      });
      responseStatus = res.status;
      try {
        // Cap body length to avoid filling webhook_deliveries with megabytes.
        responseBody = (await res.text()).slice(0, 4096);
      } catch {
        responseBody = '';
      }
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
    }

    const ok = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;

    if (ok) {
      await this.supabase
        .from('webhook_deliveries')
        .update({
          status: 'sent',
          attempt_count: attemptIndex + 1,
          first_sent_at: new Date(this.now()).toISOString(),
          succeeded_at: new Date(this.now()).toISOString(),
          last_response_status: responseStatus,
          last_response_body: responseBody,
          last_error: null,
        })
        .eq('id', deliveryId);
      await this.supabase
        .from('webhook_subscriptions')
        .update({
          consecutive_failures: 0,
          last_success_at: new Date(this.now()).toISOString(),
        })
        .eq('id', sub.id);
      return;
    }

    // 410 Gone — auto-disable per spec §9.5.
    if (responseStatus === 410) {
      await this.supabase
        .from('webhook_deliveries')
        .update({
          status: 'permanently_failed',
          attempt_count: attemptIndex + 1,
          last_response_status: responseStatus,
          last_response_body: responseBody,
          last_error: 'subscriber returned 410 Gone',
        })
        .eq('id', deliveryId);
      await this.supabase
        .from('webhook_subscriptions')
        .update({
          status: 'disabled',
          last_failure_at: new Date(this.now()).toISOString(),
          last_failure_message: 'subscriber returned 410 Gone',
        })
        .eq('id', sub.id);
      this.logger.warn('webhooks.subscription_auto_disabled_410', {
        subscription_id: sub.id,
        url: sub.url,
      });
      return;
    }

    // Retryable failure
    const nextAttempt = attemptIndex + 1;
    if (nextAttempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[nextAttempt];
      if (typeof delay !== 'number') {
        // Shouldn't happen — RETRY_DELAYS_MS is statically defined — but
        // satisfy noUncheckedIndexedAccess.
        return;
      }
      const nextRetryAt = new Date(this.now() + delay).toISOString();
      await this.supabase
        .from('webhook_deliveries')
        .update({
          status: 'failed',
          attempt_count: nextAttempt,
          next_retry_at: nextRetryAt,
          last_response_status: responseStatus,
          last_response_body: responseBody,
          last_error: networkError ?? `http ${responseStatus ?? 'no-response'}`,
        })
        .eq('id', deliveryId);
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        void this.attemptDelivery(sub, deliveryId, payload, nextAttempt);
      }, delay);
      this.retryTimers.add(timer);
      return;
    }

    // No more retries — permanent.
    await this.supabase
      .from('webhook_deliveries')
      .update({
        status: 'permanently_failed',
        attempt_count: nextAttempt,
        last_response_status: responseStatus,
        last_response_body: responseBody,
        last_error: networkError ?? `http ${responseStatus ?? 'no-response'}`,
      })
      .eq('id', deliveryId);

    const newConsecutive = (sub.consecutive_failures ?? 0) + 1;
    const subUpdate: Record<string, unknown> = {
      consecutive_failures: newConsecutive,
      last_failure_at: new Date(this.now()).toISOString(),
      last_failure_message: networkError ?? `http ${responseStatus ?? 'no-response'}`,
    };
    if (newConsecutive >= SUSPEND_AFTER_CONSECUTIVE_FAILURES) {
      subUpdate.status = 'suspended';
      this.logger.warn('webhooks.subscription_auto_suspended', {
        subscription_id: sub.id,
        url: sub.url,
        consecutive_failures: newConsecutive,
      });
    }
    await this.supabase
      .from('webhook_subscriptions')
      .update(subUpdate)
      .eq('id', sub.id);
  }

  /**
   * Recovery sweep — called from the LISTEN worker on connect/reconnect.
   * Re-claims `pending` deliveries created more than 10s ago AND `failed`
   * deliveries whose next_retry_at has passed.
   *
   * Per spec §4.6: jitters re-fires over a 60s window to avoid thundering
   * herd when the api restarts with many pending retries.
   */
  async runRecoverySweep(): Promise<{ recovered: number }> {
    const tenSecondsAgo = new Date(this.now() - 10_000).toISOString();
    const nowIso = new Date(this.now()).toISOString();

    const pendingRes = await this.supabase
      .from('webhook_deliveries')
      .select('id, subscription_id, event_id, topic, op, row_id, payload, surrogate_keys, status, attempt_count, next_retry_at, created_at')
      .eq('status', 'pending')
      .lt('created_at', tenSecondsAgo)
      .limit(500);
    const pendingRows = (pendingRes.data ?? []) as unknown as WebhookDeliveryRow[];

    const failedRes = await this.supabase
      .from('webhook_deliveries')
      .select('id, subscription_id, event_id, topic, op, row_id, payload, surrogate_keys, status, attempt_count, next_retry_at, created_at')
      .eq('status', 'failed')
      .lt('next_retry_at', nowIso)
      .limit(500);
    const failedRows = (failedRes.data ?? []) as unknown as WebhookDeliveryRow[];

    const all = [...pendingRows, ...failedRows];
    if (all.length === 0) return { recovered: 0 };

    // Load subs for all unique subscription_ids
    const subIds = Array.from(new Set(all.map((d) => d.subscription_id)));
    const subsRes = await this.supabase
      .from('webhook_subscriptions')
      .select('id, host_kind, host_id, url, topics, secret, secret_previous, status, consecutive_failures')
      .in('id', subIds);
    const subs = (subsRes.data ?? []) as unknown as WebhookSubscriptionRow[];
    const subById = new Map(subs.map((s) => [s.id, s]));

    let recovered = 0;
    for (const row of all) {
      const sub = subById.get(row.subscription_id);
      if (!sub || sub.status !== 'enabled') continue;
      const jitter = randomBytes(2).readUInt16BE(0) % RECOVERY_JITTER_MS;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        void this.attemptDelivery(sub, row.id, row.payload, row.attempt_count);
      }, jitter);
      this.retryTimers.add(timer);
      recovered++;
    }
    this.logger.info('webhooks.recovery_sweep', {
      pending: pendingRows.length,
      failed: failedRows.length,
      recovered,
    });
    return { recovered };
  }

  private pruneEventIdCache(): void {
    const cutoff = this.now();
    for (const [k, expiry] of this.seenEventIds) {
      if (expiry < cutoff) this.seenEventIds.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Fill `{field}` placeholders in a detail key template from the row payload.
 * Returns null if any required field is missing or null/empty — the caller
 * skips the detail key (still emits the bulk key).
 */
export function fillTemplate(template: string, row: Record<string, string | null>): string | null {
  if (!template.includes('{')) return template;
  let out = template;
  // Simple regex; templates are static-known shape `prefix:{field}`.
  const matches = template.match(/\{([a-zA-Z0-9_]+)\}/g);
  if (!matches) return template;
  for (const match of matches) {
    const fieldName = match.slice(1, -1);
    const value = row?.[fieldName];
    if (value == null || value === '') return null;
    out = out.replace(match, value);
  }
  return out;
}

/**
 * Build a Cloudflare purger that hits the public purge_cache API. Returns
 * a no-op purger when CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID isn't set.
 *
 * v1 path per spec §4.6: calls the public Cloudflare API directly. The
 * Worker's __purge endpoint (§4.7.1) is wired in Phase 3.
 */
export function makeCloudflarePurger(env: {
  apiToken?: string | null;
  zoneId?: string | null;
  logger: HubLogger;
  fetchImpl?: typeof fetch;
}): CloudflarePurger {
  const token = env.apiToken;
  const zoneId = env.zoneId;
  const fetchImpl = env.fetchImpl ?? fetch;
  if (!token || !zoneId) {
    env.logger.info('webhooks.cloudflare_purger_disabled', {
      reason: !token ? 'CLOUDFLARE_API_TOKEN not set' : 'CLOUDFLARE_ZONE_ID not set',
    });
    return {
      async purgeTags(tags) {
        env.logger.info('webhooks.cloudflare_purge_noop', { tags: Array.from(tags) });
      },
    };
  }
  return {
    async purgeTags(tags) {
      if (!tags || tags.length === 0) return;
      // Cloudflare's purge_cache supports `tags` only on Enterprise. On
      // lower tiers this call is a no-op for tag-based invalidation; we
      // still send it so Enterprise upgrades work without code change.
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: Array.from(tags) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`cloudflare purge failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
    },
  };
}
