// @ts-nocheck — express + supabase-js types are resolved at module-host install time.
/**
 * send-testing admin API.
 *
 * The platform does NOT gate dynamic module routes — it only labels them — so
 * requireJwt() + requireAdmin below are the authentication for endpoints that
 * can create or delete tens of thousands of people rows and read recipient
 * addresses.
 *
 * They are not the only line of defence, deliberately: the provisioning RPCs
 * these routes call are granted to service_role alone and re-check the caller
 * themselves, so a bug here cannot be escalated into arbitrary writes on
 * public.people via PostgREST.
 */

import express from 'express';
import { requireJwt } from '../lib/require-jwt';
import {
  PROVISION_CHUNK_SIZE,
  SEND_TESTING_LIST_ID,
  assertInboundDomain,
  loadConfig,
  serviceClient,
} from '../lib/runtime';
import { computeRunResults } from '../lib/metrics';
import { parseSequence } from '../lib/identity';
import { csvCell } from '../lib/csv';

const PAGE_SIZE = 1000;

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

async function fetchAllPages(query: (from: number, to: number) => PromiseLike<any>): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

export function registerRoutes(app: any, ctx?: any): void {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.use(requireJwt());
  router.use(requireAdmin);

  // --- Setup / status --------------------------------------------------------
  router.get('/status', async (_req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);

      let population = 0;
      let domainConfigured = true;
      try {
        const domain = assertInboundDomain(config);
        const { data } = await supabase.rpc('send_test_population_count', { p_domain: domain });
        population = Number(data ?? 0);
      } catch {
        domainConfigured = false;
      }

      // Unsubscribed test people shrink the next run's audience, so surface the
      // count rather than letting expected_count quietly drop.
      const { count: unsubscribed } = await supabase
        .from('list_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('list_id', SEND_TESTING_LIST_ID)
        .eq('subscribed', false);

      const { data: job } = await supabase
        .from('send_test_provision_jobs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return res.json({
        domain_configured: domainConfigured,
        inbound_domain: config.inboundDomain,
        inbound_token_set: Boolean(config.inboundToken),
        inspectable_count: config.inspectableCount,
        default_population_size: config.defaultPopulationSize,
        postmaster_url: config.postmasterUrl,
        snds_url: config.sndsUrl,
        list_id: SEND_TESTING_LIST_ID,
        population,
        unsubscribed_count: unsubscribed ?? 0,
        job: job ?? null,
      });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Status failed');
    }
  });

  router.get('/provision/status', async (_req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      let current = 0;
      try {
        const domain = assertInboundDomain(config);
        const { data } = await supabase.rpc('send_test_population_count', { p_domain: domain });
        current = Number(data ?? 0);
      } catch {
        current = 0;
      }
      const { data: job } = await supabase
        .from('send_test_provision_jobs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return res.json({
        current_count: current,
        target_count: job?.target_count ?? null,
        job_state: job?.state ?? 'idle',
        processed: job?.processed ?? 0,
        last_error: job?.last_error ?? null,
        job_id: job?.id ?? null,
      });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Status failed');
    }
  });

  // --- Provisioning ----------------------------------------------------------
  async function startJob(
    res: express.Response,
    action: 'provision' | 'deprovision' | 'resubscribe',
    targetCount: number | null,
  ) {
    const supabase = serviceClient();
    const config = await loadConfig(supabase);
    // Fail closed: without a configured domain the RPCs have no guard to apply.
    assertInboundDomain(config);

    if (!ctx?.enqueueJob) {
      return fail(res, 503, 'enqueue_unavailable', 'Background jobs are not available on this host');
    }

    const { data: jobRow, error } = await supabase
      .from('send_test_provision_jobs')
      .insert({ action, target_count: targetCount, state: 'running' })
      .select()
      .single();

    if (error) {
      // The partial unique index on state='running' is what actually prevents
      // two chunked writers racing over the same population.
      if ((error as { code?: string }).code === '23505') {
        return fail(res, 409, 'conflict', 'A provisioning job is already running');
      }
      throw new Error(error.message);
    }

    const { id } = await ctx.enqueueJob('jobs', 'send-testing:provision', {
      kind: 'send-testing:provision',
      jobRowId: jobRow.id,
      action,
      targetCount,
    });

    return res.status(202).json({ job_id: jobRow.id, queue_job_id: id, action });
  }

  router.post('/provision', async (req: express.Request, res: express.Response) => {
    try {
      const target = Number((req.body ?? {}).target_count);
      if (!Number.isInteger(target) || target < 1) {
        return fail(res, 400, 'invalid_request', 'target_count must be a positive integer');
      }
      return await startJob(res, 'provision', target);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Provision failed');
    }
  });

  router.delete('/provision', async (req: express.Request, res: express.Response) => {
    try {
      const raw = (req.body ?? {}).target_count;
      // Omitted means "delete everything"; a number means shrink-to-count.
      const target = raw === undefined || raw === null ? null : Number(raw);
      if (target !== null && (!Number.isInteger(target) || target < 0)) {
        return fail(res, 400, 'invalid_request', 'target_count must be a non-negative integer when given');
      }
      return await startJob(res, 'deprovision', target);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Deprovision failed');
    }
  });

  router.post('/provision/resubscribe', async (_req: express.Request, res: express.Response) => {
    try {
      return await startJob(res, 'resubscribe', null);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Resubscribe failed');
    }
  });

  // --- Runs ------------------------------------------------------------------
  router.get('/runs', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const page = Math.max(Number(req.query.page ?? 0), 0);
      const pageSize = Math.min(Math.max(Number(req.query.page_size ?? 25), 1), 100);

      let query = supabase
        .from('send_test_runs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(page * pageSize, page * pageSize + pageSize - 1);

      const status = typeof req.query.status === 'string' ? req.query.status : null;
      if (status && ['open', 'closed', 'archived'].includes(status)) {
        query = query.eq('status', status);
      }

      const { data, error, count } = await query;
      if (error) throw new Error(error.message);

      // Arrival counts per run, so the list is useful without opening each one.
      const runs = await Promise.all(
        (data ?? []).map(async (run: any) => {
          const { count: arrivals } = await supabase
            .from('send_test_arrivals')
            .select('id', { count: 'exact', head: true })
            .eq('run_id', run.id);
          return { ...run, arrival_count: arrivals ?? 0 };
        }),
      );

      return res.json({ data: runs, total: count ?? 0, page, page_size: pageSize });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Listing runs failed');
    }
  });

  router.post('/runs', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const body = req.body ?? {};
      const name = String(body.name ?? '').trim();
      if (!name) return fail(res, 400, 'invalid_request', 'name is required');

      const config = await loadConfig(supabase);
      const domain = assertInboundDomain(config);

      // Snapshot the audience as it stands NOW. People provisioned later must
      // not change the denominator: it has to match what the send targeted.
      const { count: expected } = await supabase
        .from('list_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('list_id', SEND_TESTING_LIST_ID)
        .eq('subscribed', true)
        .like('email', `%@${domain}`);

      const { data, error } = await supabase
        .from('send_test_runs')
        .insert({
          name,
          send_source: body.send_source ? String(body.send_source) : null,
          send_ref: body.send_ref ? String(body.send_ref) : null,
          subject_filter: body.subject_filter ? String(body.subject_filter) : null,
          notes: body.notes ? String(body.notes) : null,
          expected_count: expected ?? 0,
          status: 'open',
        })
        .select()
        .single();

      if (error) {
        if ((error as { code?: string }).code === '23505') {
          return fail(res, 409, 'conflict', 'A run is already open. Close it before starting another.');
        }
        throw new Error(error.message);
      }
      return res.status(201).json(data);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Creating run failed');
    }
  });

  router.get('/runs/:id', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const { data: run, error } = await supabase
        .from('send_test_runs')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!run) return fail(res, 404, 'not_found', 'Run not found');

      const endedAt = run.closed_at ?? new Date().toISOString();

      // A closed run serves its materialised summary; an open one is computed
      // live so the operator can watch arrivals land.
      if (run.status !== 'open' && run.metadata?.results) {
        const { count: unattributed } = await supabase
          .from('send_test_arrivals')
          .select('id', { count: 'exact', head: true })
          .is('run_id', null)
          .gte('received_at', run.started_at)
          .lte('received_at', endedAt);
        return res.json({ ...run, results: run.metadata.results, unattributed_in_window: unattributed ?? 0 });
      }

      const arrivals = await fetchAllPages((from, to) =>
        supabase
          .from('send_test_arrivals')
          .select('recipient_email, received_at, headers_meta')
          .gte('received_at', run.started_at)
          .lte('received_at', endedAt)
          .order('received_at', { ascending: true })
          .range(from, to),
      );

      const sendLog = await fetchAllPages((from, to) =>
        supabase
          .from('email_send_log')
          .select('recipient_email, sent_at, status')
          .gte('created_at', run.started_at)
          .lte('created_at', endedAt)
          .like('recipient_email', 'st-%')
          .order('created_at', { ascending: true })
          .range(from, to),
      );

      const results = computeRunResults({
        arrivals,
        sendLog,
        expectedCount: run.expected_count ?? 0,
        startedAt: run.started_at,
        endedAt,
      });

      // "No sends detected": a broadcast whose category list does not intersect
      // the test list resolves to zero recipients and looks identical to a
      // pipeline that never ran. Say so instead of showing a silent 0%.
      const openMinutes = (Date.now() - Date.parse(run.started_at)) / 60000;
      const noSendsDetected = run.status === 'open' && openMinutes > 10 && sendLog.length === 0;

      return res.json({ ...run, results, no_sends_detected: noSendsDetected });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Loading run failed');
    }
  });

  router.patch('/runs/:id', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const body = req.body ?? {};
      const patch: Record<string, unknown> = {};

      if (body.status !== undefined) {
        const status = String(body.status);
        if (!['closed', 'archived'].includes(status)) {
          return fail(res, 400, 'invalid_request', 'status must be closed or archived');
        }
        patch.status = status;
        if (status === 'closed') patch.closed_at = new Date().toISOString();
      }
      if (body.notes !== undefined) patch.notes = String(body.notes);
      if (body.subject_filter !== undefined) {
        patch.subject_filter = body.subject_filter ? String(body.subject_filter) : null;
      }
      if (Object.keys(patch).length === 0) {
        return fail(res, 400, 'invalid_request', 'Nothing to update');
      }

      const { data, error } = await supabase
        .from('send_test_runs')
        .update(patch)
        .eq('id', req.params.id)
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return fail(res, 404, 'not_found', 'Run not found');

      if (patch.status === 'closed' && ctx?.enqueueJob) {
        await ctx.enqueueJob('jobs', 'send-testing:attribute', {
          kind: 'send-testing:attribute',
          runId: data.id,
        });
      }
      return res.json(data);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Updating run failed');
    }
  });

  router.post('/runs/:id/attribute', async (req: express.Request, res: express.Response) => {
    try {
      if (!ctx?.enqueueJob) {
        return fail(res, 503, 'enqueue_unavailable', 'Background jobs are not available on this host');
      }
      const supabase = serviceClient();
      const { data: run } = await supabase
        .from('send_test_runs')
        .select('id, status')
        .eq('id', req.params.id)
        .maybeSingle();
      if (!run) return fail(res, 404, 'not_found', 'Run not found');
      if (run.status === 'open') {
        return fail(res, 400, 'invalid_request', 'Close the run before attributing arrivals');
      }
      const { id } = await ctx.enqueueJob('jobs', 'send-testing:attribute', {
        kind: 'send-testing:attribute',
        runId: run.id,
      });
      return res.status(202).json({ queue_job_id: id });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Attribution failed');
    }
  });

  // --- People: CSV export and the inbox view ---------------------------------
  router.get('/people/export.csv', async (_req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const domain = assertInboundDomain(config);

      const subs = await fetchAllPages((from, to) =>
        supabase
          .from('list_subscriptions')
          .select('email')
          .eq('list_id', SEND_TESTING_LIST_ID)
          .eq('subscribed', true)
          .like('email', `%@${domain}`)
          .order('email', { ascending: true })
          .range(from, to),
      );

      const emails = subs.map((s: any) => s.email);
      const people = new Map<string, any>();
      for (let i = 0; i < emails.length; i += PAGE_SIZE) {
        const slice = emails.slice(i, i + PAGE_SIZE);
        const { data, error } = await supabase
          .from('people')
          .select('email, attributes')
          .in('email', slice);
        if (error) throw new Error(error.message);
        for (const person of data ?? []) people.set(person.email.toLowerCase(), person);
      }

      const lines = ['email,first_name,last_name,timezone,sequence'];
      for (const email of emails) {
        const person = people.get(email.toLowerCase());
        const attrs = (person?.attributes ?? {}) as Record<string, unknown>;
        lines.push(
          [
            csvCell(email),
            csvCell(attrs.first_name),
            csvCell(attrs.last_name),
            csvCell(attrs.timezone),
            csvCell(attrs.send_testing_sequence ?? parseSequence(email) ?? ''),
          ].join(','),
        );
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="send-test-list-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send(lines.join('\n'));
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Export failed');
    }
  });

  router.get('/people', async (_req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const domain = assertInboundDomain(config);

      // Only the inspectable sample is listed: they are the ones whose messages
      // can actually be opened.
      const { data, error } = await supabase
        .from('people')
        .select('email, attributes')
        .eq('acquisition_source', 'send_testing')
        .like('email', `%@${domain}`)
        .order('email', { ascending: true })
        .limit(Math.max(config.inspectableCount, 0));
      if (error) throw new Error(error.message);

      const { data: subs } = await supabase
        .from('list_subscriptions')
        .select('email, subscribed')
        .eq('list_id', SEND_TESTING_LIST_ID)
        .in('email', (data ?? []).map((p: any) => p.email));
      const subscribedBy = new Map((subs ?? []).map((s: any) => [s.email.toLowerCase(), s.subscribed]));

      return res.json({
        data: (data ?? []).map((person: any) => ({
          email: person.email,
          first_name: person.attributes?.first_name ?? null,
          last_name: person.attributes?.last_name ?? null,
          timezone: person.attributes?.timezone ?? null,
          sequence: person.attributes?.send_testing_sequence ?? parseSequence(person.email),
          subscribed: subscribedBy.get(person.email.toLowerCase()) ?? null,
        })),
        inspectable_count: config.inspectableCount,
      });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Listing people failed');
    }
  });

  router.get('/people/:email/arrivals', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const config = await loadConfig(supabase);
      const domain = assertInboundDomain(config);
      const email = String(req.params.email ?? '').trim().toLowerCase();

      // Confine the inbox view to this module's own addresses; it must not
      // become a way to read any person's mail.
      if (!email.endsWith(`@${domain}`) || parseSequence(email) === null) {
        return fail(res, 400, 'invalid_request', 'Not a send-testing address');
      }

      const { data, error } = await supabase
        .from('send_test_arrivals')
        .select('id, run_id, recipient_email, received_at, subject, headers_meta, body_html')
        .eq('recipient_email', email)
        .order('received_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);

      return res.json({
        data: (data ?? []).map((row: any) => ({
          ...row,
          // The list does not need bodies; only the opened message does.
          body_html: undefined,
          has_body: Boolean(row.body_html),
        })),
      });
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Loading inbox failed');
    }
  });

  router.get('/arrivals/:id', async (req: express.Request, res: express.Response) => {
    try {
      const supabase = serviceClient();
      const { data, error } = await supabase
        .from('send_test_arrivals')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return fail(res, 404, 'not_found', 'Arrival not found');
      return res.json(data);
    } catch (err) {
      return fail(res, 500, 'internal_error', err instanceof Error ? err.message : 'Loading message failed');
    }
  });

  app.use('/api/admin/modules/send-testing', router);
}

export default registerRoutes;
export { PROVISION_CHUNK_SIZE };
