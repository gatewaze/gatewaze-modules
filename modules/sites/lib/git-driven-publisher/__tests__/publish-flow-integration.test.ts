/**
 * End-to-end integration test for the IGitDrivenPublisher publish flow.
 *
 * Per spec-sites-theme-kinds §15.2 — exercises the full happy-path chain:
 *
 *   1. Schema validation classifies a fresh content schema as safe to apply
 *   2. Page draft content is serialized via serializeContent() into mdx + JSON
 *   3. Branch name is derived deterministically via buildBranchName()
 *   4. Files are committed through the stub publisher (commit())
 *   5. Build webhook is signed, verified, and matched back to the publish job
 *   6. A second publish on the SAME branch with stale base is rejected
 *      (optimistic locking — §6.3)
 *   7. A subsequent publish with the correct base SHA succeeds and the file
 *      tree carries forward incrementally
 *
 * Why integration not unit: each step in isolation has unit-level coverage
 * already (stub.test.ts, serialize-content.test.ts, branch-slug.test.ts,
 * classify-drift tests, etc.). What was missing — and what §15.2 calls out —
 * is a single test asserting the contracts compose correctly. If a future
 * refactor breaks the wire-shape between two stages, this test fails first.
 *
 * Runs entirely in-process: no Postgres, no real Git host, no HTTP server.
 * The stub publisher provides the I/O facade.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createStubGitDrivenPublisher } from '../stub.js';
import { buildBranchName, pageBranchSlug } from '../branch-slug.js';
import { serializeContent, substitutePathTemplate } from '../serialize-content.js';
import { classifySchemaDrift } from '../../../../templates/lib/content-schemas/classify-drift.js';
import type { BuildStatusEvent, CommitFile } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures: a small Next.js theme with one page schema + one rendered page
// ---------------------------------------------------------------------------

/** A v1 schema as the theme repo would provide it (JSON Schema shape). */
const SCHEMA_V1 = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    cta_label: { type: 'string' },
  },
  required: ['title'],
};

/** A v2 schema that adds an optional field — must classify as 'safe'. */
const SCHEMA_V2_OPTIONAL_ADDED = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    cta_label: { type: 'string' },
    hero_image: { type: 'string' },
  },
  required: ['title'],
};

/** A v2 schema that drops a required field — must classify as breaking. */
const SCHEMA_V2_REQUIRED_DROPPED = {
  type: 'object',
  properties: {
    subtitle: { type: 'string' },
    cta_label: { type: 'string' },
  },
};

const PAGE = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  full_path: '/about',
  content: {
    title: 'About Us',
    subtitle: 'A tiny test fixture',
    cta_label: 'Learn more',
  },
};

const PUBLISH_ID = '11111111-2222-3333-4444-555555555555';

describe('Publish flow integration (IGitDrivenPublisher + stub)', () => {
  const publisher = createStubGitDrivenPublisher();
  beforeEach(() => publisher.reset());

  // -------------------------------------------------------------------------
  // Step 1 — Schema drift classification (gates whether we can publish at all)
  // -------------------------------------------------------------------------

  it('classifies optional-field addition as safe (drift gate passes)', () => {
    const result = classifySchemaDrift(SCHEMA_V1, SCHEMA_V2_OPTIONAL_ADDED);
    expect(result.overall).toBe('safe');
    // Item-level: should detect the new optional field explicitly.
    expect(result.items.some((i) => i.code === 'templates.drift.optional_field_added')).toBe(true);
  });

  it('classifies required-field removal as breaking (drift gate blocks)', () => {
    const result = classifySchemaDrift(SCHEMA_V1, SCHEMA_V2_REQUIRED_DROPPED);
    // The critical contract: "not safe" → publish flow must block.
    expect(result.overall).not.toBe('safe');
  });

  // -------------------------------------------------------------------------
  // Step 2 — Content serialization (mdx + json + path substitution)
  // -------------------------------------------------------------------------

  it('serializes page content to mdx with yaml frontmatter (deterministic)', () => {
    const a = serializeContent({ content: PAGE.content, format: 'mdx', frontmatterFormat: 'yaml' });
    const b = serializeContent({ content: PAGE.content, format: 'mdx', frontmatterFormat: 'yaml' });
    expect(a.text).toBe(b.text);
    expect(a.text).toMatch(/^---\n/);
    expect(a.text).toContain('title:');
    expect(a.text).toContain('About Us');
  });

  it('serializes page content to json (sorted keys, deterministic)', () => {
    const a = serializeContent({ content: PAGE.content, format: 'json' });
    const b = serializeContent({ content: { cta_label: 'Learn more', title: 'About Us', subtitle: 'A tiny test fixture' }, format: 'json' });
    expect(a.text).toBe(b.text); // Key order in input must not affect output.
  });

  it('substitutes the page route into a content path template', () => {
    const path = substitutePathTemplate('content/{route}.mdx', PAGE.full_path);
    expect(path).toBe('content/about.mdx');
  });

  // -------------------------------------------------------------------------
  // Step 3 — Branch name derivation
  // -------------------------------------------------------------------------

  it('derives a deterministic branch name from page + publish ids', () => {
    const branch = buildBranchName({
      fullPath: PAGE.full_path,
      pageId: PAGE.id,
      publishId: PUBLISH_ID,
      timestamp: new Date('2026-05-05T12:00:00Z'),
    });
    expect(branch).toMatch(/^content\/about-aaaaaaaa\/20260505120000-11111111$/);
    expect(pageBranchSlug(PAGE.full_path)).toBe('about');
  });

  // -------------------------------------------------------------------------
  // Step 4 — Commit through stub publisher (the publish step)
  // -------------------------------------------------------------------------

  async function publishOnce(opts: {
    files: ReadonlyArray<CommitFile>;
    branch: string;
    baseCommitSha: string | null;
  }) {
    const result = await publisher.commit({
      secrets: { token: 'test' },
      repoRef: { remote: 'stub://my-theme.git', branch: opts.branch },
      baseCommitSha: opts.baseCommitSha,
      files: opts.files,
      message: 'publish: about',
      author: { name: 'Test', email: 't@x' },
    });
    return result;
  }

  it('commits serialized content + asset files through the stub publisher', async () => {
    const branch = buildBranchName({
      fullPath: PAGE.full_path,
      pageId: PAGE.id,
      publishId: PUBLISH_ID,
      timestamp: new Date('2026-05-05T12:00:00Z'),
    });
    const mdx = serializeContent({ content: PAGE.content, format: 'mdx' }).text;
    const json = serializeContent({ content: PAGE.content, format: 'json' }).text;

    const result = await publishOnce({
      branch,
      baseCommitSha: null,
      files: [
        { path: substitutePathTemplate('content/{route}.mdx', PAGE.full_path), content: mdx, encoding: 'utf-8' },
        { path: substitutePathTemplate('content/{route}.json', PAGE.full_path), content: json, encoding: 'utf-8' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);

    const tree = publisher.getFiles(branch);
    expect(tree.has('content/about.mdx')).toBe(true);
    expect(tree.has('content/about.json')).toBe(true);
    expect(tree.get('content/about.mdx')).toContain('About Us');
  });

  // -------------------------------------------------------------------------
  // Step 5 — Webhook signature round-trip (build_succeeded → finalization
  //          would mark the job 'published' in real code; here we just verify
  //          the signature contract since DB writes aren't in scope)
  // -------------------------------------------------------------------------

  it('round-trips a build_succeeded webhook (signed → verified → matched)', async () => {
    const branch = buildBranchName({
      fullPath: PAGE.full_path,
      pageId: PAGE.id,
      publishId: PUBLISH_ID,
      timestamp: new Date('2026-05-05T12:00:00Z'),
    });
    const commit = await publishOnce({
      branch,
      baseCommitSha: null,
      files: [{ path: 'content/about.json', content: '{"title":"hi"}', encoding: 'utf-8' }],
    });
    if (!commit.ok) throw new Error('commit must succeed');

    const event: BuildStatusEvent = {
      kind: 'build_succeeded',
      commitSha: commit.commitSha,
      deploymentId: 'dep-42',
      url: 'https://about-aboutpage-deploy.example.app',
      durationMs: 28_500,
    };
    const { rawBody, signature } = publisher.emitWebhook(event);

    const verified = await publisher.verifyWebhookSignature({
      secrets: { token: 'test' },
      headers: { 'x-stub-signature': signature },
      rawBody,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      // The verified event MUST point back at our commit — that's the
      // matching contract the receiver uses to flip the publish job to
      // status='published'.
      expect(verified.event.kind).toBe('build_succeeded');
      if (verified.event.kind === 'build_succeeded') {
        expect(verified.event.commitSha).toBe(commit.commitSha);
        expect(verified.event.url).toBe('https://about-aboutpage-deploy.example.app');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Step 6 — Optimistic locking (§6.3): stale base on second publish fails
  // -------------------------------------------------------------------------

  it('rejects a second publish with stale baseCommitSha (optimistic lock)', async () => {
    const branch = 'content/lock-test/x';
    const first = await publishOnce({
      branch,
      baseCommitSha: null,
      files: [{ path: 'a.txt', content: '1', encoding: 'utf-8' }],
    });
    if (!first.ok) throw new Error('first publish must succeed');

    // Second publish with the WRONG base sha — simulates two editors hitting
    // publish concurrently. The second one MUST be rejected.
    const stale = await publishOnce({
      branch,
      baseCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      files: [{ path: 'b.txt', content: '2', encoding: 'utf-8' }],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.kind).toBe('stale_base');
  });

  it('accepts a follow-up publish that uses the current head as base', async () => {
    const branch = 'content/followup/x';
    const first = await publishOnce({
      branch,
      baseCommitSha: null,
      files: [{ path: 'a.txt', content: '1', encoding: 'utf-8' }],
    });
    if (!first.ok) throw new Error('first');

    const second = await publishOnce({
      branch,
      baseCommitSha: first.commitSha,
      files: [{ path: 'b.txt', content: '2', encoding: 'utf-8' }],
    });
    expect(second.ok).toBe(true);

    const tree = publisher.getFiles(branch);
    expect(tree.get('a.txt')).toBe('1'); // carry-forward
    expect(tree.get('b.txt')).toBe('2'); // new file
    expect(publisher.getCommits(branch).length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Step 7 — Failure path: build_failed webhook still verifies + parses
  // -------------------------------------------------------------------------

  it('round-trips a build_failed webhook (publish job → status=build_failed)', async () => {
    const event: BuildStatusEvent = {
      kind: 'build_failed',
      commitSha: 'feedface'.repeat(5),
      deploymentId: 'dep-99',
      logUrl: 'https://logs.example.com/dep-99',
      reason: 'TypeError: foo is not a function',
    };
    const { rawBody, signature } = publisher.emitWebhook(event);
    const verified = await publisher.verifyWebhookSignature({
      secrets: {},
      headers: { 'x-stub-signature': signature },
      rawBody,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok && verified.event.kind === 'build_failed') {
      expect(verified.event.reason).toContain('TypeError');
      expect(verified.event.logUrl).toBe('https://logs.example.com/dep-99');
    }
  });
});
