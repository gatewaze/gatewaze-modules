/**
 * Consent gate for tracking sessions.
 *
 * A tracking session carries the visitor's marketing consent as captured by
 * the portal: `tracking_consent` (boolean) and `consented_platforms` (the
 * platforms they agreed to share conversion data with; empty means none).
 * Click ids, IP and user agent from a session may only be sent to a platform
 * the session consents to. A registration with no usable session still sends
 * the hashed email alone, which is the same signal the batch export gives.
 */

export interface ConsentFields {
  tracking_consent?: boolean | null
  consented_platforms?: string[] | null
}

/** True when the session holds explicit consent for this platform. */
export function sessionConsentsTo(session: ConsentFields | null | undefined, platform: string): boolean {
  if (!session) return false
  if (session.tracking_consent !== true) return false
  const platforms = Array.isArray(session.consented_platforms) ? session.consented_platforms : []
  return platforms.includes(platform)
}

/** True when the session holds consent for at least one platform. */
export function sessionHasAnyConsent(session: ConsentFields | null | undefined): boolean {
  if (!session) return false
  if (session.tracking_consent !== true) return false
  return Array.isArray(session.consented_platforms) && session.consented_platforms.length > 0
}
