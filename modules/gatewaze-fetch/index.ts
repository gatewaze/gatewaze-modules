/**
 * gatewaze-fetch — external web-fetch product.
 *
 * Spec: gatewaze-environments/specs/spec-gatewaze-gw_fetch.md
 *
 * Wraps the internal scrapling-fetcher service in a per-tenant external
 * surface (REST + MCP) with quotas, domain governance, robots.txt
 * enforcement, audit logging, and an append-only billing ledger.
 *
 * The internal scrapers module continues to talk directly to
 * scrapling-fetcher with its shared token (per §2.5); this module never
 * sees that traffic.
 */

import type { GatewazeModule, ModuleRuntimeContext } from '@gatewaze/shared';
import { buildMcpContributions } from './mcp.js';

const gatewazeFetchModule: GatewazeModule = {
  id: 'gatewaze-fetch',
  group: 'platform',
  type: 'feature',
  visibility: 'hidden',
  name: 'Web Fetch',
  description:
    'External-facing web fetch and content extraction. Lets external AI agents fetch URLs via REST or MCP using a Gatewaze API key, with per-tenant quotas, domain governance, and robots.txt enforcement.',
  version: '1.0.0',

  // Disabled by default; enabled per environment by operators (§14.4 Phase A).
  features: ['gatewaze-fetch'],

  // Ordering against api-keys infrastructure is handled by the platform
  // module loader treating api_keys as a platform prerequisite.
  dependencies: [],

  // ----- Public API contribution (spec §3.1) -----------------------
  publicApiBasePath: '/fetch',

  publicApiScopes: [
    {
      action: 'read',
      description:
        'Fetch a URL (mode: fast). Default for most use cases.',
    },
    {
      action: 'stealth',
      description:
        'Fetch via StealthyFetcher (Cloudflare bypass). Higher cost.',
    },
    {
      action: 'browser',
      description:
        'Fetch via DynamicFetcher with JS rendering. Highest cost; counts against browser-minutes quota.',
    },
    {
      action: 'screenshot',
      description: 'Capture page screenshot. Implies browser mode.',
    },
    {
      action: 'extract',
      description:
        'Run HTML→markdown / structured-data extraction on fetched content.',
    },
    {
      action: 'ignore-robots',
      description:
        'Bypass robots.txt enforcement. Requires operator approval per key; logged separately.',
    },
  ],

  publicApiRoutes: async (router, ctx) => {
    const { registerPublicApiRoutes } = await import('./publicApi.js');
    await registerPublicApiRoutes(router, ctx);
  },

  // ----- MCP contributions (spec §6) -------------------------------
  mcpContributions: (ctx: ModuleRuntimeContext) => buildMcpContributions(ctx),

  // ----- Schema migrations (spec §11) ------------------------------
  migrations: [
    'migrations/001_quotas.sql',
    'migrations/002_domain_rules.sql',
    'migrations/003_audit_log.sql',
    'migrations/004_robots_cache.sql',
    'migrations/005_usage_ledger.sql',
    'migrations/006_debit_function.sql',
    'migrations/007_stuck_started_recovery.sql',
  ],

  // ----- Settings (spec §3.1) --------------------------------------
  // configSchema is the operator-facing form definition (each entry
  // becomes a settings UI field). The platform's strict ConfigField
  // type only supports string/number/boolean/secret/select primitives;
  // our richer settings (arrays, finer numeric semantics) are read at
  // runtime from `ctx.moduleConfig` via `lib/settings.ts::resolveSettings`,
  // which fills in defaults. v1 ships with form-exposed settings limited
  // to the few primitives operators most often tune; everything else is
  // configured via env var or direct moduleConfig JSON edit.
  configSchema: {
    default_quota_requests_per_month: {
      key: 'default_quota_requests_per_month',
      type: 'number',
      required: false,
      default: '10000',
      description: 'Default monthly request count limit per API key.',
      min: 0,
    },
    default_quota_browser_minutes_per_month: {
      key: 'default_quota_browser_minutes_per_month',
      type: 'number',
      required: false,
      default: '60',
      description: 'Default monthly browser-mode minutes limit per API key.',
      min: 0,
    },
    default_quota_proxy_gb_per_month: {
      key: 'default_quota_proxy_gb_per_month',
      type: 'number',
      required: false,
      default: '5',
      description: 'Default monthly proxy bandwidth limit per API key (decimal GB; 1 GB = 10^9 bytes).',
      min: 0,
    },
    robots_cache_ttl_hours: {
      key: 'robots_cache_ttl_hours',
      type: 'number',
      required: false,
      default: '24',
      description: 'How long parsed robots.txt entries are cached (hours).',
      min: 1,
    },
    robots_strict_on_5xx: {
      key: 'robots_strict_on_5xx',
      type: 'boolean',
      required: false,
      default: 'false',
      description: 'When true, deny fetches whose robots.txt returned 5xx; default permissive.',
    },
    idempotency_ttl_seconds: {
      key: 'idempotency_ttl_seconds',
      type: 'number',
      required: false,
      default: '300',
      description: 'Idempotency-Key replay window (seconds).',
      min: 0,
    },
  },

  // ----- Admin UI (spec §3.1 + §5/§9 admin pages) ------------------
  adminRoutes: [
    {
      path: 'fetch/keys',
      component: () => import('./admin/pages/FetchKeyConfigDrawer'),
      requiredFeature: 'gatewaze-fetch',
      guard: 'admin',
    },
    {
      path: 'fetch/usage',
      component: () => import('./admin/pages/FetchUsagePage'),
      requiredFeature: 'gatewaze-fetch',
      guard: 'admin',
    },
    {
      path: 'fetch/audit',
      component: () => import('./admin/pages/FetchAuditLogPage'),
      requiredFeature: 'gatewaze-fetch',
      guard: 'admin',
    },
    {
      path: 'fetch/domain-rules',
      component: () => import('./admin/pages/FetchDomainRulesPage'),
      requiredFeature: 'gatewaze-fetch',
      guard: 'admin',
    },
  ],

  // Nav entry hidden until the Phase 3 chart lands — the current
  // FetchUsagePage.tsx is a stub placeholder. Routes stay registered
  // so deep links to /admin/fetch/usage et al. still resolve.
  adminNavItems: [],
};

export default gatewazeFetchModule;
