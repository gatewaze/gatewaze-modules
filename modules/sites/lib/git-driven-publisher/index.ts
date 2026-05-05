/**
 * Public API for the git-driven publishing surface.
 *
 * Sub-modules implementing IGitDrivenPublisher (sites-publisher-stub-git,
 * sites-publisher-vercel-git, sites-publisher-netlify-git) consume these
 * types and helpers. The publisher implementations themselves live in
 * those sub-modules; this directory hosts the contract + pure helpers.
 */

export type {
  IGitDrivenPublisher,
  CommitArgs,
  CommitFile,
  CommitResult,
  OpenPullRequestArgs,
  OpenPullRequestResult,
  VerifyWebhookArgs,
  VerifyWebhookResult,
  ValidateConfigResult,
  BuildStatusEvent,
} from './types.js';

export {
  pageBranchSlug,
  buildBranchName,
  compactTimestamp,
  checkRemoteAgainstAllowlist,
  type BuildBranchNameArgs,
} from './branch-slug.js';

export {
  serializeContent,
  substitutePathTemplate,
  type ContentFormat,
  type FrontmatterFormat,
  type SerializeContentInput,
  type SerializeContentResult,
} from './serialize-content.js';

export {
  createStubGitDrivenPublisher,
  type StubGitDrivenPublisher,
} from './stub.js';
