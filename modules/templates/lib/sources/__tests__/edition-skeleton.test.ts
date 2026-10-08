import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEditionSkeleton, readEditionSkeleton, persistEditionSkeleton, unknownSkeletonKeys } from '../edition-skeleton.js';

describe('parseEditionSkeleton', () => {
  it('accepts string keys and { block, content } entries', () => {
    const s = parseEditionSkeleton(JSON.stringify({
      version: 1,
      blocks: ['intro_paragraph', { block: 'section', content: { eyebrow: 'FUNDING', items: [] } }, { block: 'meme_of_week' }],
    }));
    expect(s).toEqual({
      version: 1,
      blocks: [{ key: 'intro_paragraph' }, { key: 'section', content: { eyebrow: 'FUNDING', items: [] } }, { key: 'meme_of_week' }],
    });
  });

  it('tolerates a missing version and an empty list', () => {
    expect(parseEditionSkeleton('{"blocks":[]}')).toEqual({ version: 1, blocks: [] });
  });

  it.each([
    ['not json', 'invalid JSON'],
    ['[]', 'must be a JSON object'],
    ['{"blocks":{}}', '"blocks" must be an array'],
    ['{"version":2,"blocks":[]}', '"version" must be 1'],
    ['{"blocks":["Bad Key"]}', 'blocks[0] is not a valid block key'],
    ['{"blocks":[{"block":"../x"}]}', 'blocks[0].block is not a valid block key'],
    ['{"blocks":[{"block":"a","content":[]}]}', 'blocks[0].content must be an object'],
    ['{"blocks":[{"block":"a","content":{"__proto__":{"polluted":true}}}]}', 'not an allowed key'],
    ['{"blocks":[42]}', 'blocks[0] must be a block key'],
  ])('rejects %s', (json, message) => {
    expect(() => parseEditionSkeleton(json)).toThrow(message);
  });

  it('caps the block count and the file size', () => {
    expect(() => parseEditionSkeleton(JSON.stringify({ blocks: Array.from({ length: 51 }, () => 'a') }))).toThrow('more than 50');
    expect(() => parseEditionSkeleton(JSON.stringify({ blocks: [{ block: 'a', content: { body: 'x'.repeat(70 * 1024) } }] }))).toThrow('exceeds 64 KB');
  });
});

describe('readEditionSkeleton', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gatewaze-skeleton-test-'));
  });

  it('returns null when the repo has no edition.json', () => {
    expect(readEditionSkeleton(dir)).toBeNull();
  });

  it('reads edition.json from the repo root', () => {
    writeFileSync(resolve(dir, 'edition.json'), '{"blocks":["lead_commentary","top_stories"]}');
    expect(readEditionSkeleton(dir)?.blocks.map((b) => b.key)).toEqual(['lead_commentary', 'top_stories']);
  });

  it('reads from the manifest subdirectory when one is configured', () => {
    mkdirSync(resolve(dir, 'email/blocks'), { recursive: true });
    writeFileSync(resolve(dir, 'email/edition.json'), '{"blocks":["a"]}');
    writeFileSync(resolve(dir, 'edition.json'), '{"blocks":["root"]}');
    expect(readEditionSkeleton(dir, 'email')?.blocks.map((b) => b.key)).toEqual(['a']);
  });

  it('surfaces a malformed file as an error naming the file', () => {
    writeFileSync(resolve(dir, 'edition.json'), '{"blocks":"nope"}');
    expect(() => readEditionSkeleton(dir)).toThrow('edition.json: "blocks" must be an array');
  });
});

describe('persistEditionSkeleton', () => {
  it('writes the skeleton (or null) onto the library row', async () => {
    const calls: Array<{ table: string; values: Record<string, unknown>; id: unknown }> = [];
    const client = {
      from(table: string) {
        return {
          update(values: Record<string, unknown>) {
            return { eq: async (_col: string, id: unknown) => { calls.push({ table, values, id }); return { error: null }; } };
          },
        };
      },
    };
    const skeleton = { version: 1 as const, blocks: [{ key: 'a' }] };
    await persistEditionSkeleton(client, 'lib-1', skeleton);
    await persistEditionSkeleton(client, 'lib-1', null);
    expect(calls).toEqual([
      { table: 'templates_libraries', values: { new_edition_blocks: skeleton }, id: 'lib-1' },
      { table: 'templates_libraries', values: { new_edition_blocks: null }, id: 'lib-1' },
    ]);
  });

  it('throws on a database error', async () => {
    const client = { from: () => ({ update: () => ({ eq: async () => ({ error: { message: 'boom' } }) }) }) };
    await expect(persistEditionSkeleton(client, 'lib-1', null)).rejects.toThrow('boom');
  });
});

describe('unknownSkeletonKeys', () => {
  it('lists keys the apply did not produce, once each', () => {
    const s = { version: 1 as const, blocks: [{ key: 'a' }, { key: 'ghost' }, { key: 'ghost' }, { key: 'b' }] };
    expect(unknownSkeletonKeys(s, ['a', 'b'])).toEqual(['ghost']);
  });
});
