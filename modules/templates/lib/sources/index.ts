/**
 * Public source-ingest API.
 *
 * Usage:
 *   import { ingestUpload, ingestInline, applySource } from '@gatewaze-modules/templates/sources';
 */

export { applySource, type ApplyOptions, type ApplyResult, type ApplySupabaseClient } from './apply.js';
export {
  ingestUpload,
  ingestInline,
  reapplyUpload,
  type IngestSupabaseClient,
  type IngestUploadInput,
  type IngestInlineInput,
  type IngestResult,
} from './ingest.js';

// Git ingest is stubbed in v0.1 — see ./git.ts for the planned design.
export { ingestGit, checkGitSourceForUpdates, type IngestGitInput } from './git.js';
