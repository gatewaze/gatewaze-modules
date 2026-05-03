/**
 * Templates module — shared block/wrapper authoring system.
 *
 * Owns: marker grammar, parser, JSON-Schema content forms, source ingest
 * (git/upload/inline), drift monitoring, A/B engine, version pinning.
 *
 * Consumed by: newsletters, sites, and future content-bearing modules.
 *
 * See spec-templates-module.md for the full design.
 */

import type { GatewazeModule } from '@gatewaze/shared';

const templatesModule: GatewazeModule = {
  id: 'templates',
  type: 'feature',
  visibility: 'public',
  name: 'Templates',
  description:
    'Shared block/wrapper authoring: marker grammar, parser, source ingest, A/B engine, version pinning. Consumed by newsletters, sites, and future content modules.',
  version: '0.1.0',

  features: [
    'templates',
    'templates.editor',
    'templates.git-sources',
    'templates.ab.builtin',
  ],

  // No module dependencies — this is a foundational module other modules depend on.
  dependencies: [],

  migrations: [
    'migrations/001_templates_libraries_and_definitions.sql',
    'migrations/002_templates_sources.sql',
    'migrations/003_templates_ab.sql',
    'migrations/004_templates_helpers.sql',
    'migrations/005_templates_rls.sql',
    'migrations/006_templates_apply_source.sql',
    'migrations/007_templates_ab_helpers.sql',
    'migrations/008_templates_theme_kinds.sql',
    'migrations/009_templates_content_schemas.sql',
    'migrations/010_fix_can_admin_fn_dispatcher.sql',
    'migrations/011_writes_via_host.sql',
    'migrations/012_fix_select_policies_and_grants.sql',
    'migrations/013_rename_theme_kinds.sql',
    'migrations/014_block_defs_columns.sql',
    'migrations/015_wrappers_role.sql',
  ],

  // Admin routes land in PR 2+. The skeleton ships migrations + types only.
  adminRoutes: [],
  adminNavItems: [],

  configSchema: {
    git_check_interval_ms: {
      key: 'git_check_interval_ms',
      type: 'number',
      label: 'Git source check interval (ms)',
      required: false,
      default: String(15 * 60 * 1000),
      description: 'How often the drift-monitor worker polls git sources.',
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
    },
    parser_timeout_ms: {
      key: 'parser_timeout_ms',
      type: 'number',
      label: 'Parser timeout (ms)',
      required: false,
      default: '30000',
      description: 'Per-source parser timeout. Spec §9.1.',
      min: 1_000,
      max: 600_000,
    },
    parser_max_files_per_source: {
      key: 'parser_max_files_per_source',
      type: 'number',
      label: 'Max files per source',
      required: false,
      default: '50',
      description: 'Maximum number of files the parser will process from one source.',
      min: 1,
      max: 1000,
    },
    parser_max_bytes_per_file: {
      key: 'parser_max_bytes_per_file',
      type: 'number',
      label: 'Max bytes per file',
      required: false,
      default: '1048576',
      description: 'Per-file byte cap (default 1 MiB).',
      min: 1024,
      max: 10 * 1024 * 1024,
    },
  },

  onInstall: async () => {
    console.log('[templates] Module installed (v0.1.0)');
  },

  onEnable: async () => {
    console.log('[templates] Module enabled');
  },

  onDisable: async () => {
    console.log('[templates] Module disabled — note: dependent modules (newsletters, sites) may break');
  },
};

export default templatesModule;
