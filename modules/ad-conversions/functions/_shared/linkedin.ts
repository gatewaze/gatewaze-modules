/**
 * LinkedIn Conversions API payload helpers.
 *
 * Pure functions, kept out of the edge function so they can be unit tested.
 * Reference: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api
 *
 *   POST https://api.linkedin.com/rest/conversionEvents
 *   headers: Authorization: Bearer, LinkedIn-Version: YYYYMM, X-Restli-Protocol-Version: 2.0.0
 *   body: { conversion, conversionHappenedAt (ms), conversionValue?, user: { userIds[] }, eventId }
 *
 * LinkedIn requires at least one of SHA256_EMAIL, LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID
 * (the li_fat_id click id) or PLAINTEXT_IP_ADDRESS, and rejects events older than 90 days.
 */

export const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest'
export const LINKEDIN_DEFAULT_API_VERSION = '202610'
export const LINKEDIN_MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000

export interface LinkedInConfig {
  /** Numeric conversion rule id, or a full urn:lla:llaPartnerConversion:<id>. */
  conversion_id: string
  access_token: string
  /** Optional separate rule for paid registrations. */
  purchase_conversion_id?: string
  /** LinkedIn-Version header, YYYYMM. */
  api_version?: string
}

export interface LinkedInUserId {
  idType: 'SHA256_EMAIL' | 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID' | 'PLAINTEXT_IP_ADDRESS'
  idValue: string
}

export interface LinkedInConversionEvent {
  conversion: string
  conversionHappenedAt: number
  conversionValue?: { currencyCode: string; amount: string }
  user: { userIds: LinkedInUserId[] }
  eventId: string
}

/** Accept a bare rule id or a full URN and return the URN. */
export function toConversionUrn(idOrUrn: string): string {
  const v = idOrUrn.trim()
  if (v.startsWith('urn:lla:llaPartnerConversion:')) return v
  return `urn:lla:llaPartnerConversion:${v}`
}

/**
 * Which rule to send to. A purchase rule is used only when configured and the
 * registration carried a payment; otherwise the default rule.
 */
export function pickConversionUrn(config: LinkedInConfig, amountPaid: number | null | undefined): string {
  const paid = typeof amountPaid === 'number' && amountPaid > 0
  if (paid && config.purchase_conversion_id) return toConversionUrn(config.purchase_conversion_id)
  return toConversionUrn(config.conversion_id)
}

/** Build the user identifier list. Only identifiers we actually hold are sent. */
export function buildUserIds(params: {
  hashedEmail: string
  liFatId?: string | null
  ipAddress?: string | null
}): LinkedInUserId[] {
  const ids: LinkedInUserId[] = [{ idType: 'SHA256_EMAIL', idValue: params.hashedEmail }]
  if (params.liFatId) ids.push({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: params.liFatId })
  if (params.ipAddress) ids.push({ idType: 'PLAINTEXT_IP_ADDRESS', idValue: params.ipAddress })
  return ids
}

/**
 * Build one conversion event. `happenedAt` is clamped into LinkedIn's 90 day
 * window and never set in the future (clock skew between Luma and us).
 */
export function buildConversionEvent(params: {
  config: LinkedInConfig
  happenedAt: Date
  now?: Date
  eventId: string
  userIds: LinkedInUserId[]
  amountPaid?: number | null
  currency?: string | null
}): LinkedInConversionEvent {
  const now = params.now ?? new Date()
  let ts = params.happenedAt.getTime()
  if (!Number.isFinite(ts) || ts > now.getTime()) ts = now.getTime()
  if (ts < now.getTime() - LINKEDIN_MAX_EVENT_AGE_MS) ts = now.getTime() - LINKEDIN_MAX_EVENT_AGE_MS + 60_000

  const event: LinkedInConversionEvent = {
    conversion: pickConversionUrn(params.config, params.amountPaid),
    conversionHappenedAt: ts,
    user: { userIds: params.userIds },
    eventId: params.eventId,
  }

  if (typeof params.amountPaid === 'number' && params.amountPaid > 0) {
    event.conversionValue = {
      currencyCode: (params.currency || 'USD').toUpperCase(),
      amount: params.amountPaid.toFixed(2),
    }
  }

  return event
}

export function linkedInHeaders(config: LinkedInConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.access_token}`,
    'Content-Type': 'application/json',
    'LinkedIn-Version': config.api_version || LINKEDIN_DEFAULT_API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  }
}
