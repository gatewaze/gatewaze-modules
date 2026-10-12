/**
 * Tests for the guarded fetch the save pipeline uses for cover images and
 * GatewazePortalEventsScraper uses for its API calls.
 *
 * The local server stands in for something on the pod network: every route to
 * it (IP literal, a name that resolves to it, a redirect to it) must be refused
 * before any byte of its response is read.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { FetchRefused, fetchImage, guardedFetch, isPrivateAddress } from '../guarded-fetch.js';

describe('isPrivateAddress', () => {
  for (const ip of [
    '10.1.2.3', '127.0.0.1', '0.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
    '[::1]', 'not-an-ip',
  ]) {
    test(`refuses ${ip}`, () => assert.equal(isPrivateAddress(ip), true));
  }
  for (const ip of ['8.8.8.8', '104.18.1.1', '172.32.0.1', '2606:4700::1111']) {
    test(`allows ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
  }
});

describe('guardedFetch', () => {
  let server;
  let port;
  let hits = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('secret');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  test('refuses an IP-literal private host before connecting', async () => {
    await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/`), FetchRefused);
    assert.equal(hits, 0);
  });

  test('refuses a name that resolves to a private address', async () => {
    await assert.rejects(guardedFetch(`http://localhost:${port}/`), /private/);
    assert.equal(hits, 0);
  });

  test('refuses metadata through an IPv4-mapped IPv6 literal', async () => {
    await assert.rejects(guardedFetch('http://[::ffff:169.254.169.254]/latest/meta-data'), FetchRefused);
  });

  test('refuses other schemes and credentials', async () => {
    await assert.rejects(guardedFetch('file:///etc/passwd'), /scheme/);
    await assert.rejects(guardedFetch('https://user:pw@example.com/'), /credentials/);
    await assert.rejects(guardedFetch('http://example.com/', { allowHttp: false }), /scheme/);
  });

  test('fetchImage surfaces the refusal rather than returning bytes', async () => {
    await assert.rejects(fetchImage(`http://127.0.0.1:${port}/a.png`), FetchRefused);
    assert.equal(hits, 0);
  });
});
