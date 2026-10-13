/**
 * The real Supabase URL, for URLs that leave the admin or get stored: OAuth
 * redirect URIs, links sent in emails, and public storage URLs saved into
 * rows that the portal and emails render later.
 *
 * In gatewaze core's host-session mode VITE_SUPABASE_URL is the admin origin
 * (browser requests go through a same-origin session holder) and
 * VITE_SUPABASE_PUBLIC_URL carries the real Supabase URL. Older admin builds
 * do not set VITE_SUPABASE_PUBLIC_URL, so this falls back to
 * VITE_SUPABASE_URL, and local mode, where both are the real URL, is
 * unchanged.
 *
 * Mirrors core's getSupabasePublicUrl(): the public URL is used only when it
 * is https (http only on localhost, 127.0.0.1 or *.localhost), and trailing
 * slashes are stripped so `${url}/functions/v1/...` matches the URL the
 * server builds. It is a copy rather than an import because every install
 * builds this module against its own admin, and older admins do not export
 * getSupabasePublicUrl(). Keep the literal `import.meta.env.VITE_...` reads:
 * the admin build greps for that text to wire up runtime config.
 */
export function publicSupabaseUrl(): string {
  const configured: string | undefined = import.meta.env.VITE_SUPABASE_PUBLIC_URL;
  const base: string =
    configured && isHttpsOrLocalhostUrl(configured)
      ? configured
      : import.meta.env.VITE_SUPABASE_URL || '';
  return base.replace(/\/+$/, '');
}

/** https, or http on localhost: the only schemes a URL handed to the outside may use. */
function isHttpsOrLocalhostUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return true;
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost'))
    );
  } catch {
    return false;
  }
}
