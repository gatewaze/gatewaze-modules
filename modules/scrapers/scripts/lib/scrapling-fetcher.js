/**
 * Node adapter for the Python `scrapling-fetcher` service.
 *
 * See gatewaze-environments/specs/spec-scrapling-fetcher-service.md §4.2.
 *
 * - `fetchPage(url, opts)` posts to `${SCRAPLING_FETCHER_URL}/fetch` with
 *   the internal token and returns the parsed response.
 * - When `SCRAPLING_FETCHER_URL` is unset the adapter throws a typed
 *   `ScraplingNotConfiguredError` so the *Fast scraper variants can
 *   degrade to their parent's Puppeteer path without misleading WARN logs.
 * - One retry with 200 ms backoff for transient 5xx (502/503/504) and
 *   network errors. Per-job retry budget capped at 5 (consumed via
 *   `acquireRetry` / released by callers).
 * - Per-job byte-accumulator tracks bandwidth for the kill switch.
 *
 * Module-scope state:
 *   - `_jobRetries: Map<jobId, count>`        — retry budget per job
 *   - `_jobBandwidth: Map<jobId, { bytes, lastTouched }>` — bandwidth ledger
 * Both are cleaned by `releaseJob(jobId)` from the worker job teardown
 * AND by an hourly TTL sweep that drops entries idle > 1 hour.
 */

export class ScraplingNotConfiguredError extends Error {
  constructor() {
    super('SCRAPLING_FETCHER_URL is not set; scrapling-fetcher service unavailable');
    this.name = 'ScraplingNotConfiguredError';
  }
}

export class ScraplingTransportError extends Error {
  constructor(message, statusCode = null) {
    super(message);
    this.name = 'ScraplingTransportError';
    this.statusCode = statusCode;
  }
}

export class ScraplingBudgetExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScraplingBudgetExceeded';
  }
}

const RETRY_BUDGET_PER_JOB = 5;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TTL_MS = 60 * 60 * 1000; // 1 hour

const _jobRetries = new Map();
const _jobBandwidth = new Map();

let _ttlSweepStarted = false;
function _startTtlSweep() {
  if (_ttlSweepStarted) return;
  _ttlSweepStarted = true;
  // Unref'd interval so it doesn't block process exit.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - TTL_MS;
    for (const [jobId, entry] of _jobBandwidth.entries()) {
      if (entry.lastTouched < cutoff) {
        _jobBandwidth.delete(jobId);
        _jobRetries.delete(jobId);
      }
    }
  }, 5 * 60 * 1000);
  if (typeof sweep.unref === 'function') sweep.unref();
}
_startTtlSweep();

function _acquireRetry(jobId) {
  if (jobId == null) return true;
  const count = _jobRetries.get(jobId) ?? 0;
  if (count >= RETRY_BUDGET_PER_JOB) return false;
  _jobRetries.set(jobId, count + 1);
  return true;
}

function _accountBandwidth(jobId, bytes) {
  if (jobId == null) return null;
  const entry = _jobBandwidth.get(jobId) ?? { bytes: 0, lastTouched: Date.now() };
  entry.bytes += bytes;
  entry.lastTouched = Date.now();
  _jobBandwidth.set(jobId, entry);
  return entry.bytes;
}

export function getJobBandwidth(jobId) {
  return _jobBandwidth.get(jobId)?.bytes ?? 0;
}

export function releaseJob(jobId) {
  if (jobId == null) return;
  _jobRetries.delete(jobId);
  _jobBandwidth.delete(jobId);
}

function _serviceUrl() {
  const url = process.env.SCRAPLING_FETCHER_URL;
  if (!url || url.trim() === '') return null;
  return url.replace(/\/$/, '');
}

function _internalToken() {
  return process.env.SCRAPLING_INTERNAL_TOKEN || '';
}

async function _post(body, { timeoutMs }) {
  const base = _serviceUrl();
  if (!base) throw new ScraplingNotConfiguredError();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': _internalToken(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch a URL through the scrapling-fetcher service.
 *
 * @param {string} url
 * @param {object} opts
 * @param {'fast'|'stealth'|'browser'} [opts.mode='fast']
 * @param {boolean} [opts.extractNextData=true]
 * @param {string|null} [opts.waitFor=null] — only honored when mode='browser'
 * @param {number} [opts.timeoutMs=30000]
 * @param {'auto'|'force'|'never'} [opts.proxy='auto']
 * @param {string|number|null} [opts.jobId=null] — for retry-budget + bandwidth accounting
 * @param {number|null} [opts.bandwidthCeilingMb=500] — abort if job total exceeds
 * @returns {Promise<{html: string, nextData: object|null, status: number, headers: object, timing: object, mode: string}>}
 */
export async function fetchPage(url, opts = {}) {
  const {
    mode = 'fast',
    extractNextData = true,
    waitFor = null,
    timeoutMs = 30000,
    proxy = 'auto',
    jobId = null,
    bandwidthCeilingMb = 500,
  } = opts;

  if (!_serviceUrl()) throw new ScraplingNotConfiguredError();

  if (jobId != null && bandwidthCeilingMb != null) {
    const used = getJobBandwidth(jobId);
    if (used >= bandwidthCeilingMb * 1024 * 1024) {
      throw new ScraplingBudgetExceeded(
        `bandwidth_ceiling_exceeded for job ${jobId}: ${(used / 1024 / 1024).toFixed(1)} MB ` +
        `>= ${bandwidthCeilingMb} MB`,
      );
    }
  }

  const payload = {
    url,
    mode,
    extract_next_data: extractNextData,
    wait_for: waitFor,
    timeout_ms: timeoutMs,
    proxy,
  };

  let lastError = null;
  // Initial attempt + at most one retry (gated by per-job budget).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await _post(payload, { timeoutMs: timeoutMs + 5000 });
      if (res.status >= 200 && res.status < 300) {
        const data = await res.json();
        if (jobId != null) _accountBandwidth(jobId, data.html?.length ?? 0);
        return {
          html: data.html,
          nextData: data.next_data,
          status: data.status,
          headers: data.headers,
          timing: data.timing,
          mode: data.mode_used,
        };
      }

      // Non-2xx from the service. Retry only on transient.
      if (TRANSIENT_STATUSES.has(res.status) && attempt === 0 && _acquireRetry(jobId)) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new ScraplingTransportError(
        `service ${res.status}: ${body.slice(0, 200)}`,
        res.status,
      );
    } catch (err) {
      lastError = err;
      if (err instanceof ScraplingTransportError) throw err;
      if (err instanceof ScraplingNotConfiguredError) throw err;
      // Network-level error (AbortError, fetch failed, etc). Retry once.
      if (attempt === 0 && _acquireRetry(jobId)) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error('scrapling-fetcher: unreachable');
}

/**
 * Probe whether the service is configured + responding. Used by the worker
 * at boot to log a clear startup status.
 */
export async function probe() {
  const base = _serviceUrl();
  if (!base) return { configured: false, healthy: false };
  try {
    const res = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return { configured: true, healthy: res.status === 200 };
  } catch {
    return { configured: true, healthy: false };
  }
}
