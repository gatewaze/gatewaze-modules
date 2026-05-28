/**
 * Unit tests for the robots.txt parser (spec §8).
 */

import { describe, it, expect } from 'vitest';
import { matchRobotsRule } from '../lib/robots.js';

const STANDARD = `
User-agent: *
Disallow: /admin/
Allow: /public/

User-agent: GatewazeFetchBot
Disallow: /

User-agent: Googlebot
Allow: /admin/page1
Disallow: /admin/
`;

describe('matchRobotsRule', () => {
  it('disallows admin for default UA', () => {
    const r = matchRobotsRule(STANDARD, 'OtherBot/1.0', '/admin/foo');
    expect(r.allow).toBe(false);
  });

  it('allows public for default UA', () => {
    const r = matchRobotsRule(STANDARD, 'OtherBot/1.0', '/public/x');
    expect(r.allow).toBe(true);
  });

  it('uses GatewazeFetchBot group when UA contains it', () => {
    const r = matchRobotsRule(STANDARD, 'GatewazeFetchBot/1.0 (+url)', '/anywhere');
    expect(r.allow).toBe(false);
  });

  it('Allow with longer match wins over Disallow (Googlebot)', () => {
    const r = matchRobotsRule(STANDARD, 'Googlebot/2.1', '/admin/page1');
    expect(r.allow).toBe(true);
  });

  it('Disallow with longer match wins (Googlebot generic admin)', () => {
    const r = matchRobotsRule(STANDARD, 'Googlebot/2.1', '/admin/other');
    expect(r.allow).toBe(false);
  });

  it('empty body = all allowed', () => {
    const r = matchRobotsRule('', 'Anything', '/path');
    expect(r.allow).toBe(true);
  });
});
