// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { isHumanMember, peopleSyncMode, tallyLinkResults, toMemberRecord } from '../lib/members.js';

describe('peopleSyncMode', () => {
  it.each(['off', 'link', 'create', ' CREATE '])('accepts %j', (v) => expect(peopleSyncMode(v)).toBe(v.trim().toLowerCase()));
  it.each([undefined, '', 'yes', true, 1])('defaults %j to link', (v) => expect(peopleSyncMode(v)).toBe('link'));
});

describe('isHumanMember', () => {
  it('accepts a normal member and an enterprise (W) id', () => {
    expect(isHumanMember({ id: 'U0123ABCD' })).toBe(true);
    expect(isHumanMember({ id: 'W0123ABCD' })).toBe(true);
  });
  it.each([
    [{ id: 'USLACKBOT' }],
    [{ id: 'U1BOT', is_bot: true }],
    [{ id: 'U1APP', is_app_user: true }],
    [{ id: 'U1GONE', deleted: true }],
    [{ id: 'not-an-id' }],
    [{ id: 'B0123ABCD' }],
    [null],
  ])('rejects %j', (u) => expect(isHumanMember(u)).toBe(false));
});

describe('toMemberRecord', () => {
  it('takes first and last name from the profile', () => {
    const r = toMemberRecord({
      id: 'U1ABC', name: 'ada',
      profile: { email: ' Ada@Example.COM ', first_name: 'Ada', last_name: 'Lovelace', display_name: 'ada.l' },
    });
    expect(r).toEqual({ slack_user_id: 'U1ABC', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', username: 'ada.l' });
  });

  it('splits the real name when the profile has no first/last', () => {
    const r = toMemberRecord({ id: 'U1ABC', profile: { email: 'g@x.io', real_name: '  Grace   Brewster Hopper ' } });
    expect(r.first_name).toBe('Grace');
    expect(r.last_name).toBe('Brewster Hopper');
  });

  it('falls back to the account name as the username', () => {
    expect(toMemberRecord({ id: 'U1ABC', name: 'grace', profile: {} }).username).toBe('grace');
  });

  it('drops an email that is not one, or is too long', () => {
    expect(toMemberRecord({ id: 'U1ABC', profile: { email: 'nope' } }).email).toBe(null);
    expect(toMemberRecord({ id: 'U1ABC', profile: { email: `${'a'.repeat(250)}@x.io` } }).email).toBe(null);
  });

  it('caps names', () => {
    expect(toMemberRecord({ id: 'U1ABC', profile: { first_name: 'x'.repeat(500) } }).first_name).toHaveLength(200);
  });

  it('returns null for bots and deactivated accounts', () => {
    expect(toMemberRecord({ id: 'U1BOT', is_bot: true, profile: { email: 'b@x.io' } })).toBe(null);
    expect(toMemberRecord({ id: 'U1GONE', deleted: true, profile: { email: 'g@x.io' } })).toBe(null);
  });
});

describe('tallyLinkResults', () => {
  it('counts per result and accumulates across pages', () => {
    const t = tallyLinkResults([{ r_action: 'created' }, { r_action: 'updated' }, { r_action: 'created' }]);
    tallyLinkResults([{ r_action: 'no_email' }, {}], t);
    expect(t).toEqual({ created: 2, updated: 1, no_email: 1, unknown: 1 });
  });
});
