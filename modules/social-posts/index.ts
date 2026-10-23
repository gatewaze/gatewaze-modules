// Before committing: run a security review of your diff (see CLAUDE.md — /security-review or `pragma:security`).
import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

/**
 * Social Posts — write social posts from curated content.
 *
 * An editor picks published items from the curated pool (blog posts and
 * articles, videos, events, structured resources such as conference recaps),
 * picks a format, and the ai module writes a LinkedIn post: hook, short
 * paragraphs, the links, hashtags, and @mentions of member companies the
 * content-keywords membership rules matched. The editor edits, regenerates,
 * copies, and saves it as a draft linked to its source items.
 *
 * Drafts only. Posting needs LinkedIn Community Management API access; the
 * drafts table already has the status and external_* columns a later poster
 * fills, and the platform registry in lib/formats.ts is where X and Bluesky
 * go.
 */
const socialPostsModule: GatewazeModule = {
  id: 'social-posts',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Social Posts',
  description:
    'Write LinkedIn post drafts from curated content with AI: pick blog posts, videos, events or recaps, pick a format, then edit, copy and save the draft.',
  version: '1.0.1',

  features: ['social-posts'],

  // ai: runChat, credentials, model allow-list and cost cap (use case
  // social-posts-linkedin). content-platform: the published state that
  // defines the curated pool. The content tables themselves (blog_posts,
  // videos, events, sr_items) are read only when present.
  dependencies: ['ai', 'content-platform'],

  migrations: [
    'migrations/001_social_posts.sql',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api/register-routes');
    // The host passes its Express app as unknown; the routes file types it.
    registerRoutes(app as never, context);
  },

  adminRoutes: [
    {
      // guard:'none' keeps the page top-level at /social-posts, like the
      // content-platform inbox. Every data operation is admin-gated
      // server-side by requireAdmin on /api/admin/social-posts.
      path: 'social-posts',
      component: () => import('./admin/pages/SocialPostsPage'),
      requiredFeature: 'social-posts',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/social-posts',
      label: 'Social Posts',
      icon: 'Megaphone',
      requiredFeature: 'social-posts',
      defaultSection: 'Marketing',
      defaultLocation: 'sidebar',
      order: 70,
    },
  ],

  configSchema: {},
};

export default socialPostsModule;
