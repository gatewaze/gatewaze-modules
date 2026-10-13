/**
 * Egress-credential helpers for the Slack invitation worker.
 *
 * Dependency-free (node built-ins only) and kept out of the worker
 * script so the tests can import them without pulling in puppeteer.
 */

import { unsealSecret } from './secret-envelope.js';
import { request as httpRequest } from 'http';

// Sealed-secret reading lives in ./secret-envelope.js, shared with the token store.
export { unsealSecret };

/**
 * Confirm the egress proxy will actually carry traffic before draining the
 * queue. A dead proxy (expired credentials, exhausted traffic plan) makes every
 * invite fail at page load, and each failure burns a queue row — 35 were lost
 * that way on 2026-10-11 before anyone noticed. One CONNECT up front turns that
 * into a single log line with the queue left intact. The check must open a
 * real CONNECT tunnel: a plain request to the proxy's own address answers 400
 * from the proxy itself, which looks like success while proving nothing.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export function checkProxy(proxyUrl, target = 'api.ipify.org:443', requestImpl = httpRequest) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let u;
    try {
      u = new URL(proxyUrl);
    } catch {
      return done({ ok: false, detail: 'proxy URL is not parseable' });
    }
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');

    const req = requestImpl({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: 'CONNECT',
      path: target,
      headers: { 'Proxy-Authorization': `Basic ${auth}`, Host: target },
      timeout: 20000,
    });

    // Tunnel granted: the proxy will carry traffic.
    req.on('connect', (res, socket) => {
      socket.destroy();
      done(res.statusCode === 200
        ? { ok: true, detail: `tunnel established (${res.statusCode})` }
        : { ok: false, detail: `proxy refused the tunnel: ${res.statusCode} ${res.statusMessage || ''}`.trim() });
    });

    // A refusal (407 TRAFFIC_EXHAUSTED, bad credentials) arrives as an ordinary
    // response rather than a tunnel, and carries the provider's reason.
    req.on('response', (res) => {
      res.destroy();
      done({ ok: false, detail: `proxy refused the tunnel: ${res.statusCode} ${res.statusMessage || ''}`.trim() });
    });

    req.on('timeout', () => { req.destroy(); done({ ok: false, detail: 'proxy timed out' }); });
    req.on('error', (err) => done({ ok: false, detail: `proxy unreachable: ${err.message}` }));
    req.end();
  });
}
