export {
  isTerminal,
  canTransition,
  legalNextStates,
  assertTransition,
  type DeploymentStatus,
} from './state-machine.js';

export {
  selectPreviewsForCleanup,
  selectStaleDeployments,
  selectWebhookSeenForPurge,
  PREVIEW_DEFAULT_RETENTION_HOURS,
  STALE_HEARTBEAT_GRACE_MS,
  WEBHOOK_SEEN_RETENTION_DAYS,
  type PreviewCandidate,
  type StaleCandidate,
  type WebhookSeenCandidate,
} from './sweeper.js';

export {
  buildFileManifest,
  manifestDelta,
  type ManifestEntry,
  type ManifestEntryInput,
} from './build-manifest.js';
