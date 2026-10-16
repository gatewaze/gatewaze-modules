/**
 * editor-ai-copilot — AI copilot for the Puck-based canvas editor.
 *
 * Spec: gatewaze-environments/specs/spec-canvas-ai-copilot.md (v5)
 *
 * Adds a sidebar pane to the Puck editor (sites + newsletters)
 * that lets users generate or revise pages by prompting an LLM.
 * The AI is constrained to the target's template library; three
 * layers of defence in depth ensure no template deviation:
 *
 *   1. Constrained tool-use schema (provider layer)
 *   2. Per-block ajv re-validation (application layer)
 *   3. Per-string-field sanitisation (content layer)
 *
 * Plus the existing canvas-ops authority at save time = four
 * layers total.
 */

import type { GatewazeModule, ModuleRuntimeContext } from '@gatewaze/shared';

// The Puck plugin is NOT registered at admin boot. Canvas hosts load
// `admin/plugin.ts` with a dynamic import when an editor mounts (see
// sites/admin/components/canvas/puck/load-canvas-ai-plugins.ts). An
// eager import here, or an `admin/index.ts` (which the platform's Vite
// plugin imports at boot), would put the Puck editor into the boot
// bundle of every admin page (linuxfoundation/lfx-self-serve#3762).

const editorAiCopilotModule: GatewazeModule = {
  id: 'editor-ai-copilot',
  group: 'editor',
  type: 'feature',
  visibility: 'premium',
  name: 'Editor AI Copilot',
  description:
    'Generates and revises Puck-editor pages (sites + newsletter editions) from a natural-language prompt, optionally grounded in uploaded documents or public URLs. Strictly constrained to the brand\'s template library — designers control look & feel, marketing controls content.',
  version: '1.0.1',

  features: ['editor-ai-copilot'],

  // Both editor consumers must be installed. templates is the
  // schema authority for the AI's structured output.
  dependencies: ['sites', 'newsletters', 'templates'],

  // AI Skills admin surface — Skill Sources page under the module's
  // own admin nav, plus a per-host picker contributed via the platform
  // slot system into newsletters + sites detail pages.
  //
  // Dynamic-import specifiers are wrapped via `import.meta.glob` so
  // tsc doesn't trace into admin/* (excluded from this module's
  // tsconfig — admin code is type-checked by the consuming admin
  // package which has the right alias surface). Vite bundles each
  // glob match as a separate chunk same as a literal `import()`.
  // Route path note: with `guard: 'admin'` the platform mounts under
  // /admin/<path>, so `ai-skill-sources` ⇒ `/admin/ai-skill-sources`.
  //
  // We DELIBERATELY don't use 'modules/editor-ai-copilot/...' here
  // even though it would group nicely alongside the platform's own
  // `/admin/modules` page — that path is already taken by the
  // platform's built-in /admin/modules route which has its own
  // children. A second route with the same `modules` top segment
  // collides and either the platform's or ours wins silently. Using a
  // dedicated top-level segment avoids the conflict.
  // Phase-2 refactor: the Skill Sources page (formerly contributed
  // here via adminRoutes + 'ai-dashboard:tab' slot, with component
  // `./admin/pages/sources`) moved into the ai module — see
  // gatewaze-modules/ai/admin/components/AiSkillSourcesAdmin.tsx and
  // its built-in tab registration in AiDashboard.tsx. The newsletter
  // and site detail "AI Skills" picker slots stay here for now since
  // they're host-editor concerns; if the picker becomes more general
  // it can move too.
  adminRoutes: [],
  adminNavItems: [],
  adminSlots: [
    {
      slotName: 'newsletter-detail:settings',
      component: () => import('./admin/components/AiSkillsPicker'),
      order: 200,
      requiredFeature: 'editor-ai-copilot',
      meta: { label: 'AI Skills', icon: 'sparkles' },
    },
    {
      slotName: 'site-detail:settings',
      component: () => import('./admin/components/AiSkillsPicker'),
      order: 200,
      requiredFeature: 'editor-ai-copilot',
      meta: { label: 'AI Skills', icon: 'sparkles' },
    },
  ],

  // Migrations are picked up by applyModuleMigrations at enable time.
  migrations: [
    'migrations/001_canvas_ai_audit_log.sql',
    'migrations/002_canvas_ai_documents.sql',
    'migrations/003_ai_skills.sql',
    'migrations/004_canvas_ai_web_tools.sql',
    // 006_ai_skills_reference_image.sql was folded into the ai module's
    // 009_ai_skills.sql when the skills subsystem moved over in Phase 2.
    // Intentionally not listed here.
    // Per-host skill selection gains an "inherit the use-case default"
    // state (NULL) alongside explicit-none ('{}') and override ('{...}').
    'migrations/005_active_skill_ids_inherit.sql',
  ],

  // API routes mounted under /api/admin/modules/editor-ai-copilot/.
  // See api/register-routes.ts. The platform passes the full Express
  // app (not a Router) to this callback — register-routes builds its
  // own sub-router and `app.use(prefix, …)`s it on.
  apiRoutes: async (app: unknown, ctx: ModuleRuntimeContext) => {
    const { registerEditorAiCopilotRoutes } = await import('./api/register-routes.js');
    await registerEditorAiCopilotRoutes(app as never, ctx);
  },

  // Scheduled jobs — all run on the shared `jobs` queue.
  crons: [
    {
      // Multi-table TTL sweep: canvas_ai_documents (Phase F docs) +
      // ai_skill_source_webhook_log (AI Skills audit retention).
      name: 'editor-ai-copilot:sweep-expired-documents',
      queue: 'jobs',
      schedule: { pattern: '*/15 * * * *' },
      data: { kind: 'editor-ai-copilot.sweep-expired-documents' },
    },
    // Skill-sync cron moved to the ai module's crons in Phase 2.
  ],

  // Worker handler registry — the shared `jobs` worker dispatches each
  // job to its named handler. The two skill-sync handlers
  // (sync-skill-sources, sync-one-skill-source) moved to the ai module
  // in Phase 2; only sweep-expired-documents stays here.
  workers: [
    {
      name: 'editor-ai-copilot.sweep-expired-documents',
      handler: 'workers/sweep-expired-documents.js',
    },
  ],

  configSchema: {
    enabled: {
      key: 'enabled',
      type: 'boolean',
      label: 'Enabled',
      required: false,
      description:
        'When true, the sidebar AI pane is shown in the Puck editor for sites + newsletter editions. Requires at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY to be set on the API process.',
      default: 'true',
    },
    provider: {
      key: 'provider',
      type: 'select',
      label: 'Preferred LLM provider',
      required: false,
      description:
        '"anthropic" or "openai". When neither key is set, the feature is hard-disabled regardless of this value.',
      default: 'anthropic',
      options: [
        { label: 'Anthropic (Claude)', value: 'anthropic' },
        { label: 'OpenAI (GPT)', value: 'openai' },
      ],
    },
    perUserPerMin: {
      key: 'perUserPerMin',
      type: 'number',
      label: 'Generations per user per minute',
      required: false,
      description: 'Rate limit (in-memory, resets on API restart).',
      default: '10',
      min: 1,
      max: 1000,
    },
    perSitePerMin: {
      key: 'perSitePerMin',
      type: 'number',
      label: 'Generations per site per minute',
      required: false,
      description: 'Rate limit (in-memory, resets on API restart).',
      default: '30',
      min: 1,
      max: 10000,
    },
    perUserPerDay: {
      key: 'perUserPerDay',
      type: 'number',
      label: 'Generations per user per day',
      required: false,
      description:
        'Rate limit (persisted via canvas_ai_audit_log row counts; survives API restarts).',
      default: '100',
      min: 1,
      max: 100000,
    },
    maxDocsPerRequest: {
      key: 'maxDocsPerRequest',
      type: 'number',
      label: 'Max source documents per generation',
      required: false,
      description:
        'Phase F. Combined extracted text budget (all docs) is enforced separately at 50k tokens.',
      default: '5',
      min: 1,
      max: 20,
    },
  },
};

export default editorAiCopilotModule;
