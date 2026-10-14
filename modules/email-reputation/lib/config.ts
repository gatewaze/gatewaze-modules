/**
 * Module settings from installed_modules.config, with safe defaults. Every
 * number is clamped so a typo in the settings cannot make the worker run for
 * an hour or alert on every send.
 */

import { DEFAULT_THRESHOLDS, type DetectorThresholds } from './detector';

export interface ReputationConfig {
  thresholds: DetectorThresholds;
  /** Sends started within this many days are recomputed on every run. */
  recentDays: number;
  /** How far back to measure history on first install. */
  backfillDays: number;
  /** Each worker run stops after this long. */
  budgetMs: number;
  /** MX lookups per run. */
  domainLookupsPerRun: number;
  /** Optional Slack incoming webhook. Empty when unset or not a Slack URL. */
  slackWebhookUrl: string;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Only Slack incoming webhooks, so the setting cannot point the server at another host. */
export function safeSlackWebhook(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.hostname !== 'hooks.slack.com' || u.port !== '' || u.username || u.password) return '';
    if (!u.pathname.startsWith('/services/')) return '';
    return u.toString();
  } catch {
    return '';
  }
}

export function parseConfig(raw: Record<string, unknown> | null | undefined): ReputationConfig {
  const r = raw ?? {};
  return {
    thresholds: {
      minDelivered: Math.round(num(r.min_delivered, DEFAULT_THRESHOLDS.minDelivered, 50, 1_000_000)),
      minBaselineRate: num(r.min_baseline_open_rate, DEFAULT_THRESHOLDS.minBaselineRate, 0.01, 0.9),
      maxRatio: num(r.max_open_rate_ratio, DEFAULT_THRESHOLDS.maxRatio, 0.05, 0.9),
    },
    recentDays: Math.round(num(r.recent_days, 7, 1, 30)),
    backfillDays: Math.round(num(r.backfill_days, 120, 7, 365)),
    budgetMs: Math.round(num(r.budget_ms, 60_000, 5_000, 240_000)),
    domainLookupsPerRun: Math.round(num(r.domain_lookups_per_run, 300, 0, 2_000)),
    slackWebhookUrl: safeSlackWebhook(r.slack_webhook_url),
  };
}
