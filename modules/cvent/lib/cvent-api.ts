/**
 * Cvent REST API client (Node).
 *
 * Covers the calls needed to register an attendee for on-site badge printing:
 *   1. findOrCreateContact  – upsert a person by email via GET/POST /contacts
 *   2. addAttendee          – register the contact via POST /attendees
 *   3. listAdmissionItems   – populates the admin dropdown
 *   4. updateContact        – push badge-field changes for an existing contact
 *
 * Reference: https://developers.cvent.com/docs/rest-api/guides/registration-guide
 *
 * `fetch` and `sleep` are injectable so the client is unit-testable without
 * the network. Nothing here touches the database.
 */

export const CVENT_BASE = 'https://api-platform.cvent.com/ea';
const TOKEN_URL = `${CVENT_BASE}/oauth2/token`;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CventClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Retries on HTTP 429 (default 3). */
  retries?: number;
}

export interface CventAdmissionItem {
  id: string;
  name: string;
  code?: string;
}

export interface CventSyncResult {
  success: boolean;
  error?: string;
  contactId?: string;
  attendeeId?: string;
  action?: 'created' | 'already_exists' | 'updated';
}

export interface BadgeFields {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
}

interface CventResponse {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cvent payloads are untyped JSON
  data: any;
}

/**
 * Quote a value for a Cvent filter expression (`email eq '<value>'`).
 * Single quotes are doubled, the only escape the filter grammar has, so an
 * email like o'brien@x.com cannot terminate the literal early.
 */
export function filterLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function first<T>(v: T | T[]): T {
  return Array.isArray(v) ? v[0] : v;
}

function localPart(email: string): string {
  return email.split('@')[0] || email;
}

export interface CventClient {
  listAdmissionItems(cventEventId: string): Promise<{ success: boolean; error?: string; items?: CventAdmissionItem[] }>;
  syncRegistrant(cventEventId: string, admissionItemId: string, fields: BadgeFields): Promise<CventSyncResult>;
  updateContact(fields: BadgeFields): Promise<{ success: boolean; error?: string; contactId?: string; action?: 'updated' | 'unchanged' }>;
}

export function createCventClient(opts: CventClientOptions): CventClient {
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const retries = opts.retries ?? 3;

  // Token cache for the life of this client (one worker run / one request).
  let cachedToken: string | null = null;
  let tokenExpiresAt = 0;

  async function getToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;

    const credentials = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(opts.clientId)}`,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cvent OAuth failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Cvent OAuth response had no access_token');
    cachedToken = json.access_token;
    tokenExpiresAt = now + (json.expires_in ?? 3600) * 1000;
    return cachedToken;
  }

  async function call(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<CventResponse> {
    const token = await getToken();
    // Cvent's API gateway caps total header size at 10,240 bytes and their
    // OAuth JWT embeds every scope claim, so headers stay minimal.
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      log(`Cvent ${method} ${path}${attempt ? ` (retry ${attempt})` : ''}`);
      const res = await fetchImpl(`${CVENT_BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 && attempt < retries) {
        await sleep((attempt + 1) * 2000);
        continue;
      }

      const text = await res.text();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Cvent JSON
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 500) };
      }

      if (res.status === 413) {
        // The gateway rejected the request because the OAuth token itself is
        // too large for its header limit; only Cvent support can fix that.
        data = {
          raw:
            `Cvent API gateway header size limit exceeded (token is ${token.length} bytes). ` +
            'Ask Cvent support to raise the gateway header limit or issue shorter tokens for this OAuth client.',
        };
      }

      return { ok: res.ok, status: res.status, data };
    }
  }

  async function findContact(email: string) {
    const filter = encodeURIComponent(`email eq ${filterLiteral(email)}`);
    return call(`/contacts?filter=${filter}`, 'GET');
  }

  function contactBody(contactId: string | undefined, existing: Record<string, unknown> | null, f: BadgeFields) {
    const body: Record<string, string> = {
      email: f.email,
      firstName: f.firstName || (existing?.firstName as string) || localPart(f.email),
      // Cvent requires a last name on attendees; fall back to the first name,
      // then the email local part, so a one-name registrant still gets a badge.
      lastName: f.lastName || (existing?.lastName as string) || f.firstName || localPart(f.email),
    };
    if (contactId) body.id = contactId;
    if (f.title) body.title = f.title;
    if (f.company) body.company = f.company;
    return body;
  }

  async function findOrCreateContact(f: BadgeFields): Promise<{ success: boolean; error?: string; contactId?: string }> {
    const searchRes = await findContact(f.email);
    if (!searchRes.ok) {
      return { success: false, error: `GET /contacts failed (${searchRes.status}): ${JSON.stringify(searchRes.data)}` };
    }

    const existing = searchRes.data?.data?.[0];
    if (existing?.id) {
      const changed =
        (f.firstName && f.firstName !== existing.firstName) ||
        (f.lastName && f.lastName !== existing.lastName) ||
        (f.title && f.title !== existing.title) ||
        (f.company && f.company !== existing.company);
      if (changed) {
        const upd = await call(`/contacts/${encodeURIComponent(existing.id)}`, 'PUT', contactBody(existing.id, existing, f));
        if (!upd.ok) log(`Cvent contact ${existing.id} update failed (${upd.status}); continuing with registration`);
      }
      return { success: true, contactId: existing.id as string };
    }

    // Bulk endpoint: array in, 207 with per-item status out.
    const createRes = await call('/contacts', 'POST', [contactBody(undefined, null, f)]);
    const created = first(createRes.data);
    if (created?.status >= 400 || (!createRes.ok && createRes.status !== 207)) {
      return {
        success: false,
        error: `POST /contacts failed (${created?.status ?? createRes.status}): ${JSON.stringify(created?.data ?? createRes.data)}`,
      };
    }
    const contactId = created?.data?.id as string | undefined;
    if (!contactId) return { success: false, error: 'POST /contacts returned no contact id' };
    return { success: true, contactId };
  }

  async function addAttendee(cventEventId: string, contactId: string, admissionItemId: string): Promise<CventSyncResult> {
    const res = await call('/attendees', 'POST', [
      {
        event: { id: cventEventId },
        contact: { id: contactId },
        admissionItem: { id: admissionItemId },
        status: 'Accepted',
      },
    ]);
    const item = first(res.data);

    if (item?.status === 200 || item?.status === 201) {
      return { success: true, contactId, attendeeId: item?.data?.id, action: 'created' };
    }

    // Already registered comes back in several shapes; all mean "done".
    const alreadyExists =
      item?.status === 409 ||
      res.status === 409 ||
      (item?.status === 400 && (item?.data?.code === 'EntityAlreadyExists' || item?.data?.code === 'ServerError'));
    if (alreadyExists) return { success: true, contactId, action: 'already_exists' };

    return {
      success: false,
      error: `POST /attendees failed (${item?.status ?? res.status}): ${JSON.stringify(item?.data ?? res.data)}`,
    };
  }

  return {
    async listAdmissionItems(cventEventId) {
      try {
        const filter = encodeURIComponent(`event.id eq ${filterLiteral(cventEventId)}`);
        const res = await call(`/admission-items?filter=${filter}`, 'GET');
        if (!res.ok) {
          return { success: false, error: `Failed to list admission items (${res.status}): ${JSON.stringify(res.data)}` };
        }
        const raw = (res.data?.data ?? res.data ?? []) as Array<Record<string, unknown>>;
        const items = (Array.isArray(raw) ? raw : [])
          .filter((i) => typeof i?.id === 'string')
          .map((i) => ({ id: i.id as string, name: String(i.name ?? i.id), code: typeof i.code === 'string' ? i.code : undefined }));
        return { success: true, items };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },

    async syncRegistrant(cventEventId, admissionItemId, fields) {
      try {
        const contact = await findOrCreateContact(fields);
        if (!contact.success || !contact.contactId) return { success: false, error: contact.error };
        const attendee = await addAttendee(cventEventId, contact.contactId, admissionItemId);
        return { ...attendee, contactId: contact.contactId };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },

    async updateContact(fields) {
      try {
        const searchRes = await findContact(fields.email);
        const existing = searchRes.data?.data?.[0];
        if (!searchRes.ok || !existing?.id) {
          return { success: false, error: `Contact not found in Cvent for ${fields.email}` };
        }
        const res = await call(`/contacts/${encodeURIComponent(existing.id)}`, 'PUT', contactBody(existing.id, existing, fields));
        if (!res.ok) {
          return { success: false, error: `PUT /contacts/${existing.id} failed (${res.status}): ${JSON.stringify(res.data)}` };
        }
        return { success: true, contactId: existing.id as string, action: 'updated' };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  };
}
