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
import {
  GlockAppsAccessError,
  fetchSeedList,
  loadConfig,
  serviceClient,
  startTest,
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

export function registerRoutes(app: any, _ctx?: any): void {
  const router = express.Router();
  router.use(express.json({ limit: '512kb' }));
  router.use(requireJwt());
  router.use(requireAdmin);

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

      return res.json({
        mode: config.apiKey ? 'api' : 'manual',
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
  router.post('/seeds/import', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const listId = targetListId(config);

      let emails: string[] = [];
      const pasted = (req.body ?? {}).emails;

      if (Array.isArray(pasted) && pasted.length > 0) {
        emails = pasted
          .map((value: unknown) => String(value ?? '').trim().toLowerCase())
          .filter((email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));
      } else {
        try {
          const seeds = await fetchSeedList(config);
          emails = seeds.map((seed) => seed.email);
        } catch (err) {
          if (err instanceof GlockAppsAccessError) {
            return fail(
              res,
              400,
              'manual_mode',
              `${err.message} Paste the seed addresses from the GlockApps dashboard instead.`,
            );
          }
          throw err;
        }
      }

      if (emails.length === 0) {
        return fail(res, 400, 'invalid_request', 'No valid seed addresses supplied');
      }
      // Bound the import: seed lists are ~70 addresses, so anything far larger
      // is a paste error, not a seed list.
      if (emails.length > 1000) {
        return fail(res, 400, 'invalid_request', 'Too many addresses for a seed list (max 1000)');
      }

      const unique = Array.from(new Set(emails));

      // Seeds are real third-party service mailboxes, not natural persons.
      // contact_kind 'member' only exists to pass send gates; lawful basis is
      // carried by acquisition_source, and is_test keeps them out of the People
      // dashboard alongside the synthetic population.
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

      const { data: people, error: readError } = await supabase
        .from('people')
        .select('id, email')
        .in('email', unique);
      if (readError) throw new Error(readError.message);

      const subs = (people ?? []).map((person: any) => ({
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

      return res.json({ imported: subs.length, list_id: listId });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Seed import failed');
    }
  });

  /** Remove seed people. Kept separate from the core deprovision so refreshing
   *  seeds never disturbs the synthetic population. */
  router.delete('/seeds', async (_req: express.Request, res: express.Response) => {
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

  /** Start (or record) the GlockApps test backing a run. */
  router.post('/runs/:runId/placement/start', async (req: express.Request, res: express.Response) => {
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

      // A manually-created test can be attached by id; otherwise start one.
      let testId = String((req.body ?? {}).glockapps_test_id ?? '').trim();
      if (!testId) {
        try {
          const started = await startTest(config, { name: `Send test — ${run.name}` });
          testId = started.testId;
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
      return res.status(201).json(data);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Starting test failed');
    }
  });

  /** Manual entry: the committed floor when API access is not available. */
  router.post('/runs/:runId/placement', async (req: express.Request, res: express.Response) => {
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
