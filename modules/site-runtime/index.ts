/**
 * @gatewaze-modules/site-runtime — operator-facing helper for rendered sites.
 *
 * The publish-worker writes `public/_gatewaze/site-config.json` and
 * `public/_gatewaze/ab-bindings.json` into every site's emitted tree. This
 * package gives the operator's Next.js theme a single import to surface
 * those into the page <head>:
 *
 *   import { GatewazeHead } from '@gatewaze-modules/site-runtime';
 *
 *   export default function RootLayout({ children }) {
 *     return (
 *       <html lang="en">
 *         <head><GatewazeHead /></head>
 *         <body>{children}</body>
 *       </html>
 *     );
 *   }
 *
 * The component fetches the site config on mount and injects:
 *   - Umami `<script defer src=… data-website-id=…>` if configured
 *   - The A/B bootstrap inline script if any pages have running tests
 */

import type { GatewazeModule } from '@gatewaze/shared';

// Module manifest — keeps the gatewaze module-loader happy (every directory
// under MODULE_SOURCES expects a default export). This module is operator-
// theme-imported, so it has no DB / routes / nav surface; the manifest is
// here purely so the platform's module discovery doesn't treat it as
// malformed.
const siteRuntimeModule: GatewazeModule = {
  id: 'site-runtime',
  group: 'sites',
  type: 'feature',
  visibility: 'public',
  name: 'Site Runtime',
  description:
    'Tiny React helper for operator themes — exposes <GatewazeHead /> that injects gatewaze analytics + A/B engine into rendered sites. No DB / admin / nav surface; consumed as a code dependency by sites that own their Next.js layout.',
  version: '0.1.0',
  features: ['site-runtime'],
  dependencies: [],
  migrations: [],
  adminRoutes: [],
  adminNavItems: [],
  configSchema: {},
};

export default siteRuntimeModule;

export { GatewazeHead, type GatewazeHeadProps } from './GatewazeHead.js';
