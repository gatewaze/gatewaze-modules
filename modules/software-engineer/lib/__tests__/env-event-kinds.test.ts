/**
 * The shared event-kind taxonomy (lib/env-event-kinds.ts). It is the single
 * source of truth for "what is this event / is it an error", used by BOTH the
 * API summary aggregation and the admin log explorer, so the thing worth
 * pinning is that it still covers exactly what the host agents emit.
 */
import { describe, it, expect } from 'vitest';
import {
  EVENT_KINDS, KIND_GROUPS, KIND_RE, REFUSAL_KINDS,
  kindSpec, kindCategory, kindSeverity, kindLabel, isErrorKind,
} from '../env-event-kinds.js';

// Exactly what scripts/staging-multienv.sh + lib-lfx-env.sh (env_event),
// staging-provisioner.py and staging-prview-tailer.sh write today.
const EMITTED = [
  'provision', 'create', 'ready', 'fail', 'reap', 'reap_refused', 'teardown',
  'teardown_refused', 'admission_refused', 'root_promote', 'root_demote',
  'root_demote_fallback', 'root_reassert', 'root_boot_restore',
  'visit', 'login_success', 'login_failure', 'service_error',
];

describe('taxonomy coverage', () => {
  it('knows every kind the host agents emit', () => {
    for (const k of EMITTED) expect(EVENT_KINDS[k], `missing kind: ${k}`).toBeDefined();
  });
  it('declares no kind the ingester would reject', () => {
    for (const k of Object.keys(EVENT_KINDS)) expect(k).toMatch(KIND_RE);
  });
  it('degrades an unknown kind instead of dropping it', () => {
    expect(kindSpec('some_future_kind')).toEqual({ category: 'lifecycle', severity: 'info', label: 'event' });
    expect(kindCategory('some_future_kind')).toBe('lifecycle');
    expect(kindSeverity('some_future_kind')).toBe('info');
    // The label falls back to the machine name made readable, not "event".
    expect(kindLabel('some_future_kind')).toBe('some future kind');
  });
});

describe('severity', () => {
  it('failures are errors', () => {
    for (const k of ['fail', 'service_error', 'login_failure', 'root_demote_fallback']) {
      expect(isErrorKind(k), k).toBe(true);
    }
  });
  it('refusals and reaps are warnings, not errors', () => {
    for (const k of ['admission_refused', 'teardown_refused', 'reap_refused', 'reap']) {
      expect(kindSeverity(k), k).toBe('warn');
      expect(isErrorKind(k), k).toBe(false);
    }
  });
  it('successes are ok and visits are muted', () => {
    expect(kindSeverity('ready')).toBe('ok');
    expect(kindSeverity('login_success')).toBe('ok');
    expect(kindSeverity('root_boot_restore')).toBe('ok');
    expect(kindSeverity('visit')).toBe('muted');
  });
});

describe('filter groups', () => {
  it('errors = every red kind plus the refusals, and nothing else', () => {
    const expected = new Set([
      ...Object.keys(EVENT_KINDS).filter((k) => kindSeverity(k) === 'error'),
      ...REFUSAL_KINDS,
    ]);
    expect(new Set(KIND_GROUPS.errors)).toEqual(expected);
    // A plain TTL reap is normal housekeeping — it must NOT be in the errors view.
    expect(KIND_GROUPS.errors).not.toContain('reap');
  });
  it('lifecycle covers the root-domain guarantee events', () => {
    for (const k of ['teardown_refused', 'reap_refused', 'root_promote', 'root_demote',
      'root_reassert', 'root_boot_restore', 'root_demote_fallback']) {
      expect(KIND_GROUPS.lifecycle, k).toContain(k);
    }
  });
  it('access is exactly the tailer-sourced traffic + auth kinds', () => {
    expect(new Set(KIND_GROUPS.access)).toEqual(new Set(['visit', 'login_success', 'login_failure']));
  });
  it('lifecycle and access do not overlap', () => {
    const a = new Set(KIND_GROUPS.access);
    for (const k of KIND_GROUPS.lifecycle) expect(a.has(k), k).toBe(false);
  });
  it('every group value is a shaped kind', () => {
    for (const group of Object.values(KIND_GROUPS)) {
      for (const k of group) expect(k).toMatch(KIND_RE);
    }
  });
});
