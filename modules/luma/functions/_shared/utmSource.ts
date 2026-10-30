/**
 * UTM source handling shared by the Luma registration paths.
 *
 * Luma records the `utm_source` a registrant arrived with as the guest's
 * `custom_source`. It reaches us three ways:
 *   - manager notification email: a line "UTM source for the registration was X."
 *   - webhook payload: `custom_source`
 *   - guest CSV export: `custom_source` column
 *
 * When the click came through the Gatewaze tracking redirect the value is
 * shaped `{platform}__{session_id}` (see portal `/e/[identifier]`), and the
 * session id is what the ad-conversions module matches on. Any other value is
 * a plain source such as "facebook" or "chatgpt.com" and is kept as-is.
 *
 * All three inputs are untrusted (the inbound email endpoint has no sender
 * authentication), so values are capped in length, stripped of control
 * characters, and the session id must match the shape the portal mints.
 */

export const UTM_SOURCE_MAX_LENGTH = 200
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Trim, drop control characters, and cap. Returns null for an empty result. */
export function sanitizeUtmSource(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  // deno-lint-ignore no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!cleaned) return null
  return cleaned.length > UTM_SOURCE_MAX_LENGTH ? cleaned.slice(0, UTM_SOURCE_MAX_LENGTH) : cleaned
}

/**
 * Extract the raw utm_source from a Luma notification email body.
 *
 * The line ends with a full stop that is not part of the value, but the value
 * itself may contain dots ("chatgpt.com", "blog.techeurope.io"), so the match
 * runs to the end of the line and only strips a trailing full stop.
 */
export function extractUtmSource(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/UTM source for the registration was[ \t]+([^\r\n]*?)\.?[ \t]*(?:[\r\n]|$)/i)
  if (!match) return null
  return sanitizeUtmSource(match[1])
}

/**
 * Extract the Gatewaze tracking session id from a custom_source value.
 * Format: "{platform}__{session_id}" e.g. "meta__ml7xo47p-dmsby75m".
 * Only ids in the shape the portal mints (`<base36>-<base36>`, letters,
 * digits, `-` and `_`, at most 64 chars) are accepted.
 */
export function extractTrackingSessionId(customSource: string | null | undefined): string | null {
  const value = sanitizeUtmSource(customSource)
  if (!value || !value.includes('__')) return null
  const sessionId = value.split('__')[1]?.trim()
  return sessionId && SESSION_ID_RE.test(sessionId) ? sessionId : null
}
