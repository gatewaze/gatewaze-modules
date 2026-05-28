/**
 * Cvent REST API client
 *
 * Handles OAuth token management and the API calls needed to register
 * an attendee:
 *   1. findOrCreateContact  – upsert a person by email via GET/POST /contacts
 *   2. addAttendee          – register the contact via POST /attendees
 *   3. listAdmissionItems   – used by the admin UI to populate the dropdown
 *
 * Reference: https://developers.cvent.com/docs/rest-api/guides/registration-guide
 *
 * Credentials are expected as environment variables:
 *   CVENT_CLIENT_ID
 *   CVENT_CLIENT_SECRET
 */

const CVENT_BASE = 'https://api-platform.cvent.com/ea'
const TOKEN_URL = `${CVENT_BASE}/oauth2/token`

// ---------------------------------------------------------------------------
// Token cache (per-isolate, reused across requests in the same Edge runtime)
// ---------------------------------------------------------------------------
let _cachedToken: string | null = null
let _tokenExpiresAt = 0

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now()
  if (_cachedToken && now < _tokenExpiresAt - 30_000) {
    return _cachedToken
  }

  const credentials = btoa(`${clientId}:${clientSecret}`)
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}`,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cvent OAuth failed (${res.status}): ${text}`)
  }

  const json = await res.json()
  _cachedToken = json.access_token as string
  // expires_in is in seconds; default to 3600 if missing
  _tokenExpiresAt = now + (json.expires_in ?? 3600) * 1000
  console.log(`Cvent OAuth token obtained | length: ${_cachedToken!.length} | token_type: ${json.token_type} | token_format: ${json.token_type === 'Bearer' ? 'JWT' : 'opaque'}`)
  return _cachedToken!
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cventFetch(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  token: string,
  body?: unknown,
  retries = 3
): Promise<{ ok: boolean; status: number; data: any }> {
  // NOTE: Cvent's API Gateway has a 10,240-byte total header limit. Their OAuth
  // JWT embeds scope claims making the token large. We keep headers minimal.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    console.log(`Cvent API ${method} ${path} | token length: ${token.length}${attempt > 0 ? ` | retry ${attempt}` : ''}`)

    const res = await fetch(`${CVENT_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    // Retry on 429 with exponential backoff
    if (res.status === 429 && attempt < retries) {
      const waitMs = (attempt + 1) * 2000 // 2s, 4s, 6s
      console.log(`Cvent API 429 rate limited — waiting ${waitMs}ms before retry`)
      await new Promise(r => setTimeout(r, waitMs))
      continue
    }

    let data: any = null
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }

    // 413 = Cvent's API Gateway rejects the request because the OAuth JWT
    // exceeds its 10,240-byte total header limit.
    if (res.status === 413) {
      let scopeCount = 'unknown'
      try {
        const parts = token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
          const scp = payload.scp
          scopeCount = String(Array.isArray(scp) ? scp.length : scp ? 1 : 0)
        }
      } catch { /* ignore */ }
      data = {
        raw: `Cvent API Gateway header size limit exceeded. The OAuth token has ${scopeCount} scope `
          + `claims making it ${token.length} bytes — too large for their infrastructure. `
          + 'Please contact Cvent support and ask them to increase their API Gateway header '
          + 'size limit or configure shorter tokens for this OAuth client.',
      }
    }

    return { ok: res.ok, status: res.status, data }
  }

  // Should not reach here, but just in case
  return { ok: false, status: 429, data: { message: 'Rate limited after retries' } }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CventAdmissionItem {
  id: string
  name: string
  code?: string
}

export interface CventSyncResult {
  success: boolean
  error?: string
  contactId?: string
  attendeeId?: string
  action?: 'created' | 'already_exists' | 'updated'
}

/**
 * Find an existing Cvent contact by email, or create one if not found.
 * Uses GET /contacts with filter, then POST /contacts if needed.
 */
async function findOrCreateContact(
  token: string,
  email: string,
  firstName?: string,
  lastName?: string,
  title?: string,
  company?: string
): Promise<{ success: boolean; error?: string; contactId?: string }> {
  // Search for existing contact by email
  const filter = encodeURIComponent(`email eq '${email}'`)
  const searchRes = await cventFetch(`/contacts?filter=${filter}`, 'GET', token)

  console.log(`GET /contacts response: status=${searchRes.status} ok=${searchRes.ok} data=${JSON.stringify(searchRes.data)?.substring(0, 500)}`)

  if (!searchRes.ok) {
    return {
      success: false,
      error: `GET /contacts failed (${searchRes.status}): ${JSON.stringify(searchRes.data)}`,
    }
  }

  if (searchRes.data?.data?.length > 0) {
    const contact = searchRes.data.data[0]
    // Always update contact with latest info
    const updates: Record<string, string> = {}
    if (firstName && firstName !== contact.firstName) updates.firstName = firstName
    if (lastName && lastName !== contact.lastName) updates.lastName = lastName
    if (title && title !== contact.title) updates.title = title
    if (company && company !== contact.company) updates.company = company

    if (Object.keys(updates).length > 0) {
      console.log(`Updating Cvent contact ${contact.id} with: ${JSON.stringify(updates)}`)
      await cventFetch(`/contacts/${contact.id}`, 'PUT', token, {
        id: contact.id,
        email,
        firstName: firstName || contact.firstName || '',
        lastName: lastName || contact.lastName || '',
        ...(title ? { title } : {}),
        ...(company ? { company } : {}),
      })
    }
    return { success: true, contactId: contact.id }
  }

  // Create new contact — Cvent bulk endpoint expects an array
  // Cvent requires lastName for attendee registration; fall back to first name or email prefix
  const contactData: Record<string, string> = {
    email,
    firstName: firstName || email.split('@')[0],
    lastName: lastName || firstName || email.split('@')[0],
  }
  if (title) contactData.title = title
  if (company) contactData.company = company
  const createRes = await cventFetch('/contacts', 'POST', token, [contactData])

  // Bulk endpoint returns 207 with per-item status
  const created = Array.isArray(createRes.data) ? createRes.data[0] : createRes.data
  if (created?.status >= 400 || (!createRes.ok && createRes.status !== 207)) {
    return {
      success: false,
      error: `POST /contacts failed (${created?.status ?? createRes.status}): ${JSON.stringify(created?.data ?? createRes.data)}`,
    }
  }

  return { success: true, contactId: created?.data?.id }
}

/**
 * Register a contact as an attendee for a Cvent event.
 * Uses POST /attendees per the registration guide.
 * Idempotent – returns success even if already registered.
 */
async function addAttendee(
  token: string,
  cventEventId: string,
  contactId: string,
  admissionItemId: string
): Promise<CventSyncResult> {
  // Cvent bulk endpoint expects an array; field is "status" not "registrationStatus"
  const res = await cventFetch('/attendees', 'POST', token, [{
    event: { id: cventEventId },
    contact: { id: contactId },
    admissionItem: { id: admissionItemId },
    status: 'Accepted',
  }])

  // Bulk endpoint returns 207 with per-item status
  const item = Array.isArray(res.data) ? res.data[0] : res.data

  if (item?.status === 200 || item?.status === 201) {
    return { success: true, contactId, attendeeId: item?.data?.id, action: 'created' }
  }

  // Already registered (various Cvent error shapes) — treat as success
  const alreadyExists = item?.status === 409 || res.status === 409
    || (item?.status === 400 && (
      item?.data?.code === 'EntityAlreadyExists'
      || item?.data?.code === 'ServerError' // generic error when contact already has registration
    ))
  if (alreadyExists) {
    return { success: true, contactId, action: 'already_exists' }
  }

  return {
    success: false,
    error: `POST /attendees failed (${item?.status ?? res.status}): ${JSON.stringify(item?.data ?? res.data)}`,
  }
}

/**
 * List admission items for a Cvent event (for the admin UI dropdown).
 */
export async function listAdmissionItems(
  clientId: string,
  clientSecret: string,
  cventEventId: string
): Promise<{ success: boolean; error?: string; items?: CventAdmissionItem[] }> {
  let token: string
  try {
    token = await getToken(clientId, clientSecret)
  } catch (err: any) {
    return { success: false, error: err.message }
  }

  const filter = encodeURIComponent(`event.id eq '${cventEventId}'`)
  const res = await cventFetch(`/admission-items?filter=${filter}`, 'GET', token)

  if (!res.ok) {
    return {
      success: false,
      error: `Failed to list admission items (${res.status}): ${JSON.stringify(res.data)}`,
    }
  }

  const items = (res.data?.data ?? res.data ?? []) as CventAdmissionItem[]
  return { success: true, items }
}

/**
 * Sync a single registrant to Cvent.
 * Full flow: get token → find/create contact → register as attendee.
 */
export async function syncRegistrantToCvent(
  clientId: string,
  clientSecret: string,
  cventEventId: string,
  admissionItemId: string,
  email: string,
  firstName?: string,
  lastName?: string,
  title?: string,
  company?: string
): Promise<CventSyncResult> {
  let token: string
  try {
    token = await getToken(clientId, clientSecret)
  } catch (err: any) {
    return { success: false, error: err.message }
  }

  const contactResult = await findOrCreateContact(token, email, firstName, lastName, title, company)
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: contactResult.error }
  }

  const attendeeResult = await addAttendee(token, cventEventId, contactResult.contactId, admissionItemId)
  return { ...attendeeResult, contactId: contactResult.contactId }
}

/**
 * Update an existing Cvent contact's details (no attendee registration).
 * Used for real-time sync when customer attributes change.
 */
export async function updateCventContact(
  clientId: string,
  clientSecret: string,
  email: string,
  firstName?: string,
  lastName?: string,
  title?: string,
  company?: string
): Promise<{ success: boolean; error?: string; contactId?: string }> {
  let token: string
  try {
    token = await getToken(clientId, clientSecret)
  } catch (err: any) {
    return { success: false, error: err.message }
  }

  // Search for existing contact by email
  const filter = encodeURIComponent(`email eq '${email}'`)
  const searchRes = await cventFetch(`/contacts?filter=${filter}`, 'GET', token)

  if (!searchRes.ok || !searchRes.data?.data?.length) {
    return { success: false, error: `Contact not found in Cvent for ${email}` }
  }

  const contact = searchRes.data.data[0]

  // Update contact with latest info
  const updateBody: Record<string, string> = {
    id: contact.id,
    email,
    firstName: firstName || contact.firstName || '',
    lastName: lastName || contact.lastName || firstName || email.split('@')[0],
  }
  if (title) updateBody.title = title
  if (company) updateBody.company = company

  const updateRes = await cventFetch(`/contacts/${contact.id}`, 'PUT', token, updateBody)

  if (!updateRes.ok) {
    return {
      success: false,
      error: `PUT /contacts/${contact.id} failed (${updateRes.status}): ${JSON.stringify(updateRes.data)}`,
    }
  }

  console.log(`Updated Cvent contact ${contact.id} for ${email}`)
  return { success: true, contactId: contact.id }
}
