// @ts-nocheck — express + supabase-js types are resolved at module-host install time.

export function requireJwt() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (process.env.GATEWAZE_TEST_DISABLE_AUTH === '1') {
      (req as Request & { userId?: string }).userId = '00000000-0000-0000-0000-000000000001';
      next();
      return;
    }
    const token = extractToken(req);
    if (!token) {
      errorResponse(res, 401, 'unauthenticated', 'Missing or malformed Authorization header');
      return;
    }
    // ONE verification path for every algorithm: Supabase Auth checks the
    // signature server-side (HS256 self-host and ES256 cloud alike). No
    // branching on attacker-controlled header fields (js/user-controlled-
    // bypass), and the decoded payload is never trusted directly.
    const client = verifyClient();
    if (!client) {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
      return;
    }
    try {
      const { data, error } = await client.auth.getUser(token);
      const sub = data?.user?.id;
      if (error || !sub) {
        errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
        return;
      }
      (req as Request & { userId?: string }).userId = sub;
      next();
    } catch {
      errorResponse(res, 401, 'invalid_token', 'JWT verification failed');
    }
  };
}

