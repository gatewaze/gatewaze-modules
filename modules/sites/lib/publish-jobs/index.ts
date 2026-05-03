/**
 * Publish-job machinery — public exports.
 *
 * The actual worker (BullMQ handler) lives in workers/publish-job.ts and
 * composes these helpers + a Supabase service-role client + the platform's
 * pub/sub helper.
 */

export {
  isTerminal,
  canTransition,
  legalNextStates,
  assertTransition,
  type PublishJobStatus,
} from './state-machine.js';

export {
  matchWebhookEvent,
  statusForEvent,
  replayKey,
  type JobMatchCandidate,
  type WebhookMatchResult,
  type MatchStrategy,
} from './match-webhook.js';

export {
  buildInvalidationMessage,
  isValidInvalidationMessage,
  cacheKeyForRoute,
  CACHE_INVALIDATION_CHANNEL,
  type CacheInvalidationMessage,
} from './cache-invalidation.js';
