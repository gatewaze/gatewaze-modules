import { describe, expect, it } from 'vitest';
import { dedupeConnectedRepos, type ConnectedRepoSource } from '../lib/connectedRepos.js';

const row = (over: Partial<ConnectedRepoSource>): ConnectedRepoSource => ({
  id: 'src',
  library_id: 'lib',
  kind: 'git',
  status: 'active',
  label: 'Template repo',
  url: 'https://github.com/org/templates.git',
  branch: 'main',
  manifest_path: null,
  created_at: '2026-10-01T00:00:00Z',
  library: { name: 'MLOps Community', host_kind: 'newsletter' },
  ...over,
});

describe('dedupeConnectedRepos', () => {
  it('lists each repo once, newest source first, naming everywhere it is connected', () => {
    const repos = dedupeConnectedRepos([
      row({ id: 'a', library_id: 'l1', created_at: '2026-10-01T00:00:00Z', library: { name: 'MLOps Community', host_kind: 'newsletter' } }),
      row({ id: 'b', library_id: 'l2', created_at: '2026-10-05T00:00:00Z', library: { name: 'Broadcast templates', host_kind: 'broadcasts' } }),
      row({ id: 'c', library_id: 'l3', url: 'https://github.com/org/other.git', created_at: '2026-10-03T00:00:00Z', library: { name: 'User Community', host_kind: 'newsletter' } }),
    ]);
    expect(repos.map((r) => r.sourceId)).toEqual(['b', 'c']);
    expect(repos[0].connectedTo).toEqual(['Broadcast templates (broadcasts)', 'MLOps Community']);
    expect(repos[1].connectedTo).toEqual(['User Community']);
  });

  it('treats a different branch or path as a different repo', () => {
    const repos = dedupeConnectedRepos([
      row({ id: 'a', library_id: 'l1' }),
      row({ id: 'b', library_id: 'l2', branch: 'theme' }),
      row({ id: 'c', library_id: 'l3', manifest_path: 'templates/email' }),
    ]);
    expect(repos).toHaveLength(3);
  });

  it('skips the library being configured, inactive sources and non-git sources', () => {
    const repos = dedupeConnectedRepos(
      [
        row({ id: 'own', library_id: 'me' }),
        row({ id: 'paused', library_id: 'l2', status: 'paused' }),
        row({ id: 'upload', library_id: 'l3', kind: 'upload', url: null }),
        row({ id: 'ok', library_id: 'l4', url: 'https://github.com/org/ok.git' }),
      ],
      'me',
    );
    expect(repos.map((r) => r.sourceId)).toEqual(['ok']);
  });
});
