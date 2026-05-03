/**
 * Auth form action handlers for site auth-enabled routes.
 *
 * Per spec-content-modules-git-architecture §12.2:
 *
 *   POST /account/login    — email + password → Supabase Auth signIn → cookie on .brandname.com
 *   POST /account/signup   — email + password + full_name → Supabase Auth signUp → magic-link email
 *   POST /account/reset    — email → Supabase Auth resetPasswordForEmail → magic-link email
 *   POST /account/logout   — Supabase Auth signOut → clear cookie
 *
 * The portal site-rendering route mounts these as form action targets.
 * Cookie scope: per spec §12.2, `.brandname.com` so SSO across portal +
 * sites works automatically.
 */

import type { Request, Response, Router } from 'express';

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AuthRoutesDeps {
  /**
   * Supabase Auth surface — narrow shape for the operations we need.
   * Why `any` on internal: the Supabase Auth client's full type includes
   * dozens of methods we don't touch and would force callers to ship the
   * full @supabase/supabase-js types into their dep tree.
   */
  authClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signInWithPassword(args: { email: string; password: string }): Promise<{ data: any; error: { message: string; status?: number } | null }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signUp(args: { email: string; password: string; options?: { data?: Record<string, unknown>; emailRedirectTo?: string } }): Promise<{ data: any; error: { message: string } | null }>;
    resetPasswordForEmail(email: string, opts?: { redirectTo?: string }): Promise<{ data: unknown; error: { message: string } | null }>;
    signOut(): Promise<{ error: { message: string } | null }>;
  };
  /** Cookie domain for the auth cookie (e.g. `.brandname.com` or `.aaif.localhost`). */
  cookieDomain: string;
  /** True when serving over HTTPS (sets Secure flag). */
  isProduction: boolean;
  /** Origin for email-link redirects (the site's `<slug>.sites.brandname.com`). */
  siteOrigin: (req: Request) => string;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function getFormField(req: Request, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

const SESSION_COOKIE_NAME = 'sb:token';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function createAuthRoutes(deps: AuthRoutesDeps) {
  function setSessionCookie(res: Response, accessToken: string): void {
    res.cookie(SESSION_COOKIE_NAME, accessToken, {
      domain: deps.cookieDomain,
      httpOnly: true,
      secure: deps.isProduction,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE * 1000,
      path: '/',
    });
  }
  function clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, { domain: deps.cookieDomain, path: '/' });
  }

  async function login(req: Request, res: Response): Promise<void> {
    const email = getFormField(req, 'email');
    const password = getFormField(req, 'password');
    const next = getFormField(req, 'next') || '/account';
    if (!email || !password) {
      res.status(400).json({ error: 'missing_fields', message: 'email + password required' } satisfies ErrorEnvelope);
      return;
    }

    const result = await deps.authClient.signInWithPassword({ email, password });
    if (result.error) {
      deps.logger.warn('login failed', { email, status: result.error.status });
      res.status(result.error.status === 400 ? 400 : 401).json({
        error: 'invalid_credentials',
        message: 'email or password is incorrect',
      } satisfies ErrorEnvelope);
      return;
    }
    const accessToken = result.data?.session?.access_token;
    if (!accessToken) {
      res.status(500).json({ error: 'no_session', message: 'Supabase Auth returned no session' } satisfies ErrorEnvelope);
      return;
    }

    setSessionCookie(res, accessToken);
    // Form-post → 302 redirect with HTMX-style next
    res.redirect(303, next);
  }

  async function signup(req: Request, res: Response): Promise<void> {
    const email = getFormField(req, 'email');
    const password = getFormField(req, 'password');
    const fullName = getFormField(req, 'full_name');
    if (!email || !password) {
      res.status(400).json({ error: 'missing_fields', message: 'email + password required' } satisfies ErrorEnvelope);
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'weak_password', message: 'password must be at least 8 characters' } satisfies ErrorEnvelope);
      return;
    }

    const result = await deps.authClient.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName || undefined },
        emailRedirectTo: `${deps.siteOrigin(req)}/account`,
      },
    });
    if (result.error) {
      deps.logger.warn('signup failed', { email, error: result.error.message });
      res.status(400).json({ error: 'signup_failed', message: result.error.message } satisfies ErrorEnvelope);
      return;
    }
    // Supabase Auth returns the session if email confirmation is disabled,
    // otherwise it requires a magic-link confirmation. We surface a
    // generic "check your email" page in both cases for consistency.
    if (result.data?.session?.access_token) {
      setSessionCookie(res, result.data.session.access_token);
      res.redirect(303, '/account');
    } else {
      res.redirect(303, '/account/login?msg=check-email');
    }
  }

  async function resetPassword(req: Request, res: Response): Promise<void> {
    const email = getFormField(req, 'email');
    if (!email) {
      res.status(400).json({ error: 'missing_fields', message: 'email required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await deps.authClient.resetPasswordForEmail(email, {
      redirectTo: `${deps.siteOrigin(req)}/account/login?msg=reset-sent`,
    });
    if (result.error) {
      // Don't leak whether the email is registered — return success either way
      deps.logger.info('reset password upstream error (returning generic success)', { email, error: result.error.message });
    }
    res.redirect(303, '/account/login?msg=reset-sent');
  }

  async function logout(_req: Request, res: Response): Promise<void> {
    await deps.authClient.signOut();
    clearSessionCookie(res);
    res.redirect(303, '/');
  }

  return { login, signup, resetPassword, logout };
}

export function mountAuthRoutes(router: Router, routes: ReturnType<typeof createAuthRoutes>): void {
  router.post('/account/login', routes.login);
  router.post('/account/signup', routes.signup);
  router.post('/account/reset', routes.resetPassword);
  router.post('/account/logout', routes.logout);
}
