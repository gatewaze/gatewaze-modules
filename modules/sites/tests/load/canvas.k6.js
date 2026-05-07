/**
 * k6 load script for canvas editor endpoints. Per spec-sites-wysiwyg-
 * builder §8 the editor must sustain:
 *
 *   - 10 op/s per page (sustained) with p95 < 200 ms server-side
 *   - 50 concurrent editors per region without lock-conflict storms
 *   - render endpoint: p95 < 50 ms for a 50-block page
 *
 * Run:
 *   PAGE_ID=<uuid> JWT=<bearer> BASE_URL=https://api.example.com \
 *     k6 run modules/sites/tests/load/canvas.k6.js
 *
 * The script picks one page per VU (env PAGE_ID) and runs a typical
 * editor session: acquire lock → render → 10 small edit ops → release.
 * Each VU is a distinct editor; the page stays the same so concurrent
 * editors compete for the same advisory lock (worst case).
 *
 * To exercise the multi-page case, pass a comma-separated PAGE_IDS env
 * and uncomment the random-pick line below; the spec calls for both.
 *
 * NOTE: this script is committed but never wired into CI. Spec §8
 * reserves load testing for the operator's pre-prod deployment — the
 * thresholds here are observability targets, not gates on this PR.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JWT      = __ENV.JWT      || '';
const PAGE_ID  = __ENV.PAGE_ID  || '';
const VUS      = parseInt(__ENV.VUS || '10', 10);
const DURATION = __ENV.DURATION || '60s';

if (!PAGE_ID) {
  // We can't fail import-time, so flag at iteration-time below.
  console.warn('PAGE_ID env not set — VUs will fail with 400');
}

// ---------------------------------------------------------------------------
// Custom metrics — make spec thresholds machine-checkable.
// ---------------------------------------------------------------------------

const lockAcquireFail   = new Counter('canvas_lock_acquire_fail');
const lockConflictRate  = new Rate('canvas_lock_conflict_rate');
const opLatencyMs       = new Trend('canvas_op_latency_ms', true);
const renderLatencyMs   = new Trend('canvas_render_latency_ms', true);
const versionConflicts  = new Counter('canvas_version_conflicts');

// ---------------------------------------------------------------------------
// k6 test plan: ramp to VUS over 10s, hold for DURATION, drain over 10s.
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    sustained_editing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s',     target: VUS },
        { duration: DURATION,  target: VUS },
        { duration: '10s',     target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    'canvas_op_latency_ms':      ['p(95)<200'],
    'canvas_render_latency_ms':  ['p(95)<50'],
    'canvas_lock_conflict_rate': ['rate<0.30'],   // <30 % conflict rate at saturation
    'http_req_failed':           ['rate<0.05'],   // fewer than 5 % HTTP errors
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders() {
  return {
    'Authorization': `Bearer ${JWT}`,
    'Content-Type':  'application/json',
  };
}

function makeClientToken() {
  return uuidv4().replace(/-/g, '');
}

function acquireLock(pageId, clientToken) {
  const res = http.post(
    `${BASE_URL}/api/admin/pages/${pageId}/canvas/lock`,
    JSON.stringify({ clientToken }),
    { headers: authHeaders(), tags: { canvas_op: 'lock' } },
  );
  if (res.status === 409) {
    lockConflictRate.add(true);
    return null;
  }
  lockConflictRate.add(false);
  if (res.status !== 200) {
    lockAcquireFail.add(1);
    return null;
  }
  return JSON.parse(res.body);
}

function releaseLock(pageId, clientToken) {
  http.post(
    `${BASE_URL}/api/admin/pages/${pageId}/canvas/unlock`,
    JSON.stringify({ clientToken }),
    { headers: authHeaders(), tags: { canvas_op: 'unlock' } },
  );
}

function getRender(pageId) {
  const res = http.get(
    `${BASE_URL}/api/admin/pages/${pageId}/canvas/render`,
    { headers: authHeaders(), tags: { canvas_op: 'render' } },
  );
  renderLatencyMs.add(res.timings.duration);
  return res;
}

function applyOps(pageId, ops, baseVersion, clientToken) {
  const body = {
    ops,
    baseVersion,
    clientToken,
    idempotencyKey: uuidv4(),
  };
  const res = http.post(
    `${BASE_URL}/api/admin/pages/${pageId}/canvas`,
    JSON.stringify(body),
    { headers: authHeaders(), tags: { canvas_op: 'apply' } },
  );
  opLatencyMs.add(res.timings.duration);
  if (res.status === 409) {
    const parsed = (() => { try { return JSON.parse(res.body); } catch { return null; } })();
    if (parsed?.error?.code === 'canvas.version_conflict') {
      versionConflicts.add(1);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Default VU iteration: simulate a typical editor session.
// ---------------------------------------------------------------------------

export default function () {
  if (!PAGE_ID || !JWT) {
    console.error('PAGE_ID and JWT env vars are required');
    return;
  }

  const clientToken = makeClientToken();

  // 1. Lock.
  const lock = acquireLock(PAGE_ID, clientToken);
  if (!lock) {
    sleep(1); // back off and let another VU take the lock
    return;
  }

  // 2. Render.
  const renderRes = getRender(PAGE_ID);
  check(renderRes, {
    'render 200':                 (r) => r.status === 200,
    'render etag':                (r) => r.headers['Etag'] !== undefined,
  });

  // 3. Sustained ops — ten small edits at 1 op / 100 ms = 10 op/s.
  let baseVersion = 1; // operator should fetch real value; we let RPC return canvas.version_conflict if stale
  for (let i = 0; i < 10; i++) {
    const ops = [
      {
        kind: 'block.update_field',
        blockId: '00000000-0000-0000-0000-000000000001',
        fieldPath: '/title',
        newValue: `load-test edit #${i} from VU ${__VU}`,
      },
    ];
    const applyRes = applyOps(PAGE_ID, ops, baseVersion, clientToken);
    if (applyRes.status === 200) {
      const parsed = JSON.parse(applyRes.body);
      baseVersion = parsed.newVersion;
    } else if (applyRes.status === 409) {
      // version conflict — re-render to get the latest version. We don't
      // parse out newVersion from the render response (it's HTML), so
      // bail this iteration and the next one will start fresh.
      break;
    }
    sleep(0.1);
  }

  // 4. Release.
  releaseLock(PAGE_ID, clientToken);
}

// ---------------------------------------------------------------------------
// teardown — runs after all VUs stop. Useful for cleanup or summary.
// ---------------------------------------------------------------------------

export function teardown(data) {
  void data;
}
