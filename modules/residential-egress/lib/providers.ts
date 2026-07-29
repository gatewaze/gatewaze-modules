/**
 * Residential-proxy provider adapters — build the proxy connection URL for a
 * given provider from operator credentials.
 *
 * Ported faithfully from the scrapling-fetcher Python providers
 * (`app/proxy/*.py`) so the module and the service agree byte-for-byte on the
 * username/password session conventions. Each provider encodes "sticky session"
 * and "country" differently — most on the username, IPRoyal on the password.
 *
 * A fresh `sessionId` = a fresh residential exit IP; rotating the session is how
 * a consumer moves past a throttled or flagged IP (see run-recap rotation).
 */

export type ProviderId =
  | 'dataimpulse'
  | 'rayobyte'
  | 'brightdata'
  | 'oxylabs'
  | 'webshare'
  | 'iproyal'
  | 'decodo'
  | 'none';

export interface ProxyCreds {
  provider: ProviderId;
  /** Proxy login (Bright Data: customer id; Oxylabs/Decodo: sub-user). */
  username: string;
  password: string;
  gateway_host?: string;
  gateway_port?: number;
  /** Bright Data only: zone name. */
  zone?: string;
  /** Optional ISO-3166 alpha-2 country pin (e.g. "us"). */
  default_country?: string;
  /** Sticky-session lifetime hint (minutes) where the provider honours it. */
  session_minutes?: number;
}

export interface BuildOpts {
  /** Non-empty → sticky session (a stable exit IP); null/undefined → rotate. */
  sessionId?: string | null;
  country?: string | null;
}

/** Default gateway host/port per provider (operator can override in config). */
export const PROVIDER_DEFAULTS: Record<Exclude<ProviderId, 'none'>, { host: string; port: number }> = {
  dataimpulse: { host: 'gw.dataimpulse.com', port: 823 },
  rayobyte: { host: 'gw.rayobyte.com', port: 8080 },
  brightdata: { host: 'brd.superproxy.io', port: 22225 },
  oxylabs: { host: 'pr.oxylabs.io', port: 7777 },
  webshare: { host: 'p.webshare.io', port: 80 },
  iproyal: { host: 'geo.iproyal.com', port: 12321 },
  decodo: { host: 'gate.decodo.com', port: 7000 },
};

/** A random 12-hex-char session id — one per exit IP we want. */
export function newSessionId(rand: () => number = Math.random): string {
  let s = '';
  while (s.length < 12) s += Math.floor(rand() * 0x10000).toString(16).padStart(4, '0');
  return s.slice(0, 12);
}

const enc = (s: string) => encodeURIComponent(s);

/**
 * Build the `http://user:pass@host:port` proxy URL for the given provider.
 * Throws for an unconfigured/`none` provider or missing credentials.
 */
export function buildProxyUrl(creds: ProxyCreds, opts: BuildOpts = {}): string {
  const provider = creds.provider;
  if (provider === 'none') throw new Error('residential-egress: provider is "none" (not configured)');
  const def = PROVIDER_DEFAULTS[provider];
  if (!def) throw new Error(`residential-egress: unknown provider "${provider}"`);
  if (!creds.username || !creds.password) {
    throw new Error(`residential-egress: ${provider} requires username and password`);
  }
  const host = creds.gateway_host || def.host;
  const port = creds.gateway_port || def.port;
  const country = (opts.country ?? creds.default_country) || null;
  const sid = opts.sessionId || null;
  const mins = creds.session_minutes ?? 10;

  let user = creds.username;
  let pass = creds.password;

  switch (provider) {
    case 'dataimpulse': {
      let u = creds.username;
      if (country) u += `__cr.${country.toLowerCase()}`;
      if (sid) u += `__sid.${sid}`;
      user = u;
      break;
    }
    case 'rayobyte': {
      const parts = [creds.username];
      if (country) parts.push(`country-${country}`);
      if (sid) { parts.push(`session-${sid}`); parts.push(`sessTime-${mins}`); }
      user = parts.join('-');
      break;
    }
    case 'brightdata': {
      const parts = [`brd-customer-${creds.username}-zone-${creds.zone || 'residential'}`];
      if (country) parts.push(`country-${country}`);
      if (sid) parts.push(`session-${sid}`);
      user = parts.join('-');
      break;
    }
    case 'oxylabs': {
      const parts = [`customer-${creds.username}`];
      if (country) parts.push(`cc-${country}`);
      if (sid) { parts.push(`sessid-${sid}`); parts.push(`sesstime-${mins * 60}`); }
      user = parts.join('-');
      break;
    }
    case 'webshare': {
      const parts = [creds.username];
      if (country) parts.push(`CC-${country.toUpperCase()}`);
      parts.push(sid ? `rotate-${sid}` : 'rotate');
      user = parts.join('-');
      break;
    }
    case 'iproyal': {
      // IPRoyal appends flags to the PASSWORD, not the username.
      const parts = [creds.password];
      if (country) parts.push(`country-${country}`);
      if (sid) { parts.push(`session-${sid}`); parts.push(`lifetime-${mins}m`); }
      pass = parts.join('_');
      break;
    }
    case 'decodo': {
      const parts = [`user-${creds.username}`];
      if (country) parts.push(`country-${country}`);
      if (sid) parts.push(`session-${sid}`);
      user = parts.join('-');
      break;
    }
  }

  return `http://${enc(user)}:${enc(pass)}@${host}:${port}`;
}
