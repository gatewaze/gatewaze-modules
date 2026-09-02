// @ts-nocheck — express + supabase-js types are resolved at module-host install time.
/**
 * send-testing-glockapps admin API.
 *
 * As with the core module, the platform does not gate dynamic module routes, so
 * requireJwt() + requireAdmin here are the only authentication. These endpoints
 * can write people rows (seed import) and spend against a paid API.
 */

import express from 'express';
import { requireJwt } from '../lib/require-jwt';
import { clientIp, rateLimit } from '../lib/rate-limit';
import { normaliseEmail } from '../lib/email';
import {
  GlockAppsAccessError,
  listProjects,
  loadConfig,
  serviceClient,
  startManualTest,
  targetListId,
} from '../lib/glockapps';

// Providers we accept in manual entry. An open string field here would end up
// with 'Gmail', 'gmail ', and 'google' as three separate rows.
const KNOWN_PROVIDERS = [
  'overall',
  'gmail',
  'outlook',
  'yahoo',
  'aol',
  'icloud',
  'gmx',
  'mail_ru',
  'zoho',
  'corporate',
  'other',
];

function fail(res: express.Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const userId = (req as express.Request & { userId?: string }).userId;
    if (!userId) return fail(res, 401, 'unauthenticated', 'Missing user context');
    const supabase = serviceClient();
    const { data } = await supabase
      .from('admin_profiles')
      .select('role, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    const ok =
      !!data && data.is_active && ['super_admin', 'admin', 'editor'].includes(data.role as string);
    if (!ok) return fail(res, 403, 'forbidden', 'Admin access required');
    return next();
  } catch (err) {
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Auth check failed');
  }
}

/**
 * Upsert seed addresses as people and subscribe them to the test list.
 *
 * Shared by the pasted-import route and the start-a-test flow, because in
 * Spamtest v2 creating a test IS how you learn the seed addresses.
 *
 * Seeds are real third-party service mailboxes, not natural persons.
 * contact_kind 'member' exists only to pass send gates; lawful basis is carried
 * by acquisition_source, and is_test keeps them out of the People dashboard
 * alongside the synthetic population.
 */
async function importSeedEmails(
  supabase: any,
  config: { seedListMode: 'shared' | 'separate' },
  emails: string[],
): Promise<number> {
  const unique = Array.from(new Set(emails.filter(Boolean)));
  if (unique.length === 0) return 0;
  const listId = targetListId(config as any);

  const rows = unique.map((email) => ({
    email,
    contact_kind: 'member',
    acquisition_source: 'send_testing_glockapps',
    attributes: { is_test: true, seed_provider: 'glockapps' },
  }));

  const { error: insertError } = await supabase
    .from('people')
    .upsert(rows, { onConflict: 'email', ignoreDuplicates: true });
  if (insertError) throw new Error(insertError.message);

  // Chunked: a 1000-item .in() serialises into a ~26KB request URL that
  // PostgREST rejects with 400.
  const people: { id: string; email: string }[] = [];
  const IN_CHUNK = 100;
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error: readError } = await supabase
      .from('people')
      .select('id, email')
      .in('email', unique.slice(i, i + IN_CHUNK));
    if (readError) throw new Error(readError.message);
    people.push(...(data ?? []));
  }

  const subs = people.map((person: any) => ({
    list_id: listId,
    person_id: person.id,
    email: person.email.toLowerCase(),
    subscribed: true,
    source: 'send_testing_glockapps',
  }));

  const { error: subError } = await supabase
    .from('list_subscriptions')
    .upsert(subs, { onConflict: 'list_id,email' });
  if (subError) throw new Error(subError.message);

  return subs.length;
}

export function registerRoutes(app: any, _ctx?: any): void {
  const router = express.Router();

  // Rate limit ahead of auth and body parsing, so an unauthenticated flood is
  // rejected before either does any work.
  router.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!rateLimit(`send-testing-glockapps:${clientIp(req)}`, 120, 60_000)) {
      return fail(res, 429, 'rate_limited', 'Too many requests');
    }
    return next();
  });

  router.use(express.json({ limit: '512kb' }));
  router.use(requireJwt());
  router.use(requireAdmin);

  // Seed import writes people rows and starting a test spends against a paid
  // third-party API, so both get a tighter budget than the read endpoints.
  const limitWrites = (name: string, max: number) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!rateLimit(`send-testing-glockapps:${name}:${clientIp(req)}`, max, 60_000)) {
        return fail(res, 429, 'rate_limited', 'Too many requests');
      }
      return next();
    };

  router.get('/status', async (_req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const listId = targetListId(config);

      const { count: seedCount } = await supabase
        .from('list_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('list_id', listId)
        .eq('subscribed', true)
        .neq('source', 'send_testing');

      // Verifying the key costs one cheap GET and no test credits, so the panel
      // can say "api mode" only when the API genuinely answers.
      let apiReachable: boolean | null = null;
      let projects: { id: string; name: string }[] = [];
      if (config.apiKey) {
        try {
          projects = await listProjects(config);
          apiReachable = true;
        } catch (err) {
          apiReachable = false;
          if (!(err instanceof GlockAppsAccessError)) {
            console.warn('[send-testing-glockapps] project list failed:', (err as Error).message);
          }
        }
      }

      return res.json({
        mode: config.apiKey && apiReachable ? 'api' : 'manual',
        api_key_set: Boolean(config.apiKey),
        api_reachable: apiReachable,
        project_id: config.projectId || projects[0]?.id || '',
        projects,
        seed_list_mode: config.seedListMode,
        list_id: listId,
        seed_count: seedCount ?? 0,
      });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Status failed');
    }
  });

  /**
   * Import seed addresses. API mode fetches the current list (they rotate);
   * manual mode accepts a pasted list. Both land as people rows marked is_test
   * so they stay out of the People dashboard.
   */
  router.post('/seeds/import', limitWrites('seed-import', 10), async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const listId = targetListId(config);

      let emails: string[] = [];
      const pasted = (req.body ?? {}).emails;

      if (Array.isArray(pasted) && pasted.length > 0) {
        emails = pasted
          .map((value: unknown) => normaliseEmail(value))
          .filter((email: string | null): email is string => email !== null);
      } else {
        // There is no standing seed list to fetch. In Spamtest v2 the seed
        // addresses belong to a test: POST manualTest returns them. Starting a
        // test from a run imports them as a side effect, so send the caller
        // there rather than silently importing nothing.
        return fail(
          res,
          400,
          'invalid_request',
          'Seed addresses come from a placement test. Start one from a run, or paste addresses here.',
        );
      }

      if (emails.length === 0) {
        return fail(res, 400, 'invalid_request', 'No valid seed addresses supplied');
      }
      // Bound the import: seed lists are ~70 addresses, so anything far larger
      // is a paste error, not a seed list.
      if (emails.length > 1000) {
        return fail(res, 400, 'invalid_request', 'Too many addresses for a seed list (max 1000)');
      }

      const importedCount = await importSeedEmails(supabase, config, emails);

      return res.json({ imported: importedCount, list_id: listId });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Seed import failed');
    }
  });

  /** Remove seed people. Kept separate from the core deprovision so refreshing
   *  seeds never disturbs the synthetic population. */
  router.delete('/seeds', limitWrites('seed-remove', 10), async (_req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const { data, error } = await supabase
        .from('people')
        .delete()
        .eq('acquisition_source', 'send_testing_glockapps')
        .select('id');
      if (error) throw new Error(error.message);
      return res.json({ deleted: (data ?? []).length });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Seed removal failed');
    }
  });

  router.get('/runs/:runId/placement', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const [{ data: reports }, { data: test }] = await Promise.all([
        supabase
          .from('send_test_placement_reports')
          .select('*')
          .eq('run_id', req.params.runId)
          .order('provider', { ascending: true }),
        supabase
          .from('send_test_placement_tests')
          .select('*')
          .eq('run_id', req.params.runId)
          .maybeSingle(),
      ]);
      const config = await loadConfig(supabase);
      return res.json({
        mode: config.apiKey ? 'api' : 'manual',
        reports: reports ?? [],
        test: test ?? null,
      });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Loading placement failed');
    }
  });

  /**
   * Start the GlockApps test backing a run.
   *
   * In Spamtest v2 this is also where the seed addresses come from: the create
   * call returns the addresses to send to plus a correlation code. We import
   * those addresses onto the test list so the next send reaches them, and hand
   * the code back for the operator to paste into the campaign — the module
   * cannot inject it, because it never sends.
   */
  router.post('/runs/:runId/placement/start', limitWrites('placement-start', 20), async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const runId = req.params.runId;

      const { data: run } = await supabase
        .from('send_test_runs')
        .select('id, name')
        .eq('id', runId)
        .maybeSingle();
      if (!run) return fail(res, 404, 'not_found', 'Run not found');

      // A manually-created test can be attached by id instead.
      const providedId = String((req.body ?? {}).glockapps_test_id ?? '').trim();
      let testId = providedId;
      let imported = 0;
      let insertHeader = '';
      let insertInBody = '';

      if (!testId) {
        try {
          const started = await startManualTest(config, { note: `Gatewaze run: ${run.name}` });
          testId = started.testId;
          insertHeader = started.insertHeader;
          insertInBody = started.insertInBody;
          imported = await importSeedEmails(supabase, config, started.emails);
        } catch (err) {
          if (err instanceof GlockAppsAccessError) {
            return fail(
              res,
              400,
              'manual_mode',
              `${err.message} Create the test in the GlockApps dashboard and paste its id here.`,
            );
          }
          throw err;
        }
      }

      const { data, error } = await supabase
        .from('send_test_placement_tests')
        .upsert(
          { run_id: runId, glockapps_test_id: testId, state: 'polling', last_error: null },
          { onConflict: 'run_id' },
        )
        .select()
        .single();
      if (error) throw new Error(error.message);

      return res.status(201).json({ ...data, seeds_imported: imported, insert_header: insertHeader, insert_in_body: insertInBody });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Starting test failed');
    }
  });

  /** Manual entry: the committed floor when API access is not available. */
  router.post('/runs/:runId/placement', limitWrites('placement-save', 60), async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const body = req.body ?? {};
      const provider = String(body.provider ?? '').trim().toLowerCase();

      if (!KNOWN_PROVIDERS.includes(provider)) {
        return fail(
          res,
          400,
          'invalid_request',
          `provider must be one of: ${KNOWN_PROVIDERS.join(', ')}`,
        );
      }

      const counts = ['inbox', 'tabs', 'spam', 'missing'].map((field) => {
        const n = Number(body[field] ?? 0);
        return Number.isInteger(n) && n >= 0 ? n : null;
      });
      if (counts.some((value) => value === null)) {
        return fail(res, 400, 'invalid_request', 'Counts must be non-negative whole numbers');
      }

      const { data: run } = await supabase
        .from('send_test_runs')
        .select('id')
        .eq('id', req.params.runId)
        .maybeSingle();
      if (!run) return fail(res, 404, 'not_found', 'Run not found');

      // Explicit allowlist rather than spreading req.body into the row.
      const { data, error } = await supabase
        .from('send_test_placement_reports')
        .upsert(
          {
            run_id: req.params.runId,
            provider,
            inbox: counts[0],
            tabs: counts[1],
            spam: counts[2],
            missing: counts[3],
            entered_via: 'manual',
            glockapps_test_id: body.glockapps_test_id ? String(body.glockapps_test_id) : null,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: 'run_id,provider' },
        )
        .select()
        .single();
      if (error) throw new Error(error.message);
      return res.status(201).json(data);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Saving placement failed');
    }
  });

  app.use('/api/admin/modules/send-testing-glockapps', router);
}

export default registerRoutes;
