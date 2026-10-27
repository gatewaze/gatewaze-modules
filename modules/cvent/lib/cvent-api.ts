/**
 * Cvent REST API client (Node).
 *
 * Covers the calls needed to register an attendee for on-site badge printing:
 *   1. findOrCreateContact  – upsert a person by email via GET/POST /contacts
 *                             (deleted contacts in the search result are skipped)
 *   2. addAttendee          – register the contact via POST /attendees
 *   3. listAdmissionItems   – populates the admin dropdown
 *   4. updateContact        – push badge-field changes for an existing contact
 *
 * Reference: https://developers.cvent.com/docs/rest-api/guides/registration-guide
 *
 * Every failure result carries `transient`: true when the problem is Cvent or
 * the connection (OAuth rejected, 429 after retries, 5xx, timeout) rather than
 * this registrant. The sync lib stops the batch on a transient failure instead
 * of recording an attempt against each registration.
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
  /** Per-request timeout; a hung Cvent connection must not hold a worker slot (default 15s). */
  timeoutMs?: number;
  /**
   * Shared token store. Pass one kept at module scope so a token outlives a
   * single client (one worker run, one admin request); without it every
   * client fetches its own. Keyed by client id, so two credentials never mix.
   */
  tokenCache?: TokenCache;
}

export interface TokenCache {
  get(clientId: string): { token: string; expiresAt: number } | undefined;
  set(clientId: string, entry: { token: string; expiresAt: number }): void;
}

export function createTokenCache(): TokenCache {
  const m = new Map<string, { token: string; expiresAt: number }>();
  return { get: (id) => m.get(id), set: (id, e) => void m.set(id, e) };
}

export interface CventAdmissionItem {
  id: string;
  name: string;
  code?: string;
}

export interface CventSyncResult {
  success: boolean;
  error?: string;
  /** Failure was Cvent-wide or network, not this registrant; do not count an attempt. */
  transient?: boolean;
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
  transient: boolean;
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

/** 429 after retries, any 5xx, or no HTTP response at all. */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function first<T>(v: T | T[]): T {
  return Array.isArray(v) ? v[0] : v;
}

function localPart(email: string): string {
  return email.split('@')[0] || email;
}

export interface CventClient {
  listAdmissionItems(cventEventId: string): Promise<{ success: boolean; error?: string; transient?: boolean; items?: CventAdmissionItem[] }>;
  syncRegistrant(cventEventId: string, admissionItemId: string, fields: BadgeFields): Promise<CventSyncResult>;
  /** Pass the known Cvent contact id when the ledger has one; the email lookup is the fallback. */
  updateContact(fields: BadgeFields, contactId?: string | null): Promise<CventSyncResult>;
}

export function createCventClient(opts: CventClientOptions): CventClient {
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signal = () => AbortSignal.timeout(timeoutMs);

  // Token cache: the shared one when given, else for the life of this client.
  const tokens = opts.tokenCache ?? createTokenCache();

  async function getToken(): Promise<string> {
    const now = Date.now();
    const cached = tokens.get(opts.clientId);
    if (cached && now < cached.expiresAt - 30_000) return cached.token;

    const credentials = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&client_id=${encodeURIComponent(opts.clientId)}`,
      signal: signal(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cvent OAuth failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('Cvent OAuth response had no access_token');
    tokens.set(opts.clientId, { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  }

  async function call(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<CventResponse> {
    const token = await getToken();
    // Cvent's API gateway caps total header size at 10,240 bytes and their
    // OAuth JWT embeds every scope claim, so headers stay minimal.
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';

    // Log the path without its query string: contact lookups filter by email.
    const shownPath = path.split('?')[0];
    for (let attempt = 0; ; attempt++) {
      log(`Cvent ${method} ${shownPath}${attempt ? ` (retry ${attempt})` : ''}`);
      let res: Response;
      try {
        res = await fetchImpl(`${CVENT_BASE}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: signal(),
        });
      } catch (err) {
        // Timeout or network failure: no HTTP status, treated as transient.
        return { ok: false, status: 0, transient: true, data: { raw: `request failed: ${(err as Error).message}` } };
      }

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

      return { ok: res.ok, status: res.status, transient: isTransientStatus(res.status), data };
    }
  }

  async function findContact(email: string) {
    const filter = encodeURIComponent(`email eq ${filterLiteral(email)}`);
    return call(`/contacts?filter=${filter}`, 'GET');
  }

  /**
   * The first usable contact in a search result. Cvent keeps deleted contacts
   * in the address book and the email filter still returns them, oldest first,
   * so an address that was deleted and re-added comes back as two rows with
   * the dead one in front. Registering the dead one fails with
   * EntityNotFound/Contact, so only a live row counts as a match.
   */
  function liveContact(searchData: unknown): Record<string, unknown> | null {
    const rows = (searchData as { data?: unknown } | null)?.data;
    if (!Array.isArray(rows)) return null;
    const hit = rows.find((c) => c && typeof c.id === 'string' && c.deleted !== true);
    return (hit as Record<string, unknown> | undefined) ?? null;
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

  function fieldsChanged(existing: Record<string, unknown>, f: BadgeFields): boolean {
    return Boolean(
      (f.firstName && f.firstName !== existing.firstName) ||
        (f.lastName && f.lastName !== existing.lastName) ||
        (f.title && f.title !== existing.title) ||
        (f.company && f.company !== existing.company),
    );
  }

  async function findOrCreateContact(f: BadgeFields): Promise<{ success: boolean; error?: string; transient?: boolean; contactId?: string }> {
    const searchRes = await findContact(f.email);
    if (!searchRes.ok) {
      return {
        success: false,
        transient: searchRes.transient,
        error: `GET /contacts failed (${searchRes.status}): ${JSON.stringify(searchRes.data)}`,
      };
    }

    const existing = liveContact(searchRes.data);
    if (existing) {
      const id = existing.id as string;
      if (fieldsChanged(existing, f)) {
        const upd = await call(`/contacts/${encodeURIComponent(id)}`, 'PUT', contactBody(id, existing, f));
        if (!upd.ok) log(`Cvent contact ${id} update failed (${upd.status}); continuing with registration`);
      }
      return { success: true, contactId: id };
    }

    // Bulk endpoint: array in, 207 with per-item status out.
    const createRes = await call('/contacts', 'POST', [contactBody(undefined, null, f)]);
    const created = first(createRes.data);
    if (created?.status >= 400 || (!createRes.ok && createRes.status !== 207)) {
      const status = typeof created?.status === 'number' ? created.status : createRes.status;
      return {
        success: false,
        transient: createRes.transient || isTransientStatus(status),
        error: `POST /contacts failed (${status}): ${JSON.stringify(created?.data ?? createRes.data)}`,
      };
    }
    const contactId = created?.data?.id as string | undefined;
    if (!contactId) return { success: false, error: 'POST /contacts returned no contact id' };
    return { success: true, contactId };
  }

  /** True when Cvent already lists this contact as an attendee of the event. */
  async function attendeeExists(cventEventId: string, contactId: string): Promise<boolean | null> {
    const filter = encodeURIComponent(`event.id eq ${filterLiteral(cventEventId)} and contact.id eq ${filterLiteral(contactId)}`);
    const res = await call(`/attendees?filter=${filter}`, 'GET');
    if (!res.ok) return null;
    const rows = res.data?.data ?? res.data;
    return Array.isArray(rows) && rows.length > 0;
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

    // Already registered comes back as a 409, or a 400 EntityAlreadyExists.
    const code = item?.data?.code;
    if (item?.status === 409 || res.status === 409 || (item?.status === 400 && code === 'EntityAlreadyExists')) {
      return { success: true, contactId, action: 'already_exists' };
    }

    // The old client took a 400 ServerError as "already registered" too. It
    // usually is, but a real server error would then be recorded as synced
    // with no badge, so confirm with a lookup before saying so.
    if (item?.status === 400 && code === 'ServerError') {
      const exists = await attendeeExists(cventEventId, contactId);
      if (exists === true) return { success: true, contactId, action: 'already_exists' };
      return {
        success: false,
        transient: true,
        error: `POST /attendees returned ServerError and the attendee lookup ${exists === null ? 'failed' : 'found nothing'}: ${JSON.stringify(item?.data)}`,
      };
    }

    const status = typeof item?.status === 'number' ? item.status : res.status;
    return {
      success: false,
      transient: res.transient || isTransientStatus(status),
      error: `POST /attendees failed (${status}): ${JSON.stringify(item?.data ?? res.data)}`,
    };
  }

  // Thrown errors reach here only from getToken (OAuth) or a bug; both are
  // Cvent-wide, so they are transient from the sync's point of view.
  function thrown(err: unknown): CventSyncResult {
    return { success: false, transient: true, error: (err as Error).message };
  }

  return {
    async listAdmissionItems(cventEventId) {
      try {
        const filter = encodeURIComponent(`event.id eq ${filterLiteral(cventEventId)}`);
        const res = await call(`/admission-items?filter=${filter}`, 'GET');
        if (!res.ok) {
          return { success: false, transient: res.transient, error: `Failed to list admission items (${res.status}): ${JSON.stringify(res.data)}` };
        }
        const raw = (res.data?.data ?? res.data ?? []) as Array<Record<string, unknown>>;
        const items = (Array.isArray(raw) ? raw : [])
          .filter((i) => typeof i?.id === 'string')
          .map((i) => ({ id: i.id as string, name: String(i.name ?? i.id), code: typeof i.code === 'string' ? i.code : undefined }));
        return { success: true, items };
      } catch (err) {
        return thrown(err);
      }
    },

    async syncRegistrant(cventEventId, admissionItemId, fields) {
      try {
        const contact = await findOrCreateContact(fields);
        if (!contact.success || !contact.contactId) {
          return { success: false, transient: contact.transient, error: contact.error };
        }
        const attendee = await addAttendee(cventEventId, contact.contactId, admissionItemId);
        return { ...attendee, contactId: contact.contactId };
      } catch (err) {
        return thrown(err);
      }
    },

    async updateContact(fields, contactId) {
      try {
        let id = contactId ?? null;
        let existing: Record<string, unknown> | null = null;
        if (!id) {
          const searchRes = await findContact(fields.email);
          if (!searchRes.ok) {
            return { success: false, transient: searchRes.transient, error: `GET /contacts failed (${searchRes.status}): ${JSON.stringify(searchRes.data)}` };
          }
          existing = liveContact(searchRes.data);
          id = (existing?.id as string | undefined) ?? null;
          if (!id) return { success: false, error: `Contact not found in Cvent for ${fields.email}` };
        }
        const res = await call(`/contacts/${encodeURIComponent(id)}`, 'PUT', contactBody(id, existing, fields));
        if (!res.ok) {
          return { success: false, transient: res.transient, error: `PUT /contacts/${id} failed (${res.status}): ${JSON.stringify(res.data)}` };
        }
        return { success: true, contactId: id, action: 'updated' };
      } catch (err) {
        return thrown(err);
      }
    },
  };
}
