/**
 * Just enough Google Drive to read a Takeout folder.
 *
 * Two ways in, tried in this order:
 *
 *   1. A service account, from VIDEO_DRIVE_SERVICE_ACCOUNT_JSON (the key file
 *      Google gives you, as one JSON string). The operator shares the Takeout
 *      folder with the service account's email and nothing else is needed.
 *      The token exchange is a signed JWT, done here with node:crypto rather
 *      than google-auth-library, because this is the only Google call the
 *      module makes and the library is 40 transitive packages.
 *   2. An OAuth refresh token, from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 *      GOOGLE_REFRESH_TOKEN, the same names the newsletter Google Docs import
 *      uses, so a brand that already has those set needs nothing new.
 *
 * Read-only scope in both cases. The importer never writes to Drive.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** The parent folder's id, so a nested Takeout layout can be walked. */
  parent: string | null;
}

export interface DriveAuth {
  token(): Promise<string>;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Service-account auth, or null when the env does not carry one. */
export function serviceAccountAuth(env: Record<string, string | undefined> = process.env): DriveAuth | null {
  const raw = env.VIDEO_DRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let sa: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error('VIDEO_DRIVE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('VIDEO_DRIVE_SERVICE_ACCOUNT_JSON needs client_email and private_key');
  }
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async token() {
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = b64url(JSON.stringify({
        iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600,
      }));
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key as string))}`;
      const res = await fetch(sa.token_uri ?? TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      });
      if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
      const j = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new Error('Google token exchange returned no access token');
      cached = { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
      return cached.token;
    },
  };
}

/** OAuth refresh-token auth, or null when the three values are not all set. */
export function refreshTokenAuth(env: Record<string, string | undefined> = process.env): DriveAuth | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async token() {
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
        }),
      });
      if (!res.ok) throw new Error(`Google token refresh failed: HTTP ${res.status}`);
      const j = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new Error('Google token refresh returned no access token');
      cached = { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
      return cached.token;
    },
  };
}

export function driveAuthFromEnv(env: Record<string, string | undefined> = process.env): DriveAuth | null {
  return serviceAccountAuth(env) ?? refreshTokenAuth(env);
}

/** A Drive file or folder id as Google issues them; anything else is refused before it reaches a URL. */
export function assertDriveId(id: unknown): string {
  const s = String(id ?? '');
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(s)) throw new Error('not a Drive id');
  return s;
}

/**
 * Every file under a folder, recursively, with page handling.
 *
 * Shared drives included (`supportsAllDrives`), because a Takeout delivered
 * to a Workspace account often lands in one. Google Docs-native types have no
 * bytes and are skipped.
 */
export async function listFolder(auth: DriveAuth, folderId: string, maxFiles = 2000): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  const queue = [assertDriveId(folderId)];
  while (queue.length && out.length < maxFiles) {
    const parent = queue.shift() as string;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${parent}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
        pageSize: '200',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`${DRIVE}/files?${params}`, { headers: { Authorization: `Bearer ${await auth.token()}` } });
      if (!res.ok) throw new Error(`Drive list failed: HTTP ${res.status}`);
      const j = (await res.json()) as {
        nextPageToken?: string;
        files?: Array<{ id: string; name: string; mimeType: string; size?: string; parents?: string[] }>;
      };
      for (const f of j.files ?? []) {
        // Google issues these ids, but they go back into URLs and a query, so
        // they are held to the same shape as the one the operator gave.
        let id: string;
        try {
          id = assertDriveId(f.id);
        } catch {
          continue;
        }
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          queue.push(id);
        } else if (!f.mimeType.startsWith('application/vnd.google-apps.')) {
          out.push({ id, name: f.name, mimeType: f.mimeType, size: Number(f.size ?? 0), parent: f.parents?.[0] ?? null });
        }
        if (out.length >= maxFiles) break;
      }
      pageToken = j.nextPageToken;
    } while (pageToken && out.length < maxFiles);
  }
  return out;
}

/** The whole file as text. For the small metadata CSVs only; refuses anything over the cap. */
export async function readText(auth: DriveAuth, fileId: string, maxBytes = 5 * 1024 * 1024): Promise<string> {
  const res = await fetch(`${DRIVE}/files/${assertDriveId(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${await auth.token()}` },
  });
  if (!res.ok || !res.body) throw new Error(`Drive read failed: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error('file too large to read as text');
  // Read through the cap rather than buffering first and measuring after: a
  // missing content-length must not mean an unbounded read.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('file too large to read as text');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The file's bytes as a stream, for piping straight into storage. */
export async function openStream(auth: DriveAuth, fileId: string): Promise<{ body: ReadableStream; contentType: string; bytes: number }> {
  const res = await fetch(`${DRIVE}/files/${assertDriveId(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${await auth.token()}` },
  });
  if (!res.ok || !res.body) throw new Error(`Drive download failed: HTTP ${res.status}`);
  return {
    body: res.body,
    contentType: String(res.headers.get('content-type') ?? '').split(';')[0].trim(),
    bytes: Number(res.headers.get('content-length') ?? 0),
  };
}
