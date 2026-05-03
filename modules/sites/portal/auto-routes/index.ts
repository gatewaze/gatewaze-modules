/**
 * Auto-route content for sites with compliance + auth enabled.
 *
 * Per spec-content-modules-git-architecture §13.1 + §12.1:
 *   /privacy, /terms, /cookie-policy           — compliance-driven
 *   /account/login, /account/signup,           — auth-driven
 *   /account/reset
 *   /account/privacy-requests,                 — both (auth + compliance)
 *   /account/data-export
 *
 * The portal's site-rendering route checks `getAutoRouteResolver(slug)`
 * BEFORE attempting to render a theme page. If the resolver returns a
 * component, it's rendered (with SiteShell); otherwise the theme's
 * page (or 404) is used.
 *
 * The theme can override any auto-route by providing a same-path page
 * in `main` (e.g. `app/privacy/page.tsx`); the portal checks for the
 * theme-provided page first via the file-existence check in `publish/`.
 */

import type { ReactNode } from 'react';

export interface AutoRouteContext {
  site: {
    id: string;
    slug: string;
    name: string;
    auth_enabled: boolean;
    compliance_overrides: Record<string, boolean>;
  };
  /** True when the compliance module is installed + enabled. */
  hasCompliance: boolean;
  /** Resolved compliance content for managed slugs. */
  getStaticContent: (slug: 'privacy' | 'terms' | 'cookie-policy') => Promise<string | null>;
  /** Currently authenticated user (or null). */
  currentUser: { id: string; email: string } | null;
}

export type AutoRouteRenderer = (ctx: AutoRouteContext) => Promise<ReactNode>;

const AUTO_ROUTES: Record<string, { needsCompliance: boolean; needsAuth: boolean; render: AutoRouteRenderer }> = {
  '/privacy': {
    needsCompliance: true, needsAuth: false,
    render: async (ctx) => {
      const html = await ctx.getStaticContent('privacy');
      if (!html) return null;
      return renderStaticHtml('Privacy', html);
    },
  },
  '/terms': {
    needsCompliance: true, needsAuth: false,
    render: async (ctx) => {
      const html = await ctx.getStaticContent('terms');
      if (!html) return null;
      return renderStaticHtml('Terms of Service', html);
    },
  },
  '/cookie-policy': {
    needsCompliance: true, needsAuth: false,
    render: async (ctx) => {
      const html = await ctx.getStaticContent('cookie-policy');
      if (!html) return null;
      return renderStaticHtml('Cookie Policy', html);
    },
  },
  '/account/login': {
    needsCompliance: false, needsAuth: true,
    render: async (ctx) => {
      if (ctx.currentUser) return renderRedirect('/account');
      return renderLoginForm(ctx.site.slug);
    },
  },
  '/account/signup': {
    needsCompliance: false, needsAuth: true,
    render: async (ctx) => {
      if (ctx.currentUser) return renderRedirect('/account');
      return renderSignupForm(ctx.site.slug);
    },
  },
  '/account/reset': {
    needsCompliance: false, needsAuth: true,
    render: async (_ctx) => renderResetForm(),
  },
  '/account/privacy-requests': {
    needsCompliance: true, needsAuth: true,
    render: async (ctx) => {
      if (!ctx.currentUser) return renderRedirect(`/account/login?next=${encodeURIComponent('/account/privacy-requests')}`);
      return renderPrivacyRequestForm(ctx.currentUser.email);
    },
  },
  '/account/data-export': {
    needsCompliance: true, needsAuth: true,
    render: async (ctx) => {
      if (!ctx.currentUser) return renderRedirect(`/account/login?next=${encodeURIComponent('/account/data-export')}`);
      return renderDataExportForm(ctx.currentUser.email);
    },
  },
};

/**
 * Returns a renderer for the given path if it's an auto-route AND the
 * site is configured to serve it. Returns null otherwise (caller falls
 * through to theme rendering or 404).
 */
export function getAutoRouteResolver(
  path: string,
  ctx: { site: AutoRouteContext['site']; hasCompliance: boolean },
): AutoRouteRenderer | null {
  const route = AUTO_ROUTES[path];
  if (!route) return null;

  // Compliance-required routes only when module installed AND not overridden
  if (route.needsCompliance) {
    if (!ctx.hasCompliance) return null;
    if (ctx.site.compliance_overrides.privacy_routes_enabled === false) return null;
  }
  // Auth-required routes only when site has auth enabled
  if (route.needsAuth && !ctx.site.auth_enabled) return null;

  return route.render;
}

// ---------------------------------------------------------------------------
// Render helpers — minimal server-component output. Real portal integration
// uses Tailwind + the site's wrapper for visual continuity.
// ---------------------------------------------------------------------------

function renderStaticHtml(title: string, html: string): ReactNode {
  return (
    <article className="prose prose-neutral max-w-none mx-auto py-12">
      <h1>{title}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

function renderRedirect(href: string): ReactNode {
  // Server-render a meta-refresh fallback; the portal's Next.js router-level
  // redirect runs upstream when this resolver is detected.
  return (
    <html lang="en">
      <head>
        <meta httpEquiv="refresh" content={`0;url=${href}`} />
      </head>
      <body>
        <p>Redirecting to <a href={href}>{href}</a>…</p>
      </body>
    </html>
  );
}

function renderLoginForm(siteSlug: string): ReactNode {
  return (
    <div className="max-w-md mx-auto py-12">
      <h1 className="text-2xl font-bold mb-6">Sign in</h1>
      <form action="/account/login" method="POST" className="space-y-4">
        <input type="hidden" name="site_slug" value={siteSlug} />
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required className="mt-1 block w-full px-3 py-2 border rounded-md" autoComplete="email" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input type="password" name="password" required className="mt-1 block w-full px-3 py-2 border rounded-md" autoComplete="current-password" />
        </label>
        <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-md font-medium">Sign in</button>
      </form>
      <p className="mt-4 text-sm text-center">
        Need an account? <a href="/account/signup" className="text-blue-600">Sign up</a>
      </p>
      <p className="mt-2 text-sm text-center">
        <a href="/account/reset" className="text-blue-600">Forgot password?</a>
      </p>
    </div>
  );
}

function renderSignupForm(siteSlug: string): ReactNode {
  return (
    <div className="max-w-md mx-auto py-12">
      <h1 className="text-2xl font-bold mb-6">Create account</h1>
      <form action="/account/signup" method="POST" className="space-y-4">
        <input type="hidden" name="site_slug" value={siteSlug} />
        <label className="block">
          <span className="text-sm font-medium">Full name</span>
          <input type="text" name="full_name" required className="mt-1 block w-full px-3 py-2 border rounded-md" autoComplete="name" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required className="mt-1 block w-full px-3 py-2 border rounded-md" autoComplete="email" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input type="password" name="password" required minLength={8} className="mt-1 block w-full px-3 py-2 border rounded-md" autoComplete="new-password" />
        </label>
        <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-md font-medium">Sign up</button>
      </form>
      <p className="mt-4 text-sm text-center">
        Already have an account? <a href="/account/login" className="text-blue-600">Sign in</a>
      </p>
    </div>
  );
}

function renderResetForm(): ReactNode {
  return (
    <div className="max-w-md mx-auto py-12">
      <h1 className="text-2xl font-bold mb-6">Reset password</h1>
      <form action="/account/reset" method="POST" className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required className="mt-1 block w-full px-3 py-2 border rounded-md" autoComplete="email" />
        </label>
        <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-md font-medium">Send reset link</button>
      </form>
    </div>
  );
}

function renderPrivacyRequestForm(email: string): ReactNode {
  return (
    <div className="max-w-md mx-auto py-12">
      <h1 className="text-2xl font-bold mb-6">Privacy request</h1>
      <p className="text-sm text-gray-600 mb-4">
        Submit a GDPR/CCPA privacy request. We'll respond within 30 days.
      </p>
      <form action="/account/privacy-requests" method="POST" className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Account email</span>
          <input type="email" name="email" defaultValue={email} readOnly className="mt-1 block w-full px-3 py-2 border rounded-md bg-gray-50" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Request type</span>
          <select name="kind" required className="mt-1 block w-full px-3 py-2 border rounded-md">
            <option value="export">Data export (Article 15)</option>
            <option value="erasure">Right to be forgotten (Article 17)</option>
            <option value="rectification">Rectification (Article 16)</option>
            <option value="objection">Object to processing (Article 21)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Details (optional)</span>
          <textarea name="details" rows={4} className="mt-1 block w-full px-3 py-2 border rounded-md" />
        </label>
        <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-md font-medium">Submit request</button>
      </form>
    </div>
  );
}

function renderDataExportForm(email: string): ReactNode {
  return (
    <div className="max-w-md mx-auto py-12">
      <h1 className="text-2xl font-bold mb-6">Export your data</h1>
      <p className="text-sm text-gray-600 mb-4">
        Request a JSON export of all data we hold about your account.
        We'll email a download link within 24 hours.
      </p>
      <form action="/account/data-export" method="POST" className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Account email</span>
          <input type="email" name="email" defaultValue={email} readOnly className="mt-1 block w-full px-3 py-2 border rounded-md bg-gray-50" />
        </label>
        <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-md font-medium">Request export</button>
      </form>
    </div>
  );
}
