/**
 * Sites module — API surface aggregator.
 *
 * The platform's `apiRoutes(app, ctx)` callback (declared in the module's
 * top-level index.ts) imports `createAdminRoutes` + `mountAdminRoutes` and
 * `createRuntimeRoutes` + `mountRuntimeRoutes`, instantiates them with
 * platform-supplied deps (Supabase service-role client, logger, rate-limiter,
 * key pepper), and mounts on labeledRouters with the appropriate auth label
 * ('jwt' for /admin, 'public' for /runtime).
 */

export {
  createAdminRoutes,
  mountAdminRoutes,
  type AdminRoutesDeps,
  type AdminSupabaseClient,
} from './admin.js';

export {
  createRuntimeRoutes,
  mountRuntimeRoutes,
  type RuntimeRoutesDeps,
  type RuntimeSupabaseClient,
  type ContentRequest,
  type ContentResponse,
  type RuntimeError,
} from './runtime.js';

export {
  createSsrRoutes,
  mountSsrRoutes,
  type SsrRoutesDeps,
  type SsrSupabaseClient,
} from './ssr.js';

export {
  createRepublishRoutes,
  mountRepublishRoutes,
  type RepublishRoutesDeps,
  type RepublishSupabaseClient,
} from './republish.js';

export {
  createSitesMcpTools,
  type McpToolDeps,
  type McpToolDef,
} from './mcp-tools.js';
