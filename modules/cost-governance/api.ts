import type { Express, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ModuleContext } from '@gatewaze/shared';

let _sb: ReturnType<typeof createClient> | null = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('[cost-governance] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

interface BudgetRow {
  brand_id: string;
  provider: string;
  period: 'daily' | 'monthly';
  soft_cap_usd: number;
  hard_cap_usd: number | null;
  notes: string | null;
  updated_at: string;
}

interface BudgetWriteBody {
  brand_id?: unknown;
  provider?: unknown;
  period?: unknown;
  soft_cap_usd?: unknown;
  hard_cap_usd?: unknown;
  notes?: unknown;
}

const BUDGET_WRITE_FIELDS = ['brand_id', 'provider', 'period', 'soft_cap_usd', 'hard_cap_usd', 'notes'] as const;

function pickBudgetFields(body: BudgetWriteBody): Partial<BudgetRow> {
  const out: Partial<BudgetRow> = {};
  for (const k of BUDGET_WRITE_FIELDS) {
    if (k in body) (out as Record<string, unknown>)[k] = body[k];
  }
  return out;
}

function isValidPeriod(v: unknown): v is 'daily' | 'monthly' {
  return v === 'daily' || v === 'monthly';
}

function nonEmptyString(v: unknown, max = 100): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isFiniteNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function registerRoutes(app: Express, _ctx?: ModuleContext) {
  app.get('/api/cost-governance/usage-summary', async (req: Request, res: Response) => {
    const windowDays = Math.max(
      1,
      Math.min(180, Number(req.query.window_days ?? 30)),
    );
    const groupBy = ['provider', 'feature', 'product'].includes(String(req.query.group_by ?? ''))
      ? String(req.query.group_by)
      : 'provider';

    const { data, error } = await sb().rpc('cost_summary', {
      p_window_days: windowDays,
      p_group_by: groupBy,
    });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ window_days: windowDays, group_by: groupBy, rows: data ?? [] });
  });

  app.get('/api/cost-governance/budgets', async (_req: Request, res: Response) => {
    const { data, error } = await sb()
      .from('external_api_budgets')
      .select('brand_id, provider, period, soft_cap_usd, hard_cap_usd, notes, updated_at')
      .order('brand_id')
      .order('provider')
      .order('period');
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ budgets: data ?? [] });
  });

  app.put('/api/cost-governance/budgets', async (req: Request, res: Response) => {
    const fields = pickBudgetFields((req.body ?? {}) as BudgetWriteBody);
    if (!nonEmptyString(fields.brand_id) || !nonEmptyString(fields.provider) || !isValidPeriod(fields.period)) {
      res.status(400).json({ error: 'brand_id, provider, period are required' });
      return;
    }
    if (!isFiniteNonNegativeNumber(fields.soft_cap_usd)) {
      res.status(400).json({ error: 'soft_cap_usd must be a non-negative number' });
      return;
    }
    if (
      fields.hard_cap_usd !== undefined &&
      fields.hard_cap_usd !== null &&
      !isFiniteNonNegativeNumber(fields.hard_cap_usd)
    ) {
      res.status(400).json({ error: 'hard_cap_usd must be a non-negative number or null' });
      return;
    }

    const { error } = await sb()
      .from('external_api_budgets')
      .upsert({
        brand_id: fields.brand_id,
        provider: fields.provider,
        period: fields.period,
        soft_cap_usd: fields.soft_cap_usd,
        hard_cap_usd: fields.hard_cap_usd ?? null,
        notes: typeof fields.notes === 'string' ? fields.notes : null,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(204).end();
  });

  app.get('/api/cost-governance/recent', async (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100)));
    const brandId = typeof req.query.brand_id === 'string' ? req.query.brand_id : undefined;

    let query = sb()
      .from('external_api_usage')
      .select('id, occurred_at, brand_id, provider, product, feature, units_in, units_out, cost_usd, request_id, context')
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (brandId) {
      query = query.eq('brand_id', brandId);
    }
    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ rows: data ?? [] });
  });
}
