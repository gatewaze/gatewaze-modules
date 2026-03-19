/**
 * API routes for the environments module.
 *
 * Handles:
 *  - Full provisioning of clean Supabase projects (schema + functions + content)
 *  - Content-only sync between environments (push/pull rows, files)
 *  - Connection testing and table discovery
 */

import type { Express, Request, Response } from 'express';
import { resolve, join } from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';

const PROJECT_ROOT = resolve(import.meta.dirname ?? __dirname, '../../../..');

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
 * Strategy:
 *  1. Try the exec_sql RPC (available after core migrations)
 *  2. Fall back to pg-meta /query endpoint (available on all Supabase projects)
 */
async function executeRemoteSQL(
  supabaseUrl: string,
  serviceRoleKey: string,
  sql: string,
): Promise<{ success: boolean; error?: string }> {
  // Try exec_sql RPC first (fastest, available after 00008_rpc_functions.sql)
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

  // Fallback: pg-meta query endpoint (available on all Supabase instances)
  // This endpoint is at the same base URL but on the pg-meta service
  const pgMetaUrl = supabaseUrl.replace('/rest/v1', '').replace(/\/$/, '');
  const queryRes = await fetch(`${pgMetaUrl}/pg/query`, {
    method: 'POST',
    headers: {
      'x-connection-encrypted': serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (queryRes.ok) return { success: true };

  // Second fallback: Supabase Management API (requires project ref extraction)
  // Extract project ref from URL: https://<ref>.supabase.co
  const refMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/);
  if (refMatch) {
    const projectRef = refMatch[1];
    // The management API needs a personal access token — try the service role key
    // as Authorization (works for self-hosted, may not for cloud without PAT)
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

    if (mgmtRes.ok) return { success: true };
  }

  const errText = await rpcRes.text().catch(() => 'Unknown error');
  return { success: false, error: `SQL execution failed: ${errText}` };
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
  const configImport = await import('../../../../gatewaze.config.js');
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

export function registerRoutes(app: Express) {

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
        // Step 1: Core migrations
        if (steps?.coreMigrations !== false) {
          addLog('info', 'Applying core database migrations...');
          const coreMigrations = loadCoreMigrations();

          for (const migration of coreMigrations) {
            addLog('info', `Applying ${migration.filename}...`);
            const result = await executeRemoteSQL(
              target.supabase_url,
              target.supabase_service_role_key,
              migration.sql,
            );

            if (!result.success) {
              addLog('error', `Failed to apply ${migration.filename}: ${result.error}`);
              // Continue — migrations are idempotent, some may fail due to ordering
              // but subsequent runs should succeed
            } else {
              addLog('success', `Applied ${migration.filename}`);
            }
          }

          addLog('success', `Core migrations complete (${coreMigrations.length} files)`);
        }

        // Step 2: Module migrations
        if (steps?.moduleMigrations !== false) {
          addLog('info', 'Applying module migrations...');
          const moduleMigrations = await loadModuleMigrations();

          for (const migration of moduleMigrations) {
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
            }
          }

          // Also reconcile the installed_modules table on the target
          // by inserting module records via the REST API
          addLog('info', 'Syncing module registry to target...');
          const { loadModules } = await import('@gatewaze/shared/modules');
          const configImport = await import('../../../../gatewaze.config.js');
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

          addLog('success', `Module migrations complete (${moduleMigrations.length} files, ${modules.length} modules registered)`);
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
   * GET /api/environments/provision/preview
   *
   * Preview what will be applied during provisioning.
   */
  app.get('/api/environments/provision/preview', async (_req: Request, res: Response) => {
    try {
      const coreMigrations = loadCoreMigrations().map((m) => m.filename);
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

      return res.json({
        coreMigrations,
        moduleMigrations: moduleMigrations.map((m) => ({
          moduleId: m.moduleId,
          moduleName: m.moduleName,
          filename: m.filename,
        })),
        edgeFunctions: edgeFunctions.map((f) => f.name),
        storageBuckets: buckets,
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
