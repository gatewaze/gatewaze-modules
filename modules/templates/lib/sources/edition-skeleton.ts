/**
 * `edition.json` — the blocks a NEW edition starts with.
 *
 * A template repo can declare, next to its `blocks/` directory, which blocks
 * (in which order, optionally with starting content) every new edition is
 * seeded with. Without it an operator starts from an empty canvas and
 * either rebuilds the running order by hand or duplicates last week's
 * edition and deletes its content — both error-prone for a newsletter
 * whose sections are the same every week.
 *
 *   {
 *     "version": 1,
 *     "blocks": [
 *       "intro_paragraph",
 *       { "block": "section", "content": { "eyebrow": "FUNDING" } },
 *       "meme_of_week"
 *     ]
 *   }
 *
 * The file is read by the git ingest (initial connect and every Update) and
 * persisted on the library as `templates_libraries.new_edition_blocks`; the
 * consumer (newsletters' New edition page) resolves each key against the
 * library's current block defs. Unknown keys are tolerated here (they are
 * skipped at seed time) so a repo can reference a block that lands in a
 * later commit; the ingest logs them.
 *
 * Validation is strict about SHAPE, not keys: the file is operator-authored
 * but ends up in a jsonb column read by the browser, so sizes are capped and
 * prototype-polluting keys are refused.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const EDITION_SKELETON_FILE = 'edition.json';

const MAX_BYTES = 64 * 1024;
const MAX_BLOCKS = 50;
const KEY_RX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface EditionSkeletonBlock {
  key: string;
  /** Starting content for the block — merged over the block def's schema defaults. */
  content?: Record<string, unknown>;
}

export interface EditionSkeleton {
  version: 1;
  blocks: EditionSkeletonBlock[];
}

function fail(msg: string): never {
  throw new Error(`${EDITION_SKELETON_FILE}: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertJsonSafe(v: unknown, path: string, depth = 0): void {
  if (depth > 8) fail(`${path} is nested too deeply`);
  if (Array.isArray(v)) {
    v.forEach((item, i) => assertJsonSafe(item, `${path}[${i}]`, depth + 1));
    return;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) fail(`${path}.${k} is not an allowed key`);
      assertJsonSafe(v[k], `${path}.${k}`, depth + 1);
    }
    return;
  }
  const t = typeof v;
  if (v !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
    fail(`${path} must be JSON (string, number, boolean, null, array or object)`);
  }
}

/** Parse + validate the file's contents. Throws with an operator-readable message. */
export function parseEditionSkeleton(json: string): EditionSkeleton {
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) fail(`exceeds ${MAX_BYTES / 1024} KB`);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    fail(`invalid JSON (${e instanceof Error ? e.message : 'parse error'})`);
  }
  if (!isPlainObject(raw)) fail('must be a JSON object with a "blocks" array');
  if (raw['version'] !== undefined && raw['version'] !== 1) fail('"version" must be 1');
  const blocksRaw = raw['blocks'];
  if (!Array.isArray(blocksRaw)) fail('"blocks" must be an array');
  if (blocksRaw.length > MAX_BLOCKS) fail(`"blocks" lists more than ${MAX_BLOCKS} blocks`);

  const blocks: EditionSkeletonBlock[] = blocksRaw.map((entry, i) => {
    const where = `blocks[${i}]`;
    if (typeof entry === 'string') {
      if (!KEY_RX.test(entry)) fail(`${where} is not a valid block key`);
      return { key: entry };
    }
    if (!isPlainObject(entry)) fail(`${where} must be a block key or { "block": key }`);
    const key = entry['block'];
    if (typeof key !== 'string' || !KEY_RX.test(key)) fail(`${where}.block is not a valid block key`);
    const out: EditionSkeletonBlock = { key };
    if (entry['content'] !== undefined) {
      if (!isPlainObject(entry['content'])) fail(`${where}.content must be an object`);
      assertJsonSafe(entry['content'], `${where}.content`);
      out.content = entry['content'];
    }
    return out;
  });

  return { version: 1, blocks };
}

/**
 * Read `edition.json` from the walk root (the manifest subdirectory when one
 * is configured, else the repo root — the same place `blocks/` lives).
 * Returns null when the repo has no skeleton.
 */
export function readEditionSkeleton(repoDir: string, manifestPath?: string | null): EditionSkeleton | null {
  const root = manifestPath ? resolve(repoDir, manifestPath) : repoDir;
  const file = resolve(root, EDITION_SKELETON_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return parseEditionSkeleton(readFileSync(file, 'utf8'));
}

export interface SkeletonSupabaseClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): Promise<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Persist (or clear) the library's skeleton after a successful apply. A
 * library with several git sources takes the skeleton of whichever applied
 * last; the sibling repos each carry their own, so that is the common case
 * of one source per library in practice.
 */
export async function persistEditionSkeleton(
  supabase: SkeletonSupabaseClient,
  libraryId: string,
  skeleton: EditionSkeleton | null,
): Promise<void> {
  const { error } = await supabase
    .from('templates_libraries')
    .update({ new_edition_blocks: skeleton })
    .eq('id', libraryId);
  if (error) throw new Error(`templates_libraries update failed: ${error.message}`);
}

/** Keys the skeleton references that the apply did not produce — for the ingest log. */
export function unknownSkeletonKeys(skeleton: EditionSkeleton, appliedBlockKeys: ReadonlyArray<string>): string[] {
  const known = new Set(appliedBlockKeys);
  return [...new Set(skeleton.blocks.map((b) => b.key).filter((k) => !known.has(k)))];
}
