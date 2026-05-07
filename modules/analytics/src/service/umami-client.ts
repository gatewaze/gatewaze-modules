/**
 * Thin HTTP client for Umami's REST API.
 *
 * Auth: Umami uses POST /api/auth/login with username/password and
 * returns a Bearer token. This client caches the token in-memory (per
 * spec §14.3 — never logged, never persisted) and refreshes on 401.
 *
 * No bigger HTTP framework — fetch + a couple of helpers. Self-contained
 * so swapping to a different client (or replaying via the umami-node SDK)
 * is one file change.
 */

export interface UmamiClientOptions {
  baseUrl: string;            // e.g. http://umami:3000
  username: string;
  password: string;
  /** Override fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Soft timeout per request (ms). Default 5_000. */
  timeoutMs?: number;
}

export interface UmamiClient {
  /** GET helper — auto-auths + refreshes on 401. */
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  /** POST helper. */
  post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T>;
  /** Force a token refresh (useful after rotating credentials). */
  refreshToken(): Promise<void>;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

/** Default Umami token TTL is ~24h; refresh proactively at 12h. */
const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function createUmamiClient(opts: UmamiClientOptions): UmamiClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  let tokenCache: TokenCache | null = null;

  async function login(): Promise<string> {
    const url = `${baseUrl}/api/auth/login`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: opts.username, password: opts.password }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`umami login failed: ${res.status}`);
      }
      const body = (await res.json()) as { token?: string };
      if (!body.token) throw new Error('umami login: no token in response');
      tokenCache = { value: body.token, expiresAt: Date.now() + TOKEN_REFRESH_INTERVAL_MS };
      return body.token;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken(): Promise<string> {
    if (tokenCache && Date.now() < tokenCache.expiresAt) {
      return tokenCache.value;
    }
    return login();
  }

  async function request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, query?: Record<string, string | number | undefined>): Promise<T> {
    const queryString = query
      ? '?' + new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : '';
    const url = `${baseUrl}${path}${queryString}`;

    const send = async (token: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchFn(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    const token = await getToken();
    let res = await send(token);

    // Refresh-on-401: token may have expired or admin password rotated.
    if (res.status === 401) {
      tokenCache = null;
      const newToken = await login();
      res = await send(newToken);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      throw new Error(`umami ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }

    return (await res.json()) as T;
  }

  return {
    get: <T = unknown>(path: string, query?: Record<string, string | number | undefined>) =>
      request<T>('GET', path, undefined, query),
    post: <T = unknown>(path: string, body: Record<string, unknown>) => request<T>('POST', path, body),
    async refreshToken() {
      tokenCache = null;
      await login();
    },
  };
}
