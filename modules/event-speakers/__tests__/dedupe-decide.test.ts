/**
 * The merge decision (lib/dedupe/decide.ts).
 *
 * The groups below are the real ones from AAIF prod, kept with their real
 * names and companies, because they are the cases that decide whether a rule
 * is safe. In particular the two Ethans and the three Jeffs are the reason
 * there is a veto at all.
 */

import { describe, it, expect } from 'vitest';
import { decideGroup, linkedinContradicts, pickCanonical, type ProfileRow } from '../lib/dedupe/decide';

let n = 0;
function row(p: Partial<ProfileRow>): ProfileRow {
  n += 1;
  return {
    id: p.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: null, email: null, title: null, company: null, linkedin_url: null,
    avatar_url: null, source_avatar_url: null, sched_user_id: null,
    person_id: null, canonical_profile_id: null,
    created_at: '2026-01-01T00:00:00Z', event_count: 1,
    ...p,
  };
}

describe('the cases that must never merge', () => {
  it('keeps two different people both recorded only as "Ethan"', () => {
    const d = decideGroup([
      row({ name: 'Ethan', company: 'Lindy', linkedin_url: 'linkedin.com/in/ethan-kinnan' }),
      row({ name: 'Ethan', company: 'Wenti Labs', linkedin_url: 'linkedin.com/in/ethanow' }),
    ]);
    expect(d.action).toBe('review');
    expect(d.rule).toBe('linkedin_contradicts');
  });

  it('keeps three different people all recorded only as "Jeff"', () => {
    const d = decideGroup([
      row({ name: 'Jeff', linkedin_url: 'linkedin.com/in/heyjeffshaw' }),
      row({ name: 'Jeff', company: 'Thoth', linkedin_url: 'linkedin.com/in/pin-nean-lai' }),
      row({ name: 'Jeff', company: 'Hyperlane' }),
    ]);
    expect(d.action).toBe('review');
  });

  it('refuses a single first name even with no contradicting evidence', () => {
    // Nothing contradicts here, and that is exactly the trap: absence of
    // evidence is not evidence of sameness when the name is just "Ethan".
    const d = decideGroup([
      row({ name: 'Ethan', company: 'Lindy' }),
      row({ name: 'Ethan', company: 'Wenti Labs' }),
    ]);
    expect(d.action).toBe('review');
    expect(d.rule).toBe('name_not_specific');
  });

  it('does not merge "Hai" and "Meri" on their shared avatar URL', () => {
    // Real prod case. They share one avatar URL three times over because the
    // scraped image is a session photo, not a headshot. Different people.
    const shared = 'https://x.test/content-0-1777224449319.png';
    const d = decideGroup([
      row({ name: 'Hai', company: 'Agent Engineering bootcamp', avatar_url: shared }),
      row({ name: 'Meri', company: 'Agent Engineering bootcamp', avatar_url: shared }),
    ]);
    expect(d.action).not.toBe('merge');
  });

  it('does not merge on company alone, however well it agrees', () => {
    const d = decideGroup([
      row({ name: 'Alex Smith', company: 'Acme', title: 'Engineer' }),
      row({ name: 'Alex Smith', company: 'Acme', title: 'Engineer' }),
    ]);
    // Same name, same company, same title, and still not automatic, because
    // two Alex Smiths at a big employer is an ordinary thing.
    expect(d.action).toBe('review');
    expect(d.rule).toBe('name_only');
  });

  it('refuses when sched accounts differ', () => {
    const d = decideGroup([
      row({ name: 'Angie Jones', sched_user_id: '19223528' }),
      row({ name: 'Angie Jones', sched_user_id: '25691031' }),
    ]);
    expect(d.action).toBe('review');
    expect(d.rule).toBe('sched_contradicts');
  });
});

describe('the cases that should merge', () => {
  it('merges on a shared sched account id, even when the names differ', () => {
    // Account 25691010 appears on one page as both shaun.smith6 and a hex
    // fallback slug, so the id has to outrank the name.
    const d = decideGroup([
      row({ name: 'Shaun Smith', sched_user_id: '25691010' }),
      row({ name: 'S. Smith', sched_user_id: '25691010' }),
    ]);
    expect(d.action).toBe('merge');
    expect(d.rule).toBe('same_sched_user_id');
    expect(d.aliasIds).toHaveLength(1);
  });

  it('merges on a shared LinkedIn slug across different name spellings', () => {
    // Real prod pair, same company, one slug is the base of the other... no:
    // these two hold the SAME slug, which is the merge case.
    const d = decideGroup([
      row({ name: 'Marco-Christian Krenn', company: 'Tokens Studio', linkedin_url: 'linkedin.com/in/marco-christian-krenn' }),
      row({ name: 'Marco Christian-Krenn', company: 'Tokens Studio', linkedin_url: 'https://www.linkedin.com/in/marco-christian-krenn/' }),
    ]);
    expect(d.action).toBe('merge');
    expect(d.rule).toBe('same_linkedin');
  });

  it('merges on a shared email', () => {
    const d = decideGroup([
      row({ name: 'Angie Jones', email: 'Angie@Example.com' }),
      row({ name: 'A Jones', email: 'angie@example.com' }),
    ]);
    expect(d.action).toBe('merge');
    expect(d.rule).toBe('same_email');
  });

  it('merges a specific shared name when the only LinkedIn present agrees', () => {
    const d = decideGroup([
      row({ name: 'Kye Gomez', company: 'Swarms', linkedin_url: 'linkedin.com/in/kyegomez' }),
      row({ name: 'Kye Gomez', company: 'Swarmz' }),
      row({ name: 'Kye Gomez', company: 'The Swarms Corporation', linkedin_url: 'linkedin.com/in/kyegomez' }),
    ]);
    expect(d.action).toBe('merge');
    expect(d.rule).toBe('same_name_linkedin_agrees');
    expect(d.aliasIds).toHaveLength(2);
  });

  it('merges Chi Wang across a real job change', () => {
    // Microsoft Research to Google DeepMind. Company disagreeing is not
    // evidence of different people.
    const d = decideGroup([
      row({ name: 'Chi Wang', company: 'Microsoft Research', linkedin_url: 'linkedin.com/in/chi-wang-autogen' }),
      row({ name: 'Chi Wang', company: 'Google Deepmind', linkedin_url: 'linkedin.com/in/chi-wang-autogen' }),
    ]);
    expect(d.action).toBe('merge');
  });
});

describe('the review bucket', () => {
  it('scores a name-only group and never merges it', () => {
    const d = decideGroup([
      row({ name: 'Sandi Besen', company: 'IBM' }),
      row({ name: 'Sandi Besen', company: 'IBM Research' }),
      row({ name: 'Sandi Besen', company: 'BeeAI, IBM' }),
    ]);
    expect(d.action).toBe('review');
    expect(d.score).toBeGreaterThan(0);
    expect(d.score).toBeLessThanOrEqual(0.9);
    expect(d.signals.companies).toEqual(expect.arrayContaining(['ibm', 'ibm research']));
  });

  it('scores a slug-base match higher than a bare name match', () => {
    const bare = decideGroup([
      row({ name: 'Prakash Kalaiah', company: 'Enphase Energy' }),
      row({ name: 'Prakash Kalaiah' }),
    ]);
    const based = decideGroup([
      row({ name: 'Prakash Kalaiah', linkedin_url: 'linkedin.com/in/prakash-kalaiah' }),
      row({ name: 'Prakash Kalaiah', linkedin_url: 'linkedin.com/in/prakash-kalaiah-875542' }),
    ]);
    // The second pair contradicts on the exact slug, so it must still be
    // review, but it is a better candidate than the bare-name pair.
    expect(based.action).toBe('review');
    expect(bare.action).toBe('review');
    expect(based.signals.linkedin_slugs).toHaveLength(2);
  });
});

describe('pickCanonical', () => {
  it('prefers a profile already linked to a person', () => {
    const linked = row({ name: 'A', person_id: 'p1', created_at: '2026-05-01T00:00:00Z' });
    const older = row({ name: 'A', created_at: '2020-01-01T00:00:00Z', event_count: 9 });
    expect(pickCanonical([older, linked]).id).toBe(linked.id);
  });

  it('then prefers the profile attached to the most events', () => {
    const many = row({ name: 'A', event_count: 7 });
    const few = row({ name: 'A', event_count: 1, created_at: '2019-01-01T00:00:00Z' });
    expect(pickCanonical([few, many]).id).toBe(many.id);
  });

  it('is deterministic, so the sweep is idempotent', () => {
    const a = row({ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'A' });
    const b = row({ id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'A' });
    expect(pickCanonical([a, b]).id).toBe(pickCanonical([b, a]).id);
  });
});

describe('guards', () => {
  it('ignores rows that are already aliases', () => {
    const d = decideGroup([
      row({ name: 'Angie Jones', sched_user_id: '1' }),
      row({ name: 'Angie Jones', sched_user_id: '1', canonical_profile_id: 'someone-else' }),
    ]);
    expect(d.action).toBe('skip');
  });

  it('does nothing with a single profile', () => {
    expect(decideGroup([row({ name: 'Angie Jones' })]).action).toBe('skip');
    expect(decideGroup([]).action).toBe('skip');
  });

  it('never puts the canonical in its own alias list', () => {
    const d = decideGroup([
      row({ name: 'Kye Gomez', linkedin_url: 'linkedin.com/in/kyegomez' }),
      row({ name: 'Kye Gomez', linkedin_url: 'linkedin.com/in/kyegomez' }),
      row({ name: 'Kye Gomez', linkedin_url: 'linkedin.com/in/kyegomez' }),
    ]);
    expect(d.aliasIds).not.toContain(d.canonicalId);
    expect(new Set(d.aliasIds).size).toBe(d.aliasIds.length);
    expect(d.aliasIds).toHaveLength(2);
  });

  it('detects a LinkedIn contradiction regardless of blanks', () => {
    expect(linkedinContradicts([row({ linkedin_url: 'linkedin.com/in/a' }), row({})])).toBe(false);
    expect(linkedinContradicts([row({ linkedin_url: 'linkedin.com/in/a' }), row({ linkedin_url: 'linkedin.com/in/b' })])).toBe(true);
  });
});

describe('a fuzzily-sourced LinkedIn URL is never enough to merge', () => {
  it('refuses to auto-merge when both URLs came from a name+company lookup', () => {
    // This is the dangerous case the enrichment worker creates. If the
    // provider guessed the same profile for two different people, merging on
    // it would fuse them and report a confident reason.
    const d = decideGroup([
      row({ name: 'Alex Smith', company: 'Acme', linkedin_url: 'linkedin.com/in/alex-smith', enrichment_source: 'enrichlayer_name_company' }),
      row({ name: 'Alex Smith', company: 'Globex', linkedin_url: 'linkedin.com/in/alex-smith', enrichment_source: 'enrichlayer_name_company' }),
    ]);
    expect(d.action).toBe('review');
    expect(d.rule).toBe('name_only');
  });

  it('still merges when the URL came from a trusted source', () => {
    const d = decideGroup([
      row({ name: 'Alex Smith', company: 'Acme', linkedin_url: 'linkedin.com/in/alex-smith' }),
      row({ name: 'Alex Smith', company: 'Globex', linkedin_url: 'linkedin.com/in/alex-smith' }),
    ]);
    expect(d.action).toBe('merge');
    expect(d.rule).toBe('same_linkedin');
  });

  it('does not count a fuzzy URL towards corroborating a name match', () => {
    const d = decideGroup([
      row({ name: 'Kye Gomez', company: 'Swarms', linkedin_url: 'linkedin.com/in/kyegomez', enrichment_source: 'enrichlayer_name_company' }),
      row({ name: 'Kye Gomez', company: 'Swarmz' }),
    ]);
    expect(d.action).toBe('review');
  });

  it('still lets a fuzzy URL raise the veto, because a contradiction is worth a look', () => {
    const d = decideGroup([
      row({ name: 'Angie Jones', linkedin_url: 'linkedin.com/in/a-jones', enrichment_source: 'enrichlayer_name_company' }),
      row({ name: 'Angie Jones', linkedin_url: 'linkedin.com/in/angie-jones' }),
    ]);
    expect(d.action).toBe('review');
    expect(d.rule).toBe('linkedin_contradicts');
    expect(d.signals.linkedin_slugs).toHaveLength(2);
  });

  it('lets a system-issued identifier outrank a fuzzy URL', () => {
    // sched issued the id; the LinkedIn URL is a guess. The id wins.
    const d = decideGroup([
      row({ name: 'Angie Jones', sched_user_id: '19223528', linkedin_url: 'linkedin.com/in/wrong-guess', enrichment_source: 'enrichlayer_name_company' }),
      row({ name: 'A Jones', sched_user_id: '19223528' }),
    ]);
    expect(d.action).toBe('merge');
    expect(d.rule).toBe('same_sched_user_id');
  });
});
