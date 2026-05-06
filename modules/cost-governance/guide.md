# Cost Governance

Universal cost ledger for paid external APIs (residential proxies, Anthropic, OpenAI). Every paid call gets attributed to a brand + feature, summed against per-brand budgets, and surfaced in `/admin/cost`. Hard-cap exceedance throws a typed `BudgetExceededError` so the calling feature can degrade gracefully instead of silently overspending.

## How It Works

The module ships three pieces:

1. **`external_api_usage` table** — per-call ledger. Cost is recorded *at call time* (not derived from a price sheet later) so historical rows reflect what was actually billed even after pricing drift.
2. **`external_api_budgets` table** — per `(brand_id × provider × period)` soft + hard caps.
3. **`record_external_api_usage(...)` RPC** — `SECURITY DEFINER`. Inserts one row, computes the new period total, returns budget status in one round-trip. Throws on hard-cap exceedance.

A small helper SDK in `@gatewaze/shared/cost` wraps Anthropic / OpenAI SDK calls so calling features don't need to think about the ledger:

```typescript
import { callAnthropic } from '@gatewaze/shared';

const result = await callAnthropic(
  supabase,
  { brand_id: 'example', feature: 'newsletter:summarise', model: 'claude-sonnet-4-6' },
  (anthropic) => anthropic.messages.create({ model: 'claude-sonnet-4-6', /* ... */ }),
  anthropicClient,
);
```

Token usage comes back via `result.usage`, the helper computes cost using `pricing.ts`'s per-model rates, and a row lands in `external_api_usage` before the call returns. If the brand has tripped its hard cap, `BudgetExceededError` throws *before* the next call — historical calls aren't blocked, but new ones are gated.

## Configuration

This module has no per-deployment config. Default budgets are seeded by the migration: $20/day soft, $100/day hard, per `(brand × *)` for the three known brands (example, demo, acme). Edit them at `/admin/cost` → Budgets tab.

## Features

- `cost-governance` — Ledger + RPC + helper SDK
- `cost-governance.admin` — `/admin/cost` page (Summary / Budgets / Recent calls)

## Dependencies

None. The module is a foundation other modules opt into; nothing requires it. Modules that want hard budget enforcement can declare `cost-governance` in their dependencies array; modules that don't will see best-effort ledger writes (no enforcement) when they call the helpers.

---

## Per-call attribution

Every row in `external_api_usage` carries:

| Column | Example | Why |
|---|---|---|
| `brand_id` | `example` | Cap spend per brand independently |
| `provider` | `anthropic` / `openai` / `rayobyte` / ... | One row per paid vendor |
| `product` | `claude-sonnet-4-6` / `gpt-4o` / `residential-proxy` | Per-model rates differ |
| `feature` | `scraper:speaker-extraction` / `newsletter:summarise` | Drill-down on `/admin/cost` |
| `units_in` / `units_out` | input + output tokens, or proxy bytes | Audit trail |
| `cost_usd` | `0.0210` | Pre-computed at call time |
| `request_id` | uuid | Correlate with logs |
| `context` | `{ event_id, scraper_id, ... }` | Ad-hoc per-feature info |

A 30-day partial-index keeps the most-recent rows hot for the dashboard. Older rows compact naturally; partitioning is a Phase 2 optimisation deferred until ~10 M rows.

## Per-brand budgets

The seeded defaults in production:

| Brand | Provider | Period | Soft cap | Hard cap |
|---|---|---|---|---|
| example | * | daily | $20.00 | $100.00 |
| demo | * | daily | $20.00 | $100.00 |
| acme | * | daily | $20.00 | $100.00 |

`provider = '*'` is the wildcard — applies to any provider not having a more-specific budget. To set a tighter cap on Anthropic specifically while leaving proxy spending uncapped, add a row with `provider = 'anthropic'`.

`/admin/cost` → **Budgets** tab edits these in place. Only super-admins can write (RLS enforced via `is_super_admin()`).

### What happens when a cap trips

| State | What the helper does | What the user sees |
|---|---|---|
| `budget_status = 'ok'` | Returns the API response. | Normal behaviour. |
| `budget_status = 'over_soft'` | Returns the API response + logs WARN. | A warning appears in `/admin/cost` activity log; no behaviour change. |
| `budget_status = 'over_hard'` | Throws `BudgetExceededError`. | Calling feature catches it and degrades — see "Caller behaviour" below. |

The first call that pushes spend *over* the hard cap still goes through (the budget is computed *after* insert). Subsequent calls within the period throw immediately.

### Caller behaviour on `BudgetExceededError`

Each consuming feature decides how to degrade:

| Feature | Behaviour |
|---|---|
| Scraper speaker-extraction | Re-queues the unfinished tail with `delay = retry_after_seconds`; per-event work resumes when the budget window resets. |
| Edge function (e.g. attendee-matching) | Returns HTTP `429` with `Retry-After: <retry_after_seconds>`. |
| Inline newsletter / sites AI calls | Aborts the user-facing operation with a friendly "AI usage limit reached" message + admin notification. |

The error carries:
```typescript
e.brand_id              // 'example'
e.provider              // 'anthropic'
e.period                // 'daily' | 'monthly'
e.hard_cap_usd          // 100.00
e.current_spend_usd     // 105.50
e.resets_at             // ISO-8601
e.retry_after_seconds   // convenience for HTTP 429 Retry-After
```

## Adopting the helper in a new feature

Three steps for a Node.js feature (admin / api / portal):

1. `import { callAnthropic, BudgetExceededError } from '@gatewaze/shared';`
2. Replace your direct `anthropic.messages.create(...)` with the wrapper:

   ```typescript
   try {
     const result = await callAnthropic(
       supabase,
       { brand_id, feature: '<my-module>:<verb>', model: 'claude-sonnet-4-6' },
       (a) => a.messages.create({ /* same args as before */ }),
       anthropicClient,
     );
     return result;
   } catch (err) {
     if (err instanceof BudgetExceededError) {
       // graceful degradation — skip / queue / return 429 / etc.
       return fallback;
     }
     throw err;
   }
   ```
3. (Optional) declare `cost-governance` in your module's `dependencies` if you want hard-cap enforcement. Without the dependency the helpers degrade to best-effort logging — useful during incremental rollout.

For Deno-runtime Edge functions:

```typescript
const { data, error } = await supabase.rpc('record_external_api_usage', {
  p_brand_id: 'example',
  p_provider: 'anthropic',
  p_product: 'claude-sonnet-4-6',
  p_feature: 'attendee-matching:generate',
  p_units_in: response.usage.input_tokens,
  p_units_out: response.usage.output_tokens,
  p_cost_usd: estimate(response.usage),
  p_context: { event_id, user_id },
});
if (data?.budget_status === 'over_hard') {
  return new Response(JSON.stringify({ error: 'budget_exceeded' }), {
    status: 429,
    headers: { 'Retry-After': String(data.retry_after_seconds) },
  });
}
```

## What's already adopted

| Feature | Provider | File | Status |
|---|---|---|---|
| `scraper:fetch` (proxy bandwidth) | rayobyte / brightdata / ... | scrapling-fetcher Python service | ✅ Live |
| `scraper:speaker-extraction` | Anthropic | luma-extractor.js (called from speaker-extract worker) | ✅ Live |
| `attendee-matching:generate` | Anthropic | events-generate-matches edge function | follow-up PR |
| `recipes:enrich` | Anthropic | recipes/api.ts | follow-up PR |
| `newsletter-gdoc-import:ai-mapper` | Anthropic | newsletters edge function | follow-up PR |
| `sites:ai-alt-text` | Anthropic + OpenAI | sites/lib/media/ai-alt-text.ts | follow-up PR |
| `events:generate-matches` | Anthropic | events edge function | follow-up PR |

Each unmigrated call site is one PR away from cost attribution — same wrapper pattern as in step 2 above. The migration order is driven by observed cost on `/admin/cost` (whichever feature spends the most goes first).

## Pricing tables

Per-model rates live in `packages/shared/src/cost/pricing.ts`. Updated manually when providers change pricing — find the entry for the model and bump `input_per_million` / `output_per_million`. The wrapper recomputes cost from the new rates on the *next* call; historical rows keep their original `cost_usd` (correct — they were billed at the old rate).

Currently tracked:
- Anthropic 4.x family: opus-4-7 / opus-4-6 / sonnet-4-6 / haiku-4-5
- Anthropic 3.x legacy: 3-5-sonnet-20241022 / 3-haiku-20240307
- OpenAI: gpt-5.2 / gpt-4o / gpt-4o-mini / gpt-4-turbo / o1 / o1-mini

Add a model: append to the relevant table → run `pnpm --filter @gatewaze/shared test` → ship.

## Security

- `external_api_usage` and `external_api_budgets` are RLS-protected. Read access requires `is_super_admin()`. Writes go through the `record_external_api_usage` RPC (`SECURITY DEFINER`) — service-role and Edge-function callers can write without direct table grants.
- Budget edits in `/admin/cost` use the platform's `*_WRITE_FIELDS` allowlist pattern — no mass-assignment via raw `req.body`.
- The `record_external_api_usage` RPC is `EXECUTE`-granted to `authenticated` and `service_role` only. Edge functions receive the user's JWT and inherit `authenticated`; the worker uses the service role.
