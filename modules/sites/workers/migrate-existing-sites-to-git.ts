// @ts-nocheck — depends on @supabase/supabase-js which lives in the main
// gatewaze workspace; runtime resolution works via the api package's
// node_modules. Excluded from strict tsconfig until workspace install
// is wired (see register-routes.ts for the same pattern).
/**
 * One-time post-migration script: provisions internal git for every
 * existing site/list that doesn't already have one.
 *
 * Per spec-content-modules-git-architecture §20.1:
 *   1. Find sites without a gatewaze_internal_repos row
 *   2. Create internal bare repo
 *   3. Clone gatewaze-template-site@v1.0.0
 *   4. Customize package.json name → gatewaze-site-<slug>
 *   5. Push initial commit on `main`
 *   6. Walk pages → write content/pages/<slug>.json on `publish` branch
 *   7. Tag publish/initial
 *
 * Idempotent: re-running skips already-provisioned sites by checking
 * gatewaze_internal_repos. Operator runs via:
 *
 *   pnpm --filter @gatewaze/api exec tsx \
 *     ../../gatewaze-modules/modules/sites/workers/migrate-existing-sites-to-git.ts
 *
 * Or wired into the platform's migration runner as a post-migration hook.
 */

import { createClient } from '@supabase/supabase-js';
import { InternalGitServerImpl } from '../lib/git/internal-git-server-impl.js';
import { PublishWorker } from '../lib/publish-worker/publish-worker.js';
import { buildSiteContentFiles } from '../lib/publish-worker/build-site-content.js';
import { randomBytes } from 'node:crypto';

interface MigrationOptions {
  /** Bare-repo PVC root. Default /var/gatewaze/git. */
  gitRoot?: string;
  /** HMAC signing key for signed URLs (stable across run; from env). */
  signingKey?: Buffer;
  /** Boilerplate URL + tag. */
  boilerplate?: { url: string; tag: string };
  /** Dry-run: log what would happen without making changes. */
  dryRun?: boolean;
}

interface MigrationStats {
  sitesScanned: number;
  sitesProvisioned: number;
  sitesSkipped: number;
  sitesFailed: number;
  errors: Array<{ siteId: string; error: string }>;
}

export async function migrateExistingSitesToGit(opts: MigrationOptions = {}): Promise<MigrationStats> {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const gitRoot = opts.gitRoot ?? process.env.SITES_INTERNAL_GIT_ROOT ?? '/var/gatewaze/git';
  const signingKey = opts.signingKey ?? Buffer.from(process.env.SITES_GIT_SIGNING_KEY ?? randomBytes(32).toString('hex'), 'hex');
  const boilerplate = opts.boilerplate ?? {
    url: 'https://github.com/gatewaze/gatewaze-template-site.git',
    tag: 'v1.0.0',
  };
  const dryRun = opts.dryRun ?? false;

  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(`[migrate-sites-to-git] ${msg}`, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[migrate-sites-to-git] ${msg}`, meta ?? ''),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(`[migrate-sites-to-git] ${msg}`, meta ?? ''),
  };

  const gitServer = new InternalGitServerImpl({
    rootDir: gitRoot,
    signingKey,
    supabase: supabase as any,
    logger,
  });

  const stats: MigrationStats = { sitesScanned: 0, sitesProvisioned: 0, sitesSkipped: 0, sitesFailed: 0, errors: [] };

  // 1. Find all active sites that don't have an internal repo yet.
  // (External-git sites also get scanned but skipped — they have their
  // own repo and don't need bare-repo provisioning.)
  const sitesResult = await supabase
    .from('sites')
    .select('id, slug, name, theme_kind, git_provenance, git_url')
    .eq('status', 'active');
  const sites = (sitesResult.data ?? []) as Array<{
    id: string; slug: string; name: string; theme_kind: string; git_provenance: string; git_url: string | null;
  }>;
  stats.sitesScanned = sites.length;
  logger.info(`scanning ${sites.length} sites`);

  for (const site of sites) {
    if (site.git_provenance === 'external') {
      logger.info(`skip ${site.slug}: external git`, { gitUrl: site.git_url });
      stats.sitesSkipped++;
      continue;
    }

    // Check existing internal repo
    const existing = await gitServer.lookupRepo('site', site.id);
    if (existing) {
      logger.info(`skip ${site.slug}: already provisioned`, { barePath: existing.barePath });
      stats.sitesSkipped++;
      continue;
    }

    // Skip the special portal site (no real repo per spec §16.2)
    if (site.slug === 'portal') {
      logger.info('skip portal: option B metadata-only');
      stats.sitesSkipped++;
      continue;
    }

    if (dryRun) {
      logger.info(`dry-run: would provision ${site.slug}`);
      continue;
    }

    try {
      logger.info(`provisioning ${site.slug}…`);
      const repo = await gitServer.createRepo({
        hostKind: 'site',
        hostId: site.id,
        slug: site.slug,
        boilerplate,
        initialCommitter: { name: 'gatewaze migrator', email: 'noreply@gatewaze.local' },
      });

      // Update site row with the resolved git_url (internal HTTPS endpoint)
      const internalGitUrl = `${process.env.GATEWAZE_API_URL ?? 'http://localhost:4000'}/git/site/${site.slug}.git`;
      await supabase.from('sites').update({ git_url: internalGitUrl }).eq('id', site.id);

      // Build initial publish-branch content from existing pages
      const files = await buildSiteContentFiles(site.id, undefined, {
        supabase: supabase as any,
        logger,
      });

      if (files.size > 0) {
        await gitServer.publishCommit({
          repo,
          branch: 'publish',
          files,
          message: 'Initial publish from migration',
          tag: 'publish/initial',
          author: { name: 'gatewaze migrator', email: 'noreply@gatewaze.local' },
        });
        logger.info(`provisioned ${site.slug}: ${files.size} files committed to publish`);
      } else {
        logger.info(`provisioned ${site.slug}: no published pages yet (boilerplate only on main)`);
      }

      stats.sitesProvisioned++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`failed to provision ${site.slug}`, { error: message });
      stats.errors.push({ siteId: site.id, error: message });
      stats.sitesFailed++;
    }
  }

  logger.info('migration done', stats);
  return stats;
}

// Lists provisioning follows the same pattern; deferred to a separate
// migrate-existing-lists-to-git.ts when the newsletters send-flow
// integration ships.

// ===========================================================================
// CLI entrypoint
// ===========================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  migrateExistingSitesToGit({ dryRun })
    .then((stats) => {
      console.log(JSON.stringify(stats, null, 2));
      process.exit(stats.sitesFailed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('migration failed:', err);
      process.exit(2);
    });
}
