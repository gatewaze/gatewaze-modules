import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Vehicle Video — Auto Trader listing → AI showcase video.
 *
 * Pipeline (three resumable jobs, two human gates):
 *   Entry     — list the dealer's live Auto Trader stock (retailerId); pick a vehicle
 *   Phase A   — vehicle-video:scrape-and-script  (ingest gallery + style + shot-plan script)
 *   GATE 1    — operator reviews style + shot plan (text, no spend), approves
 *   Phase B   — vehicle-video:generate-clip      (ONE shot → Veo clip; per-shot approve/regen)
 *   GATE 2    — operator approves each clip
 *   Phase C   — vehicle-video:finalize           (voiceover → Gemini TTS + ffmpeg compose → MP4)
 *
 * The AI steps run through the `ai` module's recipe runner against recipes/skills
 * in the `danthebaker/agents` source; the module owns the media-API calls (Veo,
 * Gemini TTS, ffmpeg) — the same split `daily-briefing` uses.
 *
 * Spec: gatewaze-environments/specs/spec-vehicle-video-module.md
 */
const vehicleVideoModule: GatewazeModule = {
  id: 'vehicle-video',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Vehicle Video',
  description:
    "Turns a dealer's Auto Trader vehicle listing into a short narrated AI showcase video: " +
    'lists live stock, curates a shot plan from the gallery, styles the video to the likely ' +
    'buyer, generates per-shot AI clips (Veo) with human approval, and composes a final MP4.',
  version: '0.1.0',
  features: ['vehicle-video', 'vehicle-video.manage'],

  // `ai` is required (recipe runner + cost/credential ledger). residential-egress is
  // soft (scrape/inventory degrade to a direct fetch when it is absent).
  dependencies: ['ai'],

  migrations: [
    'migrations/001_vehicle_video_init.sql',
    'migrations/002_seed_use_cases.sql',
    'migrations/003_seed_recipe_bindings.sql',
    'migrations/004_preview.sql',
    'migrations/005_fidelity.sql',
    'migrations/006_backdrop.sql',
  ],

  workers: [
    {
      // File stem MUST equal the job-name suffix: the prod worker derives the job
      // name from the handler filename as `${moduleId}:${stem}`.
      name: 'vehicle-video:scrape-and-script',
      handler: './workers/scrape-and-script.ts',
    },
    {
      name: 'vehicle-video:generate-clip',
      handler: './workers/generate-clip.ts',
    },
    {
      // Free (no-Veo) Ken Burns motion preview.
      name: 'vehicle-video:preview',
      handler: './workers/preview.ts',
    },
    {
      name: 'vehicle-video:finalize',
      handler: './workers/finalize.ts',
    },
    {
      // Promo-assembler: theme → Kling shots → fast-cut graded promo (current product).
      name: 'vehicle-video:generate-promo',
      handler: './workers/generate-promo.ts',
    },
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerRoutes(app as any, ctx as any);
  },

  adminRoutes: [
    {
      path: 'vehicle-video',
      component: () => import('./admin/components/VehicleVideoTab'),
      requiredFeature: 'vehicle-video',
      guard: 'none',
    },
    {
      path: 'vehicle-video/:id',
      component: () => import('./admin/components/VehicleVideoRunView'),
      requiredFeature: 'vehicle-video',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/vehicle-video',
      label: 'Vehicle Videos',
      icon: 'VideoCamera',
      requiredFeature: 'vehicle-video',
      defaultSection: 'Content',
      defaultLocation: 'sidebar',
      order: 64,
    },
  ],

  configSchema: {
    VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID: {
      key: 'VEHICLE_VIDEO_AUTOTRADER_RETAILER_ID',
      type: 'string',
      required: false,
      description:
        "The dealer's Auto Trader retailerId. Drives the live stock list shown when the " +
        'module opens (autotrader.co.uk/cars/retailer/stock?retailerId=<id>). Required for ' +
        'the inventory browser; paste-URL and photo-upload entries work without it.',
    },
    VEHICLE_VIDEO_MARKET: {
      key: 'VEHICLE_VIDEO_MARKET',
      type: 'string',
      required: false,
      description:
        "The dealer's selling market — country and, where known, region/character " +
        "(e.g. 'UK / Teesside, mixed urban-industrial'). Default market for the " +
        'psychographic style inference; operator-overridable per run.',
    },
    VEHICLE_VIDEO_VEO_MODEL: {
      key: 'VEHICLE_VIDEO_VEO_MODEL',
      type: 'select',
      required: false,
      default: 'fast',
      description: 'Google Veo model tier for clip generation.',
      options: [
        { label: 'Fast (cheaper)', value: 'fast' },
        { label: 'Standard (higher quality)', value: 'standard' },
      ],
    },
    VEHICLE_VIDEO_ALLOWED_HOSTS: {
      key: 'VEHICLE_VIDEO_ALLOWED_HOSTS',
      type: 'string',
      required: false,
      default: 'autotrader.co.uk,m.atcdn.co.uk',
      description:
        'Comma-separated SSRF host allowlist for ingest (listing + image hosts). Only these ' +
        'hosts (and subdomains) may be fetched. Defaults to Auto Trader + its image CDN.',
    },
    VEHICLE_VIDEO_SHOT_PLAN: {
      key: 'VEHICLE_VIDEO_SHOT_PLAN',
      type: 'string',
      required: false,
      description:
        'JSON default shot plan: [{ beat, what_to_show, priority:"required"|"optional" }]. ' +
        "When unset, the vehicle-video-script skill's built-in Default shot plan applies.",
    },
    VEHICLE_VIDEO_MAX_SHOTS: {
      key: 'VEHICLE_VIDEO_MAX_SHOTS',
      type: 'number',
      required: false,
      default: '8',
      min: 1,
      max: 12,
      description: 'Hard cap on OUTPUT clips per video (cost ceiling). Input images are uncapped.',
    },
    VEHICLE_VIDEO_MAX_UPLOADS: {
      key: 'VEHICLE_VIDEO_MAX_UPLOADS',
      type: 'number',
      required: false,
      default: '60',
      min: 1,
      max: 200,
      description: 'Max photos per manual upload (abuse bound; the AI curates the best).',
    },
    VEHICLE_VIDEO_VISION_MAX_IMAGES: {
      key: 'VEHICLE_VIDEO_VISION_MAX_IMAGES',
      type: 'number',
      required: false,
      default: '20',
      min: 4,
      max: 60,
      description:
        'Cap on images sent to the script/vision step after perceptual-dedup + shortlist ' +
        '(so the model never receives the full gallery).',
    },
    VEHICLE_VIDEO_MAX_REGENS: {
      key: 'VEHICLE_VIDEO_MAX_REGENS',
      type: 'number',
      required: false,
      default: '3',
      min: 0,
      max: 10,
      description: 'Max clip re-rolls per shot (cost ceiling).',
    },
    VEHICLE_VIDEO_MAX_COST_MICRO_USD: {
      key: 'VEHICLE_VIDEO_MAX_COST_MICRO_USD',
      type: 'number',
      required: false,
      description: 'Per-run Veo+TTS spend ceiling (micro-USD). Checked at Gate 1 and before each clip.',
    },
    VEHICLE_VIDEO_DAILY_COST_CAP_MICRO_USD: {
      key: 'VEHICLE_VIDEO_DAILY_COST_CAP_MICRO_USD',
      type: 'number',
      required: false,
      description: 'Trailing-24h Veo+TTS spend ceiling (micro-USD).',
    },
    VEHICLE_VIDEO_RESIDENTIAL_EGRESS: {
      key: 'VEHICLE_VIDEO_RESIDENTIAL_EGRESS',
      type: 'boolean',
      required: false,
      default: 'false',
      description:
        'Route Auto Trader fetches through a residential egress lease (recommended — Auto Trader ' +
        'blocks datacentre IPs). Degrades to a direct fetch when egress is unavailable.',
    },
    VEHICLE_VIDEO_CLIP_DELAY_MS: {
      key: 'VEHICLE_VIDEO_CLIP_DELAY_MS',
      type: 'number',
      required: false,
      default: '2000',
      description: 'Delay between sequential Veo submissions (Veo concurrency limits).',
    },
  },

  onInstall: async () => {
    console.log('[vehicle-video] Module installed');
  },
  onEnable: async () => {
    console.log('[vehicle-video] Module enabled');
  },
  onDisable: async () => {
    console.log('[vehicle-video] Module disabled');
  },
};

export default vehicleVideoModule;
