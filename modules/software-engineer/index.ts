/**
 * @gatewaze-modules/software-engineer — autonomous issue → PR engineering agent.
 *
 * Turns labelled GitHub issues into merged (or proposed) pull requests by running a
 * spec-first, adversarially-reviewed, security-gated pipeline as in-process Claude Code
 * (Agent SDK) sessions, inside isolated git worktrees of the target repo. The repo's own
 * CLAUDE.md / .claude/rules / skills drive behaviour — this module only orchestrates,
 * gates, persists, and surfaces the work.
 *
 * Multi-tenant: each brand (site_id) configures its own monitored repos and its own
 * GitHub + model credentials, and works on its own codebases. Admins watch any agent
 * live and intervene.
 *
 * Spec: gatewaze/docs/spec-software-engineer.md
 */

import type { GatewazeModule } from '@gatewaze/shared';

const softwareEngineerModule: GatewazeModule = {
  id: 'software-engineer',
  group: 'platform',
  type: 'feature',
  visibility: 'public',
  name: 'Software Engineer',
  description:
    'Autonomous engineering agent: labelled GitHub issues → spec → adversarial review → implement → verify → PR/merge, driven by in-process Claude Code sessions. Per-brand repos + credentials; live agent monitoring.',
  version: '0.1.0',

  features: ['software-engineer'],

  // No hard module deps. Credentials are self-managed (per-brand, AES-256-GCM via
  // @gatewaze/shared/modules), not the ai module's per-user provider tables.
  dependencies: [],

  migrations: [
    'migrations/001_software_engineer_init.sql',
    'migrations/002_commit_author.sql',
    'migrations/003_engineers_and_pr_lifecycle.sql',
    'migrations/004_projects_and_ephemeral_engineers.sql',
    'migrations/005_issues_repo_and_multirepo.sql',
    'migrations/006_mcp_config.sql',
  ],

  // Dedicated queue — NOT the shared `jobs` queue. Agent phases run in a separate
  // "SE runner" deployment (a specialist image with the Agent SDK + git + the pinned
  // CLAUDE_CONFIG_DIR, carrying ONLY software-engineer secrets). That runner consumes
  // this queue; the main worker sets WORKER_CONCURRENCY_SOFTWARE_ENGINEER_SOFTWARE_ENGINEER=0
  // so it never picks up SE jobs. See spec §7.5 / §17.
  //
  // attempts:1 — the pipeline does its OWN bounded, gated retries (state machine);
  // BullMQ must not blindly re-run a half-completed phase.
  // NOTE (revised): phases run on the SHARED `jobs` queue via workers[]. The API only registers
  // built-in queue producers (jobs/email/image) — it does NOT register module-owned queues — so a
  // module-owned queue can be consumed by the worker but NOT enqueued to from the API/webhook.
  // The dedicated-queue "SE runner pool" isolation (spec §7.5) is a follow-up that needs a
  // platform change (register module-queue producers on the API). For now, the shared queue works
  // end to end (this is what marketing-os etc. do).
  workers: [
    { name: 'software-engineer:intake', handler: './workers/intake.ts' },
    { name: 'software-engineer:spec', handler: './workers/spec.ts' },
    { name: 'software-engineer:review', handler: './workers/review.ts' },
    { name: 'software-engineer:implement', handler: './workers/implement.ts' },
    { name: 'software-engineer:verify', handler: './workers/verify.ts' },
    { name: 'software-engineer:pr', handler: './workers/pr.ts' },
    { name: 'software-engineer:merge', handler: './workers/merge.ts' },
    // PR-watch loop: revise addresses review feedback; pr-monitor reconciles the PR (merge/close →
    // archive, changes-requested → revise, approved → merge) on a cron + on webhook nudges.
    { name: 'software-engineer:revise', handler: './workers/revise.ts' },
    { name: 'software-engineer:pr-monitor', handler: './workers/pr-monitor.ts' },
    // reflect: fold what a run learned into the project's shared, durable memory (via the AI wiki).
    { name: 'software-engineer:reflect', handler: './workers/reflect.ts' },
  ],

  // Cron heartbeat that polls open PRs and reconciles them (the fallback where GitHub can't reach
  // the webhook, e.g. localhost). Idempotent; a 3-min cadence keeps merges/reviews reflected promptly.
  crons: [
    {
      name: 'software-engineer-pr-monitor',
      queue: 'jobs',
      schedule: { every: 3 * 60_000 },
      data: { kind: 'software-engineer:pr-monitor' },
    },
  ],

  // Mounts the GitHub webhook (JWT-exempt, HMAC-authenticated) + the admin API
  // (JWT + is_admin gated) under /api/modules/software-engineer.
  apiRoutes: async (app, ctx) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    await registerRoutes(app, ctx);
  },

  // URL-driven dashboard — the Setup page and each run get their own shareable URL
  // (/software-engineer, /software-engineer/setup, /software-engineer/runs/<id>). This needs BOTH
  // an index route (exact /software-engineer) AND a splat (sub-paths): moduleRoutes.tsx merges two
  // entries sharing the top segment into { index } + { path: '*' } children. A lone splat leaves the
  // index slot empty, so exact /software-engineer renders a blank <Outlet/>. Same component for both;
  // it reads useLocation to pick the active tab.
  adminRoutes: [
    {
      path: 'software-engineer',
      component: () => import('./admin/components/SoftwareEngineerTab'),
      requiredFeature: 'software-engineer',
      guard: 'none',
    },
    {
      path: 'software-engineer/*',
      component: () => import('./admin/components/SoftwareEngineerTab'),
      requiredFeature: 'software-engineer',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/software-engineer',
      label: 'Software Engineer',
      icon: 'CommandLine',
      requiredFeature: 'software-engineer',
      defaultSection: 'Engineering',
      defaultLocation: 'sidebar',
      order: 75,
    },
  ],

  // Deployment-level config only. Per-brand config (tokens, repos, budgets, autonomy)
  // lives in the module's own site_id-scoped tables (see migration 001), because
  // configSchema is global per deployment and cannot be keyed by brand.
  configSchema: {
    github_webhook_secret: {
      type: 'secret',
      label: 'GitHub webhook secret',
      description:
        'Shared secret used to verify X-Hub-Signature-256 on inbound GitHub webhook deliveries.',
    },
    default_per_run_token_ceiling: {
      type: 'number',
      label: 'Default per-run token ceiling',
      description: 'Hard cap on tokens for a single run before it is paused. Brands may override.',
    },
    default_per_run_wallclock_minutes: {
      type: 'number',
      label: 'Default per-run wall-clock (minutes)',
      description: 'Hard timeout for a single run before it is paused. Brands may override.',
    },
  },

  onInstall: async () => {},
  onEnable: async () => {},
  onDisable: async () => {},
};

export default softwareEngineerModule;
