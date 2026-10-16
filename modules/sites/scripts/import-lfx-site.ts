#!/usr/bin/env tsx
/**
 * Import an lfx-mos-website bundle as a gatewaze site.
 *
 *   pnpm exec tsx modules/sites/scripts/import-lfx-site.ts \
 *     --zip ~/Git/danthebaker/website-builder/output/jupyter/jupyter-foundation-website.zip \
 *     --slug jupyter-foundation [--replace] [--ensure-repo] [--publish]
 *
 * Environment:
 *   SUPABASE_URL                public Supabase/Kong origin (default http://supabase.aaif.localhost)
 *   SUPABASE_SERVICE_ROLE_KEY   required
 *   SUPABASE_INTERNAL_URL       origin stored in logo_url rows that browsers cannot reach
 *                               (default http://supabase-kong:8000); rewritten to SUPABASE_URL
 *   API_URL                     platform API origin (default http://api.aaif.localhost)
 *   JWT_SECRET + ADMIN_USER_ID  only for --ensure-repo / --publish: a short-lived HS256 admin JWT
 *                               is minted locally for the two admin calls
 *   BLOG_BASE                   href base for blog posts without a canonical URL (default /blog)
 *
 * Runs on the host against the dev stack; nothing here is shipped in a container.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { ingestInline } from '../../templates/lib/sources/ingest.js';
import { validateCanvasTemplate } from '../lib/canvas-validate-template/index.js';
import { importLfxSite } from '../lib/lfx-import/import-site.js';
import { readLfxBundle } from '../lib/lfx-import/read-bundle.js';
import { createSupabaseLfxDataProvider } from '../lib/lfx-import/data-supabase.js';

interface Args {
  zip?: string;
  dir?: string;
  slug?: string;
  name?: string;
  replace: boolean;
  ensureRepo: boolean;
  publish: boolean;
  noData: boolean;
  allowRemote: boolean;
}

function isLocalOrigin(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): Args {
  const out: Args = { replace: false, ensureRepo: false, publish: false, noData: false, allowRemote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--zip') out.zip = next();
    else if (a === '--dir') out.dir = next();
    else if (a === '--slug') out.slug = next();
    else if (a === '--name') out.name = next();
    else if (a === '--replace') out.replace = true;
    else if (a === '--ensure-repo') out.ensureRepo = true;
    else if (a === '--publish') { out.publish = true; out.ensureRepo = true; }
    else if (a === '--no-data') out.noData = true;
    else if (a === '--allow-remote') out.allowRemote = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.zip && !out.dir) throw new Error('pass --zip <file> or --dir <extracted folder>');
  if (!out.slug) throw new Error('pass --slug <site-slug>');
  return out;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
}

/** `unzip` without a shell — the zip path is passed as an argument, never interpolated. */
function unzipTo(zip: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-q', '-o', zip, '-d', dir], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
  });
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** HS256 JWT the self-hosted requireJwt path verifies against JWT_SECRET. Ten minutes. */
function mintAdminJwt(secret: string, userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 600 }));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

async function adminPost(apiUrl: string, jwt: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = env('SUPABASE_URL', 'http://supabase.aaif.localhost').replace(/\/+$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const internalUrl = env('SUPABASE_INTERNAL_URL', 'http://supabase-kong:8000').replace(/\/+$/, '');
  const apiUrl = env('API_URL', 'http://api.aaif.localhost').replace(/\/+$/, '');
  // A service-role key and a minted admin JWT must not leave the dev box
  // unless the operator says so, and then only over https.
  for (const target of [supabaseUrl, apiUrl]) {
    if (!isLocalOrigin(target) && !args.allowRemote) {
      throw new Error(`${target} is not a local origin; pass --allow-remote (https only) to target it`);
    }
    if (!isLocalOrigin(target) && !target.startsWith('https://')) {
      throw new Error(`${target} must use https when targeting a remote host`);
    }
  }
  console.log(`targets: supabase ${supabaseUrl}, api ${apiUrl}`);

  let dir = args.dir;
  let tmp: string | null = null;
  if (args.zip) {
    tmp = await mkdtemp(join(tmpdir(), 'lfx-import-'));
    await unzipTo(args.zip, tmp);
    dir = tmp;
  }

  try {
    const bundle = await readLfxBundle(dir!);
    console.log(`bundle: ${bundle.site.project.name} (${bundle.site.meta?.generator ?? 'unknown generator'})`);

    // Why `any`: the modules workspace ships no generated Database types and
    // supabase-js's builders are PromiseLike, not Promise — same cast the
    // sites api uses (see register-routes.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as any;
    const dataProvider = args.noData
      ? null
      : createSupabaseLfxDataProvider(supabase, {
          rewriteUrl: (u) => (u.startsWith(internalUrl) ? supabaseUrl + u.slice(internalUrl.length) : u),
          blogBase: process.env.BLOG_BASE ?? '/blog',
        });

    const result = await importLfxSite(
      {
        supabase,
        ingestInline,
        validateCanvasTemplate,
        dataProvider,
        logger: { info: (m, meta) => console.log(m, meta ?? ''), warn: (m, meta) => console.warn('WARN', m, meta ?? '') },
      },
      { bundle, slug: args.slug!, name: args.name, replace: args.replace, createdBy: process.env.ADMIN_USER_ID ?? null },
    );

    console.log(`site ${result.siteId} (${result.reused ? 'reused' : 'created'}); library ${result.libraryId}`);
    for (const d of result.blockDefs) console.log(`  block_def ${d.key.padEnd(22)} ${d.valid ? 'ok' : 'INVALID: ' + d.errors.join(' | ')}`);
    for (const p of result.pages) console.log(`  page ${p.full_path.padEnd(28)} ${p.blockCount} blocks`);
    for (const e of result.fillErrors) console.warn(`  fill ${e.page} ${e.block}.${e.field}: ${e.message}`);

    if (args.ensureRepo) {
      const jwt = mintAdminJwt(env('JWT_SECRET'), env('ADMIN_USER_ID'));
      const repo = await adminPost(apiUrl, jwt, `/api/modules/sites/admin/sites/${result.siteId}/internal-repo:ensure`, {});
      console.log('internal repo:', JSON.stringify(repo));
      if (args.publish) {
        const pub = await adminPost(apiUrl, jwt, `/api/admin/sites/${result.siteId}/publish`, { reason: 'lfx-import', force: true });
        console.log('publish enqueued:', JSON.stringify(pub));
        const publishId = (pub as { publishId?: string }).publishId;
        if (publishId) {
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const row = await supabase.from('site_republish_log').select('status, error_message, publish_commit_sha, publish_tag').eq('id', publishId).maybeSingle();
            const r = row.data as { status: string; error_message: string | null; publish_commit_sha: string | null; publish_tag: string | null } | null;
            if (!r) continue;
            if (r.status === 'pending') continue;
            console.log(`publish ${r.status}${r.publish_commit_sha ? ` ${r.publish_commit_sha.slice(0, 10)} ${r.publish_tag ?? ''}` : ''}${r.error_message ? ` — ${r.error_message}` : ''}`);
            break;
          }
        }
      }
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
