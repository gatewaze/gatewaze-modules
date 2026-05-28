/**
 * Tests for the Node adapter to scrapling-fetcher.
 *
 * Uses Node's built-in `node:test` runner (no extra dep). Mocks the global
 * fetch so no real HTTP is made.
 */

import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchPage,
  probe,
  releaseJob,
  getJobBandwidth,
  ScraplingNotConfiguredError,
  ScraplingTransportError,
  ScraplingBudgetExceeded,
} from '../scrapling-fetcher.js';


let _origFetch;
let _calls;

function mockFetch(handler) {
  _calls = [];
  globalThis.fetch = async (url, init) => {
    _calls.push({ url, init });
    return handler(url, init);
  };
}

function makeResponse(status, body) {
  return {
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  _origFetch = globalThis.fetch;
  process.env.SCRAPLING_FETCHER_URL = 'http://test-service:8080';
  process.env.SCRAPLING_INTERNAL_TOKEN = 'unit-test-token';
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  releaseJob('test-job-1');
  releaseJob('test-job-2');
  releaseJob(42);
});


describe('fetchPage', () => {
  test('throws ScraplingNotConfiguredError when SCRAPLING_FETCHER_URL is unset', async () => {
    delete process.env.SCRAPLING_FETCHER_URL;
    await assert.rejects(
      fetchPage('https://example.com'),
      (err) => err instanceof ScraplingNotConfiguredError,
    );
  });

  test('returns parsed body on 2xx', async () => {
    mockFetch((_url, _init) =>
      makeResponse(200, {
        status: 200,
        html: '<html>ok</html>',
        next_data: { foo: 'bar' },
        headers: { 'content-type': 'text/html' },
        timing: { fetch_ms: 123, total_ms: 130 },
        mode_used: 'fast',
      }),
    );
    const result = await fetchPage('https://example.com', { jobId: 'test-job-1' });
    assert.equal(result.html, '<html>ok</html>');
    assert.deepEqual(result.nextData, { foo: 'bar' });
    assert.equal(result.status, 200);
    assert.equal(result.mode, 'fast');
  });

  test('sends X-Internal-Token + JSON content-type', async () => {
    mockFetch(() => makeResponse(200, { status: 200, html: '', next_data: null, headers: {}, timing: {}, mode_used: 'fast' }));
    await fetchPage('https://example.com');
    const init = _calls[0].init;
    assert.equal(init.headers['X-Internal-Token'], 'unit-test-token');
    assert.equal(init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.equal(body.url, 'https://example.com');
    assert.equal(body.mode, 'fast');
  });

  test('throws ScraplingTransportError on non-transient 4xx with no retry', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return makeResponse(400, 'bad request');
    });
    await assert.rejects(
      fetchPage('https://example.com', { jobId: 'test-job-1' }),
      (err) => err instanceof ScraplingTransportError && err.statusCode === 400,
    );
    assert.equal(calls, 1, 'no retry on 400');
  });

  test('retries once on transient 503 with backoff, then fails', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return makeResponse(503, 'busy');
    });
    await assert.rejects(
      fetchPage('https://example.com', { jobId: 'test-job-1', timeoutMs: 500 }),
      (err) => err instanceof ScraplingTransportError,
    );
    assert.equal(calls, 2, 'one retry should fire');
  });

  test('retry succeeds when transient resolves', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      if (calls === 1) return makeResponse(502, 'gateway');
      return makeResponse(200, {
        status: 200,
        html: '<ok/>',
        next_data: null,
        headers: {},
        timing: { fetch_ms: 1, total_ms: 1 },
        mode_used: 'fast',
      });
    });
    const result = await fetchPage('https://example.com', { jobId: 'test-job-1' });
    assert.equal(result.html, '<ok/>');
    assert.equal(calls, 2);
  });

  test('per-job retry budget caps at 5', async () => {
    mockFetch(() => makeResponse(502, 'down'));
    for (let i = 0; i < 5; i++) {
      await fetchPage(`https://x.test/${i}`, { jobId: 'test-job-2', timeoutMs: 500 }).catch(() => {});
    }
    // 6th call should NOT retry — it'll just fail on first attempt.
    let calls = 0;
    mockFetch(() => {
      calls++;
      return makeResponse(502, 'down');
    });
    await fetchPage('https://x.test/last', { jobId: 'test-job-2', timeoutMs: 500 }).catch(() => {});
    assert.equal(calls, 1, 'no retry after budget exhausted');
  });

  test('accumulates per-job bandwidth', async () => {
    mockFetch(() =>
      makeResponse(200, {
        status: 200,
        html: 'x'.repeat(1024),
        next_data: null,
        headers: {},
        timing: { fetch_ms: 1, total_ms: 1 },
        mode_used: 'fast',
      }),
    );
    await fetchPage('https://example.com', { jobId: 'test-job-1' });
    await fetchPage('https://example.com', { jobId: 'test-job-1' });
    assert.equal(getJobBandwidth('test-job-1'), 2048);
  });

  test('throws ScraplingBudgetExceeded when bandwidth ceiling hit', async () => {
    mockFetch(() =>
      makeResponse(200, {
        status: 200,
        html: 'x'.repeat(2 * 1024 * 1024), // 2 MB per call
        next_data: null,
        headers: {},
        timing: { fetch_ms: 1, total_ms: 1 },
        mode_used: 'fast',
      }),
    );
    // First call: 2 MB, accumulator 2 MB. Below 4 MB ceiling, OK.
    await fetchPage('https://example.com', {
      jobId: 'test-job-1',
      bandwidthCeilingMb: 4,
    });
    // Second call: would push to 4 MB. The check is >= so accumulator
    // already at 2 MB on entry; second response brings to 4 MB.
    await fetchPage('https://example.com', {
      jobId: 'test-job-1',
      bandwidthCeilingMb: 4,
    });
    // Third call: pre-check now sees 4 MB >= 4 MB, throws.
    await assert.rejects(
      fetchPage('https://example.com', {
        jobId: 'test-job-1',
        bandwidthCeilingMb: 4,
      }),
      (err) => err instanceof ScraplingBudgetExceeded,
    );
  });

  test('releaseJob clears accumulator', async () => {
    mockFetch(() =>
      makeResponse(200, {
        status: 200,
        html: 'abcd',
        next_data: null,
        headers: {},
        timing: { fetch_ms: 1, total_ms: 1 },
        mode_used: 'fast',
      }),
    );
    await fetchPage('https://example.com', { jobId: 42 });
    assert.equal(getJobBandwidth(42), 4);
    releaseJob(42);
    assert.equal(getJobBandwidth(42), 0);
  });
});


describe('probe', () => {
  test('returns configured=false when URL unset', async () => {
    delete process.env.SCRAPLING_FETCHER_URL;
    const r = await probe();
    assert.deepEqual(r, { configured: false, healthy: false });
  });

  test('returns healthy=true on healthz 200', async () => {
    mockFetch(() => makeResponse(200, { status: 'ok' }));
    const r = await probe();
    assert.deepEqual(r, { configured: true, healthy: true });
  });

  test('returns healthy=false on healthz error', async () => {
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };
    const r = await probe();
    assert.deepEqual(r, { configured: true, healthy: false });
  });
});
