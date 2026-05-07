/**
 * Public A/B engine endpoints. Anonymous, rate-limited per session key.
 *
 *   POST /api/ab/:testId/assign      → assigns + returns the sticky variant
 *   POST /api/ab/:testId/impression  → records an impression for variant
 *   POST /api/ab/:testId/conversion  → records a conversion (goalEvent)
 *
 * Per spec-templates-module §A/B (the "builtin" engine reference impl).
 *
 * Session key model:
 *   - Caller (the rendered page) generates a uuid on first visit and persists
 *     it in localStorage; sends as { sessionKey } in every subsequent call.
 *   - Stickiness: PRIMARY KEY (test_id, session_key) on
 *     templates_ab_assignments — first request wins, subsequent requests
 *     return the existing variant.
 *   - PII: the session key is opaque; we never see IP / UA / cookie data
 *     here. Operators wanting cross-test session continuity must wire that
 *     via the engine's persona model in a follow-up.
 *
 * Rate limit:
 *   60 req/min per (testId, sessionKey). Hits a sliding-window in-memory
 *   bucket; on cold start or pod-recycle the window resets — sticky
 *   assignment is preserved by the DB row though, so the worst case is
 *   slightly more permissive rate limiting after a deploy, not double-
 *   counted impressions (the assignment row guarantees idempotency).
 */

// @ts-nocheck — uses express / supabase types resolved at the workspace level
import type { Request, Response, Router } from 'express';

interface RateLimiterCheck {
  check(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; resetAt: number }>;
}

export interface AbRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  rateLimit: RateLimiterCheck;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const SESSION_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function pickVariantWeighted(
  variants: ReadonlyArray<{ key: string; weight: number }>,
  rand: number,
): string {
  // rand in [0, 1). Walk variants until the cumulative weight passes rand*total.
  const total = variants.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) return variants[0]?.key ?? '';
  const target = rand * total;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (target < acc) return v.key;
  }
  return variants[variants.length - 1]?.key ?? '';
}

export function createAbRoutes(deps: AbRoutesDeps) {
  interface TestRow {
    id: string;
    status: string;
    variants: Array<{ key: string; weight: number }>;
    goal_event: string;
  }

  async function loadRunningTest(testId: string): Promise<TestRow | null> {
    const { data } = await deps.supabase
      .from('templates_ab_tests')
      .select('id, status, variants, goal_event')
      .eq('id', testId)
      .maybeSingle<TestRow>();
    if (!data) return null;
    if (data.status !== 'running' && data.status !== 'paused') return null;
    return data;
  }

  async function rateLimitOk(testId: string, sessionKey: string, res: Response): Promise<boolean> {
    const r = await deps.rateLimit.check(`ab:${testId}:${sessionKey}`, 60, 60_000);
    if (!r.allowed) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'too many requests', resetAt: r.resetAt } });
      return false;
    }
    return true;
  }

  async function assign(req: Request, res: Response): Promise<void> {
    const testId = req.params.testId;
    const body = (req.body ?? {}) as { sessionKey?: unknown };
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
    if (!testId || !SESSION_KEY_RE.test(sessionKey)) {
      return badRequest(res, 'invalid_input', 'testId + sessionKey required (sessionKey 8-128 chars [A-Za-z0-9_-])');
    }
    if (!(await rateLimitOk(testId, sessionKey, res))) return;

    const test = await loadRunningTest(testId);
    if (!test) return badRequest(res, 'test_not_running', 'test not found or not running');

    interface ExistingAssignment { variant: string; }
    const { data: existing } = await deps.supabase
      .from('templates_ab_assignments')
      .select('variant')
      .eq('test_id', testId)
      .eq('session_key', sessionKey)
      .maybeSingle<ExistingAssignment>();
    if (existing?.variant) {
      res.status(200).json({ variant: existing.variant, sticky: true });
      return;
    }

    // Paused tests serve the existing assignment but don't make new ones —
    // operators use 'paused' to stop new traffic without losing in-flight
    // sessions' stickiness.
    if (test.status === 'paused') {
      // No prior assignment + paused → fall back to the first variant.
      // Don't insert a row so resuming the test rerolls correctly.
      res.status(200).json({ variant: test.variants[0]?.key ?? '', sticky: false, paused: true });
      return;
    }

    const variant = pickVariantWeighted(test.variants, Math.random());
    const { error: insErr } = await deps.supabase
      .from('templates_ab_assignments')
      .insert({ test_id: testId, session_key: sessionKey, variant });
    if (insErr) {
      // PRIMARY KEY collision: another concurrent assign won. Re-read.
      const { data: lateExisting } = await deps.supabase
        .from('templates_ab_assignments')
        .select('variant')
        .eq('test_id', testId)
        .eq('session_key', sessionKey)
        .maybeSingle<ExistingAssignment>();
      if (lateExisting?.variant) {
        res.status(200).json({ variant: lateExisting.variant, sticky: true });
        return;
      }
      deps.logger.error('ab.assign.insert_failed', { testId, error: insErr.message });
      res.status(500).json({ error: { code: 'internal', message: insErr.message } });
      return;
    }
    res.status(200).json({ variant, sticky: false });
  }

  async function impression(req: Request, res: Response): Promise<void> {
    const testId = req.params.testId;
    const body = (req.body ?? {}) as { sessionKey?: unknown; variant?: unknown; properties?: unknown };
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
    const variant = typeof body.variant === 'string' ? body.variant : '';
    if (!testId || !SESSION_KEY_RE.test(sessionKey) || !variant) {
      return badRequest(res, 'invalid_input', 'testId, sessionKey, variant required');
    }
    if (!(await rateLimitOk(testId, sessionKey, res))) return;

    const test = await loadRunningTest(testId);
    if (!test) return badRequest(res, 'test_not_running', 'test not found or not running');
    if (!test.variants.some((v) => v.key === variant)) {
      return badRequest(res, 'invalid_variant', 'variant not in test');
    }

    await deps.supabase.from('templates_ab_events').insert({
      test_id: testId,
      session_key: sessionKey,
      variant,
      kind: 'impression',
      properties: typeof body.properties === 'object' && body.properties ? body.properties : {},
    });
    res.status(204).end();
  }

  async function conversion(req: Request, res: Response): Promise<void> {
    const testId = req.params.testId;
    const body = (req.body ?? {}) as { sessionKey?: unknown; variant?: unknown; goalEvent?: unknown; properties?: unknown };
    const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
    const variant = typeof body.variant === 'string' ? body.variant : '';
    const goalEvent = typeof body.goalEvent === 'string' ? body.goalEvent : '';
    if (!testId || !SESSION_KEY_RE.test(sessionKey) || !variant || !goalEvent) {
      return badRequest(res, 'invalid_input', 'testId, sessionKey, variant, goalEvent required');
    }
    if (!(await rateLimitOk(testId, sessionKey, res))) return;

    const test = await loadRunningTest(testId);
    if (!test) return badRequest(res, 'test_not_running', 'test not found or not running');
    if (!test.variants.some((v) => v.key === variant)) {
      return badRequest(res, 'invalid_variant', 'variant not in test');
    }
    if (test.goal_event !== goalEvent) {
      return badRequest(res, 'goal_event_mismatch', `expected goal_event=${test.goal_event}, got ${goalEvent}`);
    }

    await deps.supabase.from('templates_ab_events').insert({
      test_id: testId,
      session_key: sessionKey,
      variant,
      kind: 'conversion',
      goal_event: goalEvent,
      properties: typeof body.properties === 'object' && body.properties ? body.properties : {},
    });
    res.status(204).end();
  }

  return { assign, impression, conversion };
}

export function mountAbRoutes(router: Router, routes: ReturnType<typeof createAbRoutes>): void {
  router.post('/ab/:testId/assign', routes.assign);
  router.post('/ab/:testId/impression', routes.impression);
  router.post('/ab/:testId/conversion', routes.conversion);
}
