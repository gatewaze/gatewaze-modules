/**
 * Newsletters module — API surface.
 *
 * Phase 1: edition publish-to-git.
 * Phase 2.1: graduate-to-external (collection git mode flip).
 * Phase 2.2: manifest read for per-channel block config.
 * Phase 2.3: drift detection between internal + external HEAD.
 */
export { createPublishToGitRoute, createUnpublishFromGitRoute, mountPublishToGitRoute } from './publish-to-git.js';
export type { PublishToGitDeps } from './publish-to-git.js';
export {
  createInitRepoRoute,
  createGraduateToExternalRoute,
  createDriftRoute,
  createManifestRoute,
  mountGitRoutes,
} from './git-routes.js';
export type { GitRoutesDeps } from './git-routes.js';
export { createDeleteCollectionRoute } from './delete-collection.js';
export type { DeleteCollectionDeps } from './delete-collection.js';
