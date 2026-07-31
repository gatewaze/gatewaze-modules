import type { GatewazeModule } from '@gatewaze/shared';

/**
 * warehouse-sync — Supabase → data-warehouse relational replication.
 *
 * The mechanism is Airbyte (a central in-cluster install, one workspace per
 * brand — see docs/airbyte-deployment.md), so any Airbyte-supported destination
 * works; Snowflake is the first, and the warehouse-side artifacts below target
 * it. Implements spec-supabase-to-snowflake-pipeline.md. This module owns the
 * *Gatewaze/Supabase side* of the pipeline and carries the *warehouse-side*
 * artifacts as reviewed, version-controlled code:
 *
 *   • Source-side prerequisites (§10) — scoped publication + least-privilege
 *     replication / monitoring / verifier Postgres roles, shipped as guarded,
 *     idempotent migrations.
 *   • Replication-slot safety monitor (§10.4) — the single biggest prod risk.
 *     A cron-driven worker samples pg_replication_slots via a SECURITY DEFINER
 *     RPC, records retained-WAL / lag history to an OPERATIONS table, and
 *     raises alerts on the §10.4 thresholds.
 *   • Reconciliation (§12.3) — daily source-side row-count snapshots the
 *     warehouse tests compare STAGING against.
 *   • Warehouse artifacts (§6, §7, §9, §12) — Snowflake Terraform, OPERATIONS
 *     DDL + tombstone-purge task, STAGING transforms, and daily/weekly tests
 *     under ./snowflake, generated from the Appendix A manifest (./manifest).
 *   • Governance (§8) — the Appendix A table/column + PII inventory is the
 *     single source of truth; the SQL generator keeps publication, grants,
 *     STAGING models and masking policies in lockstep with it.
 *
 * Airbyte is the chosen mechanism (§5.1 Option B), but the SQL generator stays
 * swappable — a boolean-tombstone connector (e.g. Openflow) remains expressible
 * (see lib/sql-gen.ts RawMeta). The Supabase prerequisites (§10) are identical
 * across mechanisms.
 */
const warehouseSyncModule: GatewazeModule = {
  id: 'warehouse-sync',
  group: 'integrations',
  type: 'integration',
  visibility: 'public',
  name: 'Warehouse Sync',
  description:
    'Replicates a curated, governed subset of this brand\'s Supabase Postgres into a data warehouse (Snowflake, BigQuery, Redshift, …) via a central Airbyte, with replication-slot safety monitoring, PII masking, delete/erasure propagation, and reconciliation tests. Snowflake is the first destination.',
  version: '0.1.0',

  features: [
    'warehouse-sync',
    'warehouse-sync.health',
  ],

  // The pipeline reads the system-of-record tables directly; it does not take
  // an install-time dependency on the modules that own them (people/events/…).
  // Table scope is governed by the Appendix A manifest + the publication, not
  // by module wiring (§8.1).
  dependencies: [],

  migrations: [
    'migrations/001_operations.sql',
    'migrations/002_slot_health_rpc.sql',
    'migrations/003_source_prerequisites.sql',
    'migrations/004_health_views.sql',
    'migrations/005_airbyte_status.sql',
  ],

  // File stems MUST equal the job-name suffix — the platform worker derives the
  // job name as `${moduleId}:${stem}` (slot-monitor → warehouse-sync:slot-monitor).
  workers: [
    {
      name: 'warehouse-sync:slot-monitor',
      handler: './workers/slot-monitor.ts',
      concurrency: 1,
    },
    {
      name: 'warehouse-sync:reconcile',
      handler: './workers/reconcile.ts',
      concurrency: 1,
    },
    {
      // Option B: poll the central Airbyte for this brand's workspace.
      name: 'warehouse-sync:airbyte-status',
      handler: './workers/airbyte-status.ts',
      concurrency: 1,
    },
  ],

  crons: [
    {
      // §10.4 control #1: sample pg_replication_slots at least every 5 minutes.
      name: 'warehouse-sync-slot-monitor',
      queue: 'jobs',
      schedule: { pattern: '*/5 * * * *' },
      data: { kind: 'warehouse-sync:slot-monitor' },
    },
    {
      // §12.3 daily source-side row-count snapshot, written off-peak (03:17 UTC)
      // so the warehouse reconciliation test has a fresh baseline to diff.
      name: 'warehouse-sync-reconcile',
      queue: 'jobs',
      schedule: { pattern: '17 3 * * *', tz: 'UTC' },
      data: { kind: 'warehouse-sync:reconcile' },
    },
    {
      // Poll Airbyte sync state every 5 min so the dashboard reads a local table.
      name: 'warehouse-sync-airbyte-status',
      queue: 'jobs',
      schedule: { pattern: '*/5 * * * *' },
      data: { kind: 'warehouse-sync:airbyte-status' },
    },
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerRoutes(app as any, ctx as any);
  },

  adminRoutes: [
    {
      path: 'warehouse-sync',
      component: () => import('./admin/pages/health'),
      requiredFeature: 'warehouse-sync.health',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/warehouse-sync',
      label: 'Warehouse Sync',
      // Heroicon short name (export minus 'Icon'): CircleStackIcon → 'CircleStack'.
      icon: 'CircleStack',
      requiredFeature: 'warehouse-sync.health',
      defaultSection: 'Analytics',
      defaultLocation: 'sidebar',
      order: 80,
    },
  ],

  configSchema: {
    // ── Phase-0 mechanism pin (§5.1). Behaviour-neutral here; recorded so the
    //    generated Terraform/roles and the runbooks state the exact product. ──
    mechanism: {
      key: 'mechanism',
      type: 'select',
      required: false,
      default: 'openflow',
      label: 'Replication mechanism',
      description:
        'Phase-0 connector choice (§5). RAW semantics and delete-handling differ per mechanism; STAGING is the stable contract regardless.',
      default: 'airbyte',
      options: [
        { label: 'Airbyte OSS in-cluster (Option B, chosen)', value: 'airbyte' },
        { label: 'Snowflake Openflow (GA, Option A)', value: 'openflow' },
        { label: 'Self-hosted supabase/etl (Option B alt)', value: 'supabase-etl' },
        { label: 'Managed SaaS — Estuary/Fivetran (Option C)', value: 'managed-saas' },
        { label: 'Batch dump v0 — RAW_DUMP_V0 (Option E)', value: 'batch-dump' },
        { label: 'Supabase Pipelines (Option F, when Snowflake dest GA)', value: 'supabase-pipelines' },
      ],
    },
    // ── Airbyte control plane (Option B). One central Airbyte serves every
    //    brand; each brand points at the same URL but its OWN workspace. ──
    airbyteApiUrl: {
      key: 'airbyteApiUrl',
      type: 'string',
      required: false,
      label: 'Airbyte API base URL (in-cluster)',
      description:
        'Cluster-internal Airbyte server URL, e.g. http://airbyte-airbyte-server-svc.airbyte:8001. MUST be private (no public ingress) — the admin panel proxies it (§13 security).',
    },
    airbyteWorkspaceId: {
      key: 'airbyteWorkspaceId',
      type: 'string',
      required: false,
      label: 'Airbyte workspace ID (this brand)',
      description: 'The per-brand Airbyte workspace UUID. Scopes every API call so this brand only sees its own connections.',
    },
    airbyteApiToken: {
      key: 'airbyteApiToken',
      type: 'secret',
      required: false,
      label: 'Airbyte API token',
      description: 'Bearer token for the Airbyte public API (from the LF secret store). Blank when the in-cluster instance is unauthenticated behind network isolation.',
    },
    piiPosture: {
      key: 'piiPosture',
      type: 'select',
      required: false,
      default: 'pii-1',
      label: 'PII posture',
      description:
        'PII-1: plaintext in RAW, masked/hashed in STAGING (dynamic data masking). PII-2: no plaintext PII in Snowflake at all (§8.2).',
      options: [
        { label: 'PII-1 — mask in STAGING (recommended)', value: 'pii-1' },
        { label: 'PII-2 — no plaintext PII in Snowflake', value: 'pii-2' },
      ],
    },
    snowflakeDatabase: {
      key: 'snowflakeDatabase',
      type: 'string',
      required: false,
      default: 'AAIF',
      label: 'Snowflake database',
      description: 'Landing database name (§9.1). One per brand; AAIF is the first.',
      validationRegex: '^[A-Z][A-Z0-9_]*$',
    },
    replicationSlotName: {
      key: 'replicationSlotName',
      type: 'string',
      required: false,
      default: 'snowflake_cdc',
      label: 'Replication slot name',
      description:
        'The logical replication slot the connector owns. The slot-monitor watches this name; must match the publication/connector config (§10.1, §10.4).',
      validationRegex: '^[a-z_][a-z0-9_]*$',
    },
    // ── §10.4 alert thresholds (initial defaults; tune after week 1). ──
    retainedWalAlertGb: {
      key: 'retainedWalAlertGb',
      type: 'number',
      required: false,
      default: '10',
      label: 'Retained-WAL alert threshold (GB)',
      description: 'Raise an alert when a slot retains more than this much WAL (§10.4).',
      min: 1,
      max: 200,
    },
    lagAlertMinutes: {
      key: 'lagAlertMinutes',
      type: 'number',
      required: false,
      default: '30',
      label: 'Replication-lag alert threshold (minutes)',
      description: 'Raise an alert when consumer lag exceeds this (§10.4, SLA p95 ≤ 15 min).',
      min: 5,
      max: 240,
    },
    slotInactiveAlertMinutes: {
      key: 'slotInactiveAlertMinutes',
      type: 'number',
      required: false,
      default: '15',
      label: 'Slot-inactive alert threshold (minutes)',
      description: 'Raise an alert when the slot is inactive longer than this during business hours (§10.4).',
      min: 5,
      max: 120,
    },
    alertWebhookUrl: {
      key: 'alertWebhookUrl',
      type: 'secret',
      required: false,
      label: 'Alert webhook URL',
      description:
        'Optional. Slack/PagerDuty-compatible incoming webhook the slot-monitor POSTs threshold breaches to. Leave blank to record alerts to OPERATIONS only.',
    },
  },

  onInstall: async (ctx) => {
    ctx?.logger?.info?.('[warehouse-sync] installed — run migrations, then provision Snowflake via ./snowflake/terraform and confirm Phase-0 decisions (§14).');
  },
  onEnable: async (ctx) => {
    ctx?.logger?.info?.('[warehouse-sync] enabled — slot-monitor cron active (every 5 min). Source prerequisites (§10) apply the publication + scoped roles; the CDC connector itself is provisioned out-of-band per the chosen mechanism.');
  },
  onDisable: async (ctx) => {
    ctx?.logger?.warn?.('[warehouse-sync] disabled — slot-monitor stops. This does NOT drop the replication slot; follow the §14.6 decommission runbook to avoid the §10.4 WAL-disk hazard.');
  },
};

export default warehouseSyncModule;
