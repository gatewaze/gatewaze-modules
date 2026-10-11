/**
 * Pulls the caller's Supabase access token from the Authorization
 * header, or from the sb-*-auth-token cookie. Dependency-free so both
 * requireJwt() and the per-host authorizer can share it.
 */

import type { Request } from 'express';

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    // Split into individual cookies and match the name with string ops — NOT a backtracking regex
    // over the whole Cookie header (which CodeQL flags as polynomial ReDoS on untrusted input).
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      if (!name.startsWith('sb-') || !name.endsWith('-auth-token')) continue;
      try {
        const parsed = JSON.parse(decodeURIComponent(part.slice(eq + 1).trim())) as { access_token?: string };
        if (parsed.access_token) return parsed.access_token;
      } catch {
        // malformed cookie → keep scanning
      }
    }
  }
  return null;
}
