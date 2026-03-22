/**
 * API routes for the environments module.
 *
 * Handles:
 *  - Full provisioning of clean Supabase projects (schema + functions + content)
 *  - Content-only sync between environments (push/pull rows, files)
 *  - Connection testing and table discovery
 */

import type { Express, Request, Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { resolve, join } from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';

let PROJECT_ROOT = resolve(import.meta.dirname ?? __dirname, '../../../..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLocalSupabaseCredentials() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

async function getLocalSupabase() {
  const { url, key } = getLocalSupabaseCredentials();
  if (!url || !key) throw new Error('Missing local SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

async function fetchEnvironment(id: string) {
  const supabase = await getLocalSupabase();
  const { data, error } = await supabase.from('environments').select('*').eq('id', id).single();
  if (error || !data) throw new Error('Environment not found');
  return data;
}

/**
 * Execute raw SQL against a remote Supabase instance.
 *
 * Strategy (tried in order):
 *  1. exec_sql RPC (available after core migrations applied)
 *  2. pg-meta /query endpoint (available on all Supabase instances)
 *  3. Supabase Management API (requires cloud project)
 *
 * When `returnRows` is true, attempts to return query result rows (only
 * supported by pg-meta and management API fallbacks).
 */
async function executeRemoteSQL(
  supabaseUrl: string,
  serviceRoleKey: string,
  sql: string,
  options?: { returnRows?: boolean },
): Promise<{ success: boolean; rows?: any[]; error?: string }> {
  // --- 1. exec_sql RPC (void return, fastest) ---
  if (!options?.returnRows) {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql_text: sql }),
    });

    if (rpcRes.ok) return { success: true };
  }

  // --- 2. pg-meta /query endpoint ---
  const pgMetaUrl = supabaseUrl.replace('/rest/v1', '').replace(/\/$/, '');
  const queryRes = await fetch(`${pgMetaUrl}/pg/query`, {
    method: 'POST',
    headers: {
      'x-connection-encrypted': serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (queryRes.ok) {
    if (options?.returnRows) {
      try {
        const data = await queryRes.json();
        // pg-meta returns an array of row objects
        const rows = Array.isArray(data) ? data : [];
        return { success: true, rows };
      } catch {
        return { success: true, rows: [] };
      }
    }
    return { success: true };
  }

  // --- 3. Supabase Management API ---
  const refMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
  if (refMatch) {
    const projectRef = refMatch[1];
    const mgmtRes = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      }
    );

    if (mgmtRes.ok) {
      if (options?.returnRows) {
        try {
          const data = await mgmtRes.json();
          const rows = Array.isArray(data) ? data : [];
          return { success: true, rows };
        } catch {
          return { success: true, rows: [] };
        }
      }
      return { success: true };
    }
  }

  // --- 4. Last resort: try exec_sql even for returnRows ---
  if (options?.returnRows) {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql_text: sql }),
    });

    if (rpcRes.ok) return { success: true, rows: [] };
  }

  // All strategies failed
  const errText = await queryRes.text().catch(() => 'Unknown error');
  return { success: false, error: `SQL execution failed: ${errText}` };
}

/**
 * SQL to bootstrap the migration tracking table on a remote target.
 * This must run before any tracked migrations.
 */
const BOOTSTRAP_TRACKING_SQL = `
CREATE TABLE IF NOT EXISTS public.gatewaze_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure service_role can access it
ALTER TABLE public.gatewaze_migrations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'gatewaze_migrations' AND policyname = 'gatewaze_migrations_service'
  ) THEN
    CREATE POLICY gatewaze_migrations_service ON public.gatewaze_migrations
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
`;

/**
 * Compute a simple checksum for a SQL string (same SHA-256 approach as module migrations).
 */
async function computeChecksum(content: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Query which migrations have already been applied on a remote target.
 * Returns a Map of filename → checksum.
 */
async function getAppliedMigrations(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Map<string, string>> {
  const applied = new Map<string, string>();

  // Try reading from the tracking table via REST API
  const res = await fetch(
    `${supabaseUrl}/rest/v1/gatewaze_migrations?select=filename,checksum`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }
  );

  if (res.ok) {
    const rows = await res.json();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        applied.set(row.filename, row.checksum);
      }
    }
  }

  return applied;
}

/**
 * Record a migration as applied on the remote target.
 */
async function recordMigration(
  supabaseUrl: string,
  serviceRoleKey: string,
  filename: string,
  checksum: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/gatewaze_migrations`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ filename, checksum }),
  });
}

/**
 * Load core migration SQL files in order.
 */
function loadCoreMigrations(): Array<{ filename: string; sql: string }> {
  const migrationsDir = resolve(PROJECT_ROOT, 'supabase/migrations');

  if (!existsSync(migrationsDir)) return [];

  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      filename,
      sql: readFileSync(join(migrationsDir, filename), 'utf-8'),
    }));
}

/**
 * Load module migration SQL files for all enabled modules.
 */
async function loadModuleMigrations(): Promise<
  Array<{ moduleId: string; moduleName: string; filename: string; sql: string }>
> {
  const { loadModules } = await import('@gatewaze/shared/modules');
  const configImport = await import(resolve(PROJECT_ROOT, 'gatewaze.config.ts'));
  const config = (configImport as any)?.default ?? configImport;
  const modules = await loadModules(config, PROJECT_ROOT);
  const migrations: Array<{ moduleId: string; moduleName: string; filename: string; sql: string }> = [];

  for (const mod of modules) {
    if (!mod.config.migrations?.length) continue;

    for (const migrationPath of mod.config.migrations) {
      // Resolve migration file relative to module directory
      const resolvedPath = mod.resolvedDir
        ? resolve(mod.resolvedDir, migrationPath)
        : null;

      if (resolvedPath && existsSync(resolvedPath)) {
        migrations.push({
          moduleId: mod.config.id,
          moduleName: mod.config.name,
          filename: migrationPath,
          sql: readFileSync(resolvedPath, 'utf-8'),
        });
      }
    }
  }

  return migrations;
}

/**
 * Get list of edge functions and their source directories.
 */
async function getEdgeFunctions(): Promise<Array<{ name: string; sourceDir: string }>> {
  const functionsDir = resolve(PROJECT_ROOT, 'supabase/functions');
  if (!existsSync(functionsDir)) return [];

  return readdirSync(functionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => ({
      name: d.name,
      sourceDir: join(functionsDir, d.name),
    }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRoutes(app: Express, context?: ModuleContext) {
  // Use context from the module loader when available (works for git/zip sources),
  // fall back to hardcoded relative path for direct imports during development.
  if (context?.projectRoot) {
    PROJECT_ROOT = context.projectRoot;
  }

  // =========================================================================
  // PROVISION — Full deployment to a clean Supabase project
  // =========================================================================

  /**
   * POST /api/environments/provision
   *
   * Apply the full Gatewaze platform to a target environment:
   *  1. Core database migrations (schema, RLS, functions)
   *  2. Module migrations
   *  3. Storage bucket creation
   *  4. Edge function deployment info
   *
   * Body: {
   *   environmentId: string,
   *   steps: {
   *     coreMigrations: boolean,
   *     moduleMigrations: boolean,
   *     storageBuckets: boolean,
   *     edgeFunctions: boolean,
   *     contentSync: boolean,
   *   }
   * }
   */
  app.post('/api/environments/provision', async (req: Request, res: Response) => {
    try {
      const { environmentId, steps } = req.body;

      if (!environmentId) {
        return res.status(400).json({ error: 'environmentId is required' });
      }

      const target = await fetchEnvironment(environmentId);

      if (!target.supabase_service_role_key) {
        return res.status(400).json({ error: 'Target environment missing service role key' });
      }

      const localSupabase = await getLocalSupabase();

      // Create sync operation to track provisioning
      const { data: syncOp, error: opError } = await localSupabase
        .from('environment_sync_operations')
        .insert({
          direction: 'push',
          source_environment_id: (await localSupabase
            .from('environments')
            .select('id')
            .eq('is_current', true)
            .maybeSingle()).data?.id ?? environmentId,
          target_environment_id: environmentId,
          tables_synced: [],
          storage_buckets_synced: [],
          edge_functions_synced: steps?.edgeFunctions ?? false,
          auth_config_synced: false,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (opError) {
        return res.status(500).json({ error: 'Failed to create operation record' });
      }

      // Return immediately, run provisioning in background
      res.json({ success: true, operationId: syncOp.id, status: 'running' });

      // --- Background provisioning ---
      const log: Array<{ timestamp: string; level: string; message: string }> = [];
      const addLog = (level: string, message: string) => {
        log.push({ timestamp: new Date().toISOString(), level, message });
        console.log(`[environments:provision] [${level}] ${message}`);
      };

      try {
        // Step 0: Bootstrap migration tracking table on target
        addLog('info', 'Bootstrapping migration tracking on target...');
        const bootstrapResult = await executeRemoteSQL(
          target.supabase_url,
          target.supabase_service_role_key,
          BOOTSTRAP_TRACKING_SQL,
        );
        if (!bootstrapResult.success) {
          addLog('warn', `Could not bootstrap tracking table: ${bootstrapResult.error}`);
          addLog('warn', 'Will proceed without incremental tracking — all migrations will be applied.');
        }

        // Query which migrations have already been applied on target
        const appliedMigrations = await getAppliedMigrations(
          target.supabase_url,
          target.supabase_service_role_key,
        );
        addLog('info', `Target has ${appliedMigrations.size} previously applied migration(s)`);

        // Step 1: Core migrations
        if (steps?.coreMigrations !== false) {
          addLog('info', 'Checking core database migrations...');
          const coreMigrations = loadCoreMigrations();
          let applied = 0;
          let skipped = 0;

          for (const migration of coreMigrations) {
            const checksum = await computeChecksum(migration.sql);
            const existingChecksum = appliedMigrations.get(migration.filename);

            if (existingChecksum === checksum) {
              addLog('info', `Skipping ${migration.filename} (already applied, checksum matches)`);
              skipped++;
              continue;
            }

            if (existingChecksum && existingChecksum !== checksum) {
              addLog('warn', `${migration.filename} has changed since last apply — re-applying`);
            }

            addLog('info', `Applying ${migration.filename}...`);
            const result = await executeRemoteSQL(
              target.supabase_url,
              target.supabase_service_role_key,
              migration.sql,
            );

            if (!result.success) {
              addLog('error', `Failed to apply ${migration.filename}: ${result.error}`);
            } else {
              addLog('success', `Applied ${migration.filename}`);
              await recordMigration(
                target.supabase_url,
                target.supabase_service_role_key,
                migration.filename,
                checksum,
              );
              applied++;
            }
          }

          addLog('success', `Core migrations: ${applied} applied, ${skipped} skipped (already up-to-date)`);
        }

        // Step 2: Module migrations
        if (steps?.moduleMigrations !== false) {
          addLog('info', 'Checking module migrations...');
          const moduleMigrations = await loadModuleMigrations();
          let applied = 0;
          let skipped = 0;

          for (const migration of moduleMigrations) {
            // Use a namespaced key to avoid collisions with core migrations
            const trackingKey = `module:${migration.moduleId}/${migration.filename}`;
            const checksum = await computeChecksum(migration.sql);
            const existingChecksum = appliedMigrations.get(trackingKey);

            if (existingChecksum === checksum) {
              addLog('info', `Skipping ${migration.moduleName}: ${migration.filename} (already applied)`);
              skipped++;
              continue;
            }

            if (existingChecksum && existingChecksum !== checksum) {
              addLog('warn', `${migration.moduleName}: ${migration.filename} has changed — re-applying`);
            }

            addLog('info', `Applying ${migration.moduleName}: ${migration.filename}...`);
            const result = await executeRemoteSQL(
              target.supabase_url,
              target.supabase_service_role_key,
              migration.sql,
            );

            if (!result.success) {
              addLog('error', `Failed: ${migration.filename}: ${result.error}`);
            } else {
              addLog('success', `Applied ${migration.moduleName}: ${migration.filename}`);
              await recordMigration(
                target.supabase_url,
                target.supabase_service_role_key,
                trackingKey,
                checksum,
              );
              applied++;
            }
          }

          // Reconcile installed_modules table on the target
          addLog('info', 'Syncing module registry to target...');
          const { loadModules } = await import('@gatewaze/shared/modules');
          const configImport = await import(resolve(PROJECT_ROOT, 'gatewaze.config.ts'));
          const config = (configImport as any)?.default ?? configImport;
          const modules = await loadModules(config, PROJECT_ROOT);

          for (const mod of modules) {
            const moduleRecord = {
              id: mod.config.id,
              name: mod.config.name,
              version: mod.config.version,
              features: mod.config.features,
              status: 'enabled',
              type: mod.config.type || 'feature',
              source: 'provisioned',
              visibility: mod.config.visibility || 'public',
              description: mod.config.description || '',
            };

            await fetch(`${target.supabase_url}/rest/v1/installed_modules`, {
              method: 'POST',
              headers: {
                apikey: target.supabase_service_role_key,
                Authorization: `Bearer ${target.supabase_service_role_key}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal',
              },
              body: JSON.stringify(moduleRecord),
            });
          }

          addLog('success', `Module migrations: ${applied} applied, ${skipped} skipped, ${modules.length} modules registered`);
        }

        // Step 3: Storage buckets
        if (steps?.storageBuckets !== false) {
          addLog('info', 'Creating storage buckets...');
          const { url: localUrl, key: localKey } = getLocalSupabaseCredentials();

          if (localUrl && localKey) {
            // List buckets from local environment
            const bucketsRes = await fetch(`${localUrl}/storage/v1/bucket`, {
              headers: {
                apikey: localKey,
                Authorization: `Bearer ${localKey}`,
              },
            });

            if (bucketsRes.ok) {
              const buckets = await bucketsRes.json();

              for (const bucket of buckets) {
                addLog('info', `Creating bucket: ${bucket.name}`);
                await fetch(`${target.supabase_url}/storage/v1/bucket`, {
                  method: 'POST',
                  headers: {
                    apikey: target.supabase_service_role_key,
                    Authorization: `Bearer ${target.supabase_service_role_key}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    id: bucket.id || bucket.name,
                    name: bucket.name,
                    public: bucket.public ?? false,
                    file_size_limit: bucket.file_size_limit,
                    allowed_mime_types: bucket.allowed_mime_types,
                  }),
                });
              }

              addLog('success', `Storage buckets created (${buckets.length})`);
            }
          }
        }

        // Step 4: Edge functions
        if (steps?.edgeFunctions !== false) {
          addLog('info', 'Checking edge functions...');
          const functions = await getEdgeFunctions();

          if (functions.length > 0) {
            addLog('info', `Found ${functions.length} edge functions to deploy`);

            // Extract project ref from target URL for CLI commands
            const refMatch = target.supabase_url.match(/https:\/\/([^.]+)\.supabase\.co/);
            const projectRef = refMatch ? refMatch[1] : '<project-ref>';

            addLog('info', 'Edge functions must be deployed via the Supabase CLI.');
            addLog('info', 'Run the following commands:');
            addLog('info', '');
            addLog('info', `  supabase link --project-ref ${projectRef}`);

            for (const fn of functions) {
              addLog('info', `  supabase functions deploy ${fn.name} --project-ref ${projectRef}`);
            }

            addLog('info', '');
            addLog('info', `Or deploy all at once:`);
            addLog('info', `  supabase functions deploy --project-ref ${projectRef}`);
            addLog('warn', 'Automated edge function deployment requires the Supabase CLI to be installed and authenticated.');
          } else {
            addLog('info', 'No edge functions found to deploy');
          }
        }

        // Step 5: Content sync (optional)
        if (steps?.contentSync) {
          addLog('info', 'Content sync should be run separately via the Sync page after provisioning.');
        }

        // Mark complete
        await localSupabase
          .from('environment_sync_operations')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            log,
          })
          .eq('id', syncOp.id);

        // Update target environment status
        await localSupabase
          .from('environments')
          .update({
            status: 'active',
            last_connected_at: new Date().toISOString(),
          })
          .eq('id', environmentId);

        addLog('success', 'Provisioning complete!');
      } catch (err: any) {
        addLog('error', `Provisioning failed: ${err.message}`);
        await localSupabase
          .from('environment_sync_operations')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: err.message,
            log,
          })
          .eq('id', syncOp.id);
      }
    } catch (err: any) {
      console.error('[environments] Provision error:', err);
      return res.status(500).json({ error: err.message || 'Provisioning failed' });
    }
  });

  /**
   * GET /api/environments/provision/preview?environmentId=xxx
   *
   * Preview what will be applied during provisioning.
   * If environmentId is provided, diffs against already-applied migrations.
   */
  app.get('/api/environments/provision/preview', async (req: Request, res: Response) => {
    try {
      const coreMigrations = loadCoreMigrations();
      const moduleMigrations = await loadModuleMigrations();
      const edgeFunctions = await getEdgeFunctions();

      const { url: localUrl, key: localKey } = getLocalSupabaseCredentials();
      let buckets: string[] = [];

      if (localUrl && localKey) {
        const bucketsRes = await fetch(`${localUrl}/storage/v1/bucket`, {
          headers: {
            apikey: localKey,
            Authorization: `Bearer ${localKey}`,
          },
        });
        if (bucketsRes.ok) {
          const data = await bucketsRes.json();
          buckets = data.map((b: any) => b.name);
        }
      }

      // If an environmentId is provided, check what's already applied
      let appliedMigrations = new Map<string, string>();
      const environmentId = req.query.environmentId as string | undefined;

      if (environmentId) {
        try {
          const env = await fetchEnvironment(environmentId);
          if (env.supabase_service_role_key) {
            appliedMigrations = await getAppliedMigrations(
              env.supabase_url,
              env.supabase_service_role_key,
            );
          }
        } catch {
          // Target may not be reachable — that's fine, show all as pending
        }
      }

      // Compute status for each migration
      const coreMigrationsWithStatus = await Promise.all(
        coreMigrations.map(async (m) => {
          const checksum = await computeChecksum(m.sql);
          const existingChecksum = appliedMigrations.get(m.filename);
          let status: 'pending' | 'applied' | 'changed' = 'pending';
          if (existingChecksum === checksum) status = 'applied';
          else if (existingChecksum) status = 'changed';
          return { filename: m.filename, status };
        })
      );

      const moduleMigrationsWithStatus = await Promise.all(
        moduleMigrations.map(async (m) => {
          const trackingKey = `module:${m.moduleId}/${m.filename}`;
          const checksum = await computeChecksum(m.sql);
          const existingChecksum = appliedMigrations.get(trackingKey);
          let status: 'pending' | 'applied' | 'changed' = 'pending';
          if (existingChecksum === checksum) status = 'applied';
          else if (existingChecksum) status = 'changed';
          return {
            moduleId: m.moduleId,
            moduleName: m.moduleName,
            filename: m.filename,
            status,
          };
        })
      );

      return res.json({
        coreMigrations: coreMigrationsWithStatus,
        moduleMigrations: moduleMigrationsWithStatus,
        edgeFunctions: edgeFunctions.map((f) => f.name),
        storageBuckets: buckets,
        targetHasTracking: appliedMigrations.size > 0,
        appliedCount: appliedMigrations.size,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // CONTENT SYNC — Push/pull rows and files between environments
  // =========================================================================

  /**
   * POST /api/environments/sync
   *
   * Execute a content sync between two environments.
   */
  app.post('/api/environments/sync', async (req: Request, res: Response) => {
    try {
      const {
        direction,
        sourceEnvironmentId,
        targetEnvironmentId,
        tables = [],
        storageBuckets = [],
        conflictStrategy = 'skip',
      } = req.body;

      if (!sourceEnvironmentId || !targetEnvironmentId) {
        return res.status(400).json({ error: 'Source and target environment IDs required' });
      }

      if (!['push', 'pull'].includes(direction)) {
        return res.status(400).json({ error: 'Direction must be "push" or "pull"' });
      }

      if (tables.length === 0 && storageBuckets.length === 0) {
        return res.status(400).json({ error: 'Nothing selected to sync' });
      }

      const [source, target] = await Promise.all([
        fetchEnvironment(sourceEnvironmentId),
        fetchEnvironment(targetEnvironmentId),
      ]);

      if (!source.supabase_service_role_key) {
        return res.status(400).json({ error: 'Source missing service role key' });
      }
      if (!target.supabase_service_role_key) {
        return res.status(400).json({ error: 'Target missing service role key' });
      }

      const localSupabase = await getLocalSupabase();

      const { data: syncOp, error: opError } = await localSupabase
        .from('environment_sync_operations')
        .insert({
          direction,
          source_environment_id: sourceEnvironmentId,
          target_environment_id: targetEnvironmentId,
          tables_synced: tables,
          storage_buckets_synced: storageBuckets,
          edge_functions_synced: false,
          auth_config_synced: false,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (opError) {
        return res.status(500).json({ error: 'Failed to create sync operation' });
      }

      res.json({ success: true, operationId: syncOp.id, status: 'running' });

      // --- Background sync ---
      const log: Array<{ timestamp: string; level: string; message: string }> = [];
      let totalProcessed = 0;
      let totalInserted = 0;
      let totalSkipped = 0;
      let totalFiles = 0;

      const addLog = (level: string, message: string) => {
        log.push({ timestamp: new Date().toISOString(), level, message });
      };

      try {
        // Sync tables
        for (const tableName of tables) {
          addLog('info', `Syncing table: ${tableName}`);

          const fetchRes = await fetch(
            `${source.supabase_url}/rest/v1/${tableName}?select=*`,
            {
              headers: {
                apikey: source.supabase_service_role_key,
                Authorization: `Bearer ${source.supabase_service_role_key}`,
              },
            }
          );

          if (!fetchRes.ok) {
            addLog('error', `Failed to read ${tableName}: ${fetchRes.statusText}`);
            continue;
          }

          const rows = await fetchRes.json();
          addLog('info', `Found ${rows.length} rows`);

          const batchSize = 500;
          for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);

            let prefer = 'return=minimal';
            if (conflictStrategy === 'skip') {
              prefer += ',resolution=ignore-duplicates';
            } else {
              prefer += ',resolution=merge-duplicates';
            }

            const insertRes = await fetch(
              `${target.supabase_url}/rest/v1/${tableName}`,
              {
                method: 'POST',
                headers: {
                  apikey: target.supabase_service_role_key,
                  Authorization: `Bearer ${target.supabase_service_role_key}`,
                  'Content-Type': 'application/json',
                  Prefer: prefer,
                },
                body: JSON.stringify(batch),
              }
            );

            if (insertRes.ok) {
              totalInserted += batch.length;
            } else {
              totalSkipped += batch.length;
              addLog('warn', `Batch for ${tableName} returned ${insertRes.status}`);
            }
            totalProcessed += batch.length;
          }

          addLog('success', `Completed ${tableName}`);
        }

        // Sync storage
        for (const bucketName of storageBuckets) {
          addLog('info', `Syncing bucket: ${bucketName}`);

          const listRes = await fetch(
            `${source.supabase_url}/storage/v1/object/list/${bucketName}`,
            {
              method: 'POST',
              headers: {
                apikey: source.supabase_service_role_key,
                Authorization: `Bearer ${source.supabase_service_role_key}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ prefix: '', limit: 1000 }),
            }
          );

          if (!listRes.ok) {
            addLog('error', `Failed to list ${bucketName}`);
            continue;
          }

          const files = await listRes.json();

          // Ensure bucket exists on target
          await fetch(`${target.supabase_url}/storage/v1/bucket`, {
            method: 'POST',
            headers: {
              apikey: target.supabase_service_role_key,
              Authorization: `Bearer ${target.supabase_service_role_key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ id: bucketName, name: bucketName, public: false }),
          });

          for (const file of files) {
            if (file.id === null) continue;

            try {
              const dlRes = await fetch(
                `${source.supabase_url}/storage/v1/object/${bucketName}/${file.name}`,
                {
                  headers: {
                    apikey: source.supabase_service_role_key,
                    Authorization: `Bearer ${source.supabase_service_role_key}`,
                  },
                }
              );

              if (!dlRes.ok) continue;
              const blob = await dlRes.blob();
              const formData = new FormData();
              formData.append('', blob, file.name);

              await fetch(
                `${target.supabase_url}/storage/v1/object/${bucketName}/${file.name}`,
                {
                  method: 'POST',
                  headers: {
                    apikey: target.supabase_service_role_key,
                    Authorization: `Bearer ${target.supabase_service_role_key}`,
                    'x-upsert': 'true',
                  },
                  body: formData,
                }
              );

              totalFiles++;
            } catch {
              addLog('warn', `Failed to sync file ${file.name}`);
            }
          }

          addLog('success', `Completed bucket ${bucketName}: ${files.length} files`);
        }

        await localSupabase
          .from('environment_sync_operations')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            rows_processed: totalProcessed,
            rows_inserted: totalInserted,
            rows_skipped: totalSkipped,
            files_synced: totalFiles,
            log,
          })
          .eq('id', syncOp.id);
      } catch (err: any) {
        addLog('error', err.message);
        await localSupabase
          .from('environment_sync_operations')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: err.message,
            rows_processed: totalProcessed,
            rows_inserted: totalInserted,
            rows_skipped: totalSkipped,
            files_synced: totalFiles,
            log,
          })
          .eq('id', syncOp.id);
      }
    } catch (err: any) {
      console.error('[environments] Sync error:', err);
      return res.status(500).json({ error: err.message || 'Sync failed' });
    }
  });

  // =========================================================================
  // UTILITIES
  // =========================================================================

  /**
   * GET /api/environments/sync/:operationId
   */
  app.get('/api/environments/sync/:operationId', async (req: Request, res: Response) => {
    try {
      const supabase = await getLocalSupabase();
      const { data, error } = await supabase
        .from('environment_sync_operations')
        .select('*')
        .eq('id', req.params.operationId)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Operation not found' });
      }

      return res.json({ operation: data });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/environments/test-connection
   */
  app.post('/api/environments/test-connection', async (req: Request, res: Response) => {
    try {
      const { environmentId } = req.body;
      const env = await fetchEnvironment(environmentId);
      const localSupabase = await getLocalSupabase();

      const response = await fetch(`${env.supabase_url}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: env.supabase_anon_key || '' },
        signal: AbortSignal.timeout(10000),
      });

      const connected = response.ok;
      await localSupabase
        .from('environments')
        .update({
          status: connected ? 'active' : 'unreachable',
          last_connected_at: connected ? new Date().toISOString() : undefined,
        })
        .eq('id', environmentId);

      return res.json({ connected, status: connected ? 'active' : 'unreachable' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message, connected: false });
    }
  });

  // =========================================================================
  // BACKUP / RESTORE — Export & import all tables as a zip file
  // =========================================================================

  /**
   * Ordered table list for backup/restore. Parents before children to
   * respect foreign key constraints on import.
   */
  const BACKUP_TABLES = [
    // Independent / root tables
    'app_settings',
    'platform_settings',
    'admin_profiles',
    'admin_permission_groups',
    'categories',
    'topics',
    'speakers',
    'sponsors',
    'calendars',
    'customers',
    'email_templates',

    // Tables that depend on root tables
    'admin_permissions',
    'events',
    'accounts',
    'people',

    // Junction tables and children of events
    'event_speakers',
    'event_categories',
    'event_topics',
    'calendar_events',
    'account_users',
    'event_registrations',
    'event_agenda_tracks',
    'event_media',
    'event_sponsors',
    'discount_codes',
    'event_budget_items',
    'event_communication_settings',

    // Tables that depend on the above
    'event_agenda_entries',
    'event_attendance',
    'event_interest',
    'event_talks',
    'email_logs',
    'email_batch_jobs',
    'ad_tracking_sessions',
    'event_competitions',

    // Deep children
    'event_agenda_entry_speakers',
    'event_attendee_matches',
    'conversion_events_log',
    'competition_entries',

    // Deepest children
    'competition_winners',

    // Scrapers (independent)
    'scrapers',
  ] as const;

  /**
   * Generated columns that Postgres won't allow us to insert.
   * Map of table name -> column names to strip.
   */
  const GENERATED_COLUMNS: Record<string, string[]> = {
    customers: ['full_name'],
  };

  /**
   * Maps tables to the column used for "delete all" filtering.
   * Default is 'id'.
   */
  const DELETE_KEY_MAP: Record<string, string> = {
    app_settings: 'key',
    platform_settings: 'key',
    event_speakers: 'event_id',
    event_categories: 'event_id',
    event_topics: 'event_id',
    calendar_events: 'event_id',
    event_agenda_entry_speakers: 'agenda_entry_id',
    account_users: 'account_id',
    admin_permissions: 'group_id',
  };

  /**
   * Fetch all rows from a table via the Supabase REST API with pagination.
   */
  async function fetchAllRows(
    supabaseUrl: string,
    serviceRoleKey: string,
    table: string,
  ): Promise<any[]> {
    const PAGE_SIZE = 1000;
    const allRows: any[] = [];
    let offset = 0;

    while (true) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/${table}?select=*&offset=${offset}&limit=${PAGE_SIZE}`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: 'count=exact',
          },
        }
      );

      if (!res.ok) break;

      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;

      allRows.push(...rows);
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return allRows;
  }

  /**
   * GET /api/environments/backup
   *
   * Export all database tables as a gzipped JSON file (.json.gz).
   * The file contains a single JSON object with a manifest and a
   * "tables" map of table_name → row_array.
   */
  app.get('/api/environments/backup', async (_req: Request, res: Response) => {
    try {
      const { url, key } = getLocalSupabaseCredentials();
      if (!url || !key) {
        return res.status(500).json({ error: 'Missing Supabase credentials' });
      }

      // Discover which tables actually exist
      const schemaRes = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });

      let availableTables: string[] = [];
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        availableTables = schema?.paths
          ? Object.keys(schema.paths)
              .map((p: string) => p.replace('/', ''))
              .filter((t: string) => t && !t.startsWith('rpc/'))
          : [];
      }

      // Only backup tables that exist in the database
      const tablesToBackup = BACKUP_TABLES.filter((t) => availableTables.includes(t));
      // Also include any tables that exist but aren't in BACKUP_TABLES
      const extraTables = availableTables
        .filter((t) => !BACKUP_TABLES.includes(t as any))
        .filter((t) => !['environments', 'environment_sync_profiles', 'environment_sync_operations', 'gatewaze_migrations'].includes(t))
        .sort();

      const allTables = [...tablesToBackup, ...extraTables];

      const backup: {
        version: string;
        created_at: string;
        table_order: string[];
        tables: Record<string, any[]>;
      } = {
        version: '1.0',
        created_at: new Date().toISOString(),
        table_order: [],
        tables: {},
      };

      for (const table of allTables) {
        try {
          const rows = await fetchAllRows(url, key, table);
          backup.tables[table] = rows;
          backup.table_order.push(table);
          console.log(`[environments:backup] ${table}: ${rows.length} rows`);
        } catch (err) {
          console.warn(`[environments:backup] Error reading ${table}:`, err);
        }
      }

      // Gzip the JSON
      const { gzipSync } = await import('zlib');
      const jsonBuffer = Buffer.from(JSON.stringify(backup));
      const gzipped = gzipSync(jsonBuffer);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="gatewaze-backup-${timestamp}.json.gz"`);
      res.setHeader('Content-Length', gzipped.length);
      res.send(gzipped);
    } catch (err: any) {
      console.error('[environments:backup] Error:', err);
      return res.status(500).json({ error: err.message || 'Backup failed' });
    }
  });

  /**
   * POST /api/environments/restore
   *
   * Import a backup .json.gz file. Expects the raw gzipped file as the
   * request body (Content-Type: application/gzip or application/octet-stream).
   *
   * Query params:
   *   - clearExisting=true (default) — delete existing rows before import
   */
  app.post('/api/environments/restore', async (req: Request, res: Response) => {
    try {
      const { url, key } = getLocalSupabaseCredentials();
      if (!url || !key) {
        return res.status(500).json({ error: 'Missing Supabase credentials' });
      }

      // Collect raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);

      if (body.length === 0) {
        return res.status(400).json({ error: 'No backup data provided.' });
      }

      // Decompress
      const { gunzipSync } = await import('zlib');
      let backup: any;
      try {
        const jsonBuffer = gunzipSync(body);
        backup = JSON.parse(jsonBuffer.toString('utf-8'));
      } catch {
        return res.status(400).json({ error: 'Invalid backup file. Expected a .json.gz file.' });
      }

      if (!backup.tables || !backup.version) {
        return res.status(400).json({ error: 'Invalid backup format: missing tables or version.' });
      }

      const clearExisting = req.query.clearExisting !== 'false';

      // Build ordered list: known BACKUP_TABLES first (in order), then extras
      const tableNames = backup.table_order ?? Object.keys(backup.tables);
      const orderedTables: string[] = [];
      for (const t of BACKUP_TABLES) {
        if (tableNames.includes(t)) orderedTables.push(t);
      }
      for (const t of tableNames) {
        if (!orderedTables.includes(t)) orderedTables.push(t);
      }

      const results: Array<{ table: string; rows: number; status: string; error?: string }> = [];

      // Clear existing data in reverse order (children first)
      if (clearExisting) {
        const reverseOrder = [...orderedTables].reverse();
        for (const table of reverseOrder) {
          try {
            const deleteColumn = DELETE_KEY_MAP[table] ?? 'id';
            const nilValue = deleteColumn === 'key' ? ''
              : table === 'scrapers' ? -1
              : '00000000-0000-0000-0000-000000000000';

            await fetch(
              `${url}/rest/v1/${table}?${deleteColumn}=neq.${nilValue}`,
              {
                method: 'DELETE',
                headers: {
                  apikey: key,
                  Authorization: `Bearer ${key}`,
                  Prefer: 'return=minimal',
                },
              }
            );
          } catch {
            // Table might not exist — that's fine
          }
        }
      }

      // Insert data in FK-safe order
      for (const table of orderedTables) {
        const rows = backup.tables[table];
        if (!Array.isArray(rows) || rows.length === 0) {
          results.push({ table, rows: 0, status: 'skipped' });
          continue;
        }

        try {
          const generatedCols = GENERATED_COLUMNS[table];
          const BATCH_SIZE = 500;
          let inserted = 0;

          for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            let batch = rows.slice(i, i + BATCH_SIZE);

            // Strip generated columns
            if (generatedCols) {
              batch = batch.map((row: any) => {
                const clean = { ...row };
                for (const col of generatedCols) delete clean[col];
                return clean;
              });
            }

            // Try insert first, fall back to upsert
            const insertRes = await fetch(`${url}/rest/v1/${table}`, {
              method: 'POST',
              headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify(batch),
            });

            if (insertRes.ok) {
              inserted += batch.length;
            } else {
              // Try upsert
              const upsertRes = await fetch(`${url}/rest/v1/${table}`, {
                method: 'POST',
                headers: {
                  apikey: key,
                  Authorization: `Bearer ${key}`,
                  'Content-Type': 'application/json',
                  Prefer: 'resolution=merge-duplicates,return=minimal',
                },
                body: JSON.stringify(batch),
              });

              if (upsertRes.ok) {
                inserted += batch.length;
              } else {
                const errText = await upsertRes.text();
                throw new Error(`Batch at row ${i}: ${errText}`);
              }
            }
          }

          results.push({ table, rows: inserted, status: 'ok' });
        } catch (err: any) {
          results.push({ table, rows: 0, status: 'error', error: err.message });
        }
      }

      return res.json({
        success: true,
        backup_version: backup.version,
        backup_created_at: backup.created_at,
        tables_restored: results.filter((r) => r.status === 'ok').length,
        tables_skipped: results.filter((r) => r.status === 'skipped').length,
        tables_errored: results.filter((r) => r.status === 'error').length,
        details: results,
      });
    } catch (err: any) {
      console.error('[environments:restore] Error:', err);
      return res.status(500).json({ error: err.message || 'Restore failed' });
    }
  });

  /**
   * GET /api/environments/tables
   */
  app.get('/api/environments/tables', async (_req: Request, res: Response) => {
    try {
      const { url, key } = getLocalSupabaseCredentials();
      if (!url || !key) {
        return res.status(500).json({ error: 'Missing Supabase credentials' });
      }

      const response = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });

      if (!response.ok) {
        return res.status(500).json({ error: 'Failed to fetch schema' });
      }

      const schema = await response.json();
      const systemTables = [
        'installed_modules', 'module_migrations', 'module_sources',
        'platform_settings', 'environments', 'environment_sync_profiles',
        'environment_sync_operations',
      ];

      const tables = schema?.paths
        ? Object.keys(schema.paths)
            .map((p: string) => p.replace('/', ''))
            .filter((t: string) => t && !t.startsWith('rpc/') && !systemTables.includes(t))
            .sort()
        : [];

      return res.json({ tables });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });
}
