/**
 * Per-asset signed URLs for restricted media.
 *
 * Per spec-content-modules-git-architecture §19.5 (v1.x):
 *   - host_media.access_level controls how the URL is served:
 *     - 'public': raw bucket URL; no signing needed
 *     - 'authenticated': URL is rewritten to a route that checks session
 *       cookies before redirecting to the bucket URL
 *     - 'signed': time-limited HMAC-signed token appended; the
 *       /api/media/serve route validates the signature before redirecting
 *
 * Sign + verify use the same pattern as the internal-git-server signed
 * URLs (HMAC-SHA256 over a payload containing media_id + op + exp +
 * optional ip_cidr).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignMediaUrlArgs {
  mediaId: string;
  /** Storage path of the media item (used in the signed payload). */
  storagePath: string;
  /** Operation — currently only 'read' is meaningful. */
  op: 'read';
  /** Token TTL in seconds. */
  ttlSeconds: number;
  /** Optional IP CIDR to bind the token to (defenses against URL leakage). */
  ipCidr?: string;
}

export interface SignedUrlResult {
  /** Signed URL ready to surface to the user (relative path; caller prepends domain). */
  signedUrl: string;
  /** When the URL expires (epoch seconds). */
  expiresAt: number;
}

export class MediaUrlSigner {
  constructor(private readonly signingKey: Buffer) {
    if (signingKey.length < 32) {
      throw new Error('signing key must be at least 32 bytes');
    }
  }

  sign(args: SignMediaUrlArgs): SignedUrlResult {
    const exp = Math.floor(Date.now() / 1000) + args.ttlSeconds;
    const ipCidr = args.ipCidr ?? '0.0.0.0/0';
    const payload = `${args.mediaId}|${args.storagePath}|${args.op}|${exp}|${ipCidr}`;
    const token = createHmac('sha256', this.signingKey).update(payload).digest('hex');
    const params = new URLSearchParams({
      token,
      exp: String(exp),
      op: args.op,
      ip_cidr: ipCidr,
    });
    return {
      signedUrl: `/api/media/serve/${encodeURIComponent(args.mediaId)}?${params.toString()}`,
      expiresAt: exp,
    };
  }

  /**
   * Validate a signed URL request. Returns true if HMAC matches AND
   * token not expired AND requesting IP within the bound CIDR.
   */
  validate(args: {
    mediaId: string;
    storagePath: string;
    params: URLSearchParams;
    requestIp: string;
  }): { ok: true; op: string } | { ok: false; reason: string } {
    const token = args.params.get('token');
    const expStr = args.params.get('exp');
    const op = args.params.get('op');
    const ipCidr = args.params.get('ip_cidr');
    if (!token || !expStr || !op || !ipCidr) {
      return { ok: false, reason: 'missing_params' };
    }
    const exp = parseInt(expStr, 10);
    if (Number.isNaN(exp)) return { ok: false, reason: 'invalid_exp' };
    if (exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
    if (!ipMatchesCidr(args.requestIp, ipCidr)) return { ok: false, reason: 'ip_not_in_cidr' };

    const payload = `${args.mediaId}|${args.storagePath}|${op}|${exp}|${ipCidr}`;
    const expected = createHmac('sha256', this.signingKey).update(payload).digest('hex');
    try {
      const valid = token.length === expected.length
        && timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
      return valid ? { ok: true, op } : { ok: false, reason: 'invalid_signature' };
    } catch {
      return { ok: false, reason: 'invalid_signature' };
    }
  }
}

// IPv4 CIDR matcher — same impl as in internal-git-server-impl.ts
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash === -1) return ip === cidr;
  const network = cidr.slice(0, slash);
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (bits === 0) return true;
  if (bits === 32) return ip === network;

  const ipParts = ip.split('.').map((p) => parseInt(p, 10));
  const netParts = network.split('.').map((p) => parseInt(p, 10));
  if (ipParts.length !== 4 || netParts.length !== 4) return false;
  if (ipParts.some(Number.isNaN) || netParts.some(Number.isNaN)) return false;

  const ipInt = ((ipParts[0] ?? 0) << 24) >>> 0
              | ((ipParts[1] ?? 0) << 16) >>> 0
              | ((ipParts[2] ?? 0) << 8) >>> 0
              | (ipParts[3] ?? 0);
  const netInt = ((netParts[0] ?? 0) << 24) >>> 0
               | ((netParts[1] ?? 0) << 16) >>> 0
               | ((netParts[2] ?? 0) << 8) >>> 0
               | (netParts[3] ?? 0);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}
