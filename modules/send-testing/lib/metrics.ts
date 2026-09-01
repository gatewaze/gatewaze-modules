/**
 * Run metrics.
 *
 * Two questions get answered separately because they degrade differently:
 * completion ("did the batch get through") is always computable, while latency
 * needs send-side timestamps that only exist for platform sends. A run driven
 * from an external system (LFX, another ESP) has arrivals but no email_send_log
 * rows, so latency is reported as null rather than as a misleading zero.
 */

export interface ArrivalSample {
  recipient_email: string;
  received_at: string;
  headers_meta?: Record<string, unknown> | null;
}

export interface SendLogSample {
  recipient_email: string;
  sent_at: string | null;
  status: string | null;
}

export interface LatencySummary {
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** How many arrivals could be paired with a send-side timestamp. */
  matched: number;
}

export interface AuthSummary {
  spf_pass: number;
  dkim_pass: number;
  dmarc_pass: number;
  /** Arrivals carrying a parseable Authentication-Results header. */
  evaluated: number;
}

export interface SendLogSummary {
  queued: number;
  sent: number;
  failed: number;
  bounced: number;
}

export interface HistogramBucket {
  bucket_start: string;
  count: number;
}

export interface RunResults {
  arrival_count: number;
  expected_count: number;
  completion_percent: number;
  latency_ms: LatencySummary | null;
  auth: AuthSummary;
  send_log: SendLogSummary | null;
  arrivals_histogram: HistogramBucket[];
}

/**
 * Nearest-rank percentile. Interpolating would invent a latency no message
 * actually experienced, which is the wrong trade for a diagnostic figure.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[index];
}

export function summariseLatency(
  arrivals: ArrivalSample[],
  sendLog: SendLogSample[],
): LatencySummary | null {
  if (sendLog.length === 0) return null;

  const sentAt = new Map<string, number>();
  for (const row of sendLog) {
    if (!row.sent_at) continue;
    const email = row.recipient_email.toLowerCase();
    const ts = Date.parse(row.sent_at);
    if (!Number.isFinite(ts)) continue;
    // A recipient can legitimately appear more than once (a retry). The first
    // dispatch is the one the latency question is about.
    const existing = sentAt.get(email);
    if (existing === undefined || ts < existing) sentAt.set(email, ts);
  }

  const deltas: number[] = [];
  for (const arrival of arrivals) {
    const sent = sentAt.get(arrival.recipient_email.toLowerCase());
    if (sent === undefined) continue;
    const received = Date.parse(arrival.received_at);
    if (!Number.isFinite(received)) continue;
    const delta = received - sent;
    // Clock skew between the sending host and the receiver can produce small
    // negatives. Dropping them is better than reporting a negative latency.
    if (delta >= 0) deltas.push(delta);
  }

  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return {
    p50: percentile(deltas, 50),
    p90: percentile(deltas, 90),
    p99: percentile(deltas, 99),
    max: deltas[deltas.length - 1],
    matched: deltas.length,
  };
}

/**
 * Reads SPF/DKIM/DMARC verdicts the receiver lifted from Authentication-Results.
 * A cheap leading indicator of placement trouble even without a seed-list test:
 * if DKIM is failing here it will fail at Gmail too.
 */
export function summariseAuth(arrivals: ArrivalSample[]): AuthSummary {
  const summary: AuthSummary = { spf_pass: 0, dkim_pass: 0, dmarc_pass: 0, evaluated: 0 };
  for (const arrival of arrivals) {
    const auth = arrival.headers_meta?.auth as Record<string, unknown> | undefined;
    if (!auth || typeof auth !== 'object') continue;
    summary.evaluated += 1;
    if (auth.spf === 'pass') summary.spf_pass += 1;
    if (auth.dkim === 'pass') summary.dkim_pass += 1;
    if (auth.dmarc === 'pass') summary.dmarc_pass += 1;
  }
  return summary;
}

export function summariseSendLog(sendLog: SendLogSample[]): SendLogSummary | null {
  if (sendLog.length === 0) return null;
  const summary: SendLogSummary = { queued: 0, sent: 0, failed: 0, bounced: 0 };
  for (const row of sendLog) {
    switch (row.status) {
      case 'queued':
      case 'sending':
      case 'pending':
        summary.queued += 1;
        break;
      case 'sent':
      case 'accepted':
      case 'delivered':
        summary.sent += 1;
        break;
      case 'bounced':
        summary.bounced += 1;
        break;
      case 'send_failed':
      case 'permanently_failed':
      case 'dropped':
      case 'failed':
        summary.failed += 1;
        break;
      default:
        break;
    }
  }
  return summary;
}

/**
 * Arrivals bucketed over the run window. This is the chart that shows pacing:
 * a timezone-aware send produces distinct waves, and a stalled pipeline
 * produces a flat gap that no percentile would reveal.
 */
export function buildHistogram(
  arrivals: ArrivalSample[],
  startedAt: string,
  endedAt: string,
  targetBuckets = 60,
): HistogramBucket[] {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const span = end - start;
  const bucketMs = Math.max(Math.ceil(span / targetBuckets), 1000);
  const bucketCount = Math.max(Math.ceil(span / bucketMs), 1);

  const counts = new Array<number>(bucketCount).fill(0);
  for (const arrival of arrivals) {
    const ts = Date.parse(arrival.received_at);
    if (!Number.isFinite(ts)) continue;
    const index = Math.floor((ts - start) / bucketMs);
    if (index < 0 || index >= bucketCount) continue;
    counts[index] += 1;
  }

  return counts.map((count, i) => ({
    bucket_start: new Date(start + i * bucketMs).toISOString(),
    count,
  }));
}

export function computeRunResults(params: {
  arrivals: ArrivalSample[];
  sendLog: SendLogSample[];
  expectedCount: number;
  startedAt: string;
  endedAt: string;
}): RunResults {
  const { arrivals, sendLog, expectedCount, startedAt, endedAt } = params;
  // Distinct recipients, not raw rows: a duplicate delivery to one address is
  // not extra completion.
  const distinct = new Set(arrivals.map((a) => a.recipient_email.toLowerCase()));
  const arrivalCount = distinct.size;

  return {
    arrival_count: arrivalCount,
    expected_count: expectedCount,
    completion_percent:
      expectedCount > 0
        ? Math.round((arrivalCount / expectedCount) * 10000) / 100
        : 0,
    latency_ms: summariseLatency(arrivals, sendLog),
    auth: summariseAuth(arrivals),
    send_log: summariseSendLog(sendLog),
    arrivals_histogram: buildHistogram(arrivals, startedAt, endedAt),
  };
}
