/**
 * Pure helpers for pasting/dropping screenshots into the "Report feedback" widget (issue #28).
 *
 * The widget uploads each image to the public `media` bucket and then sends its public URL with the
 * POST /issues body as `attachments: [{ url }]` — the SAME contract the Issues tab (IssuesView) and
 * the live-run chat already use (issues #7 / #16). The server (api/admin-routes.ts) validates every
 * URL against the SSRF allowlist (isAllowedAttachmentUrl) and reports `attachmentsDropped` so the
 * client can warn honestly instead of showing a silent success.
 *
 * These functions are extracted (rather than inlined in the widget) so the node-env vitest harness
 * can unit-test them without a DOM — the React wiring itself is verified manually.
 */

/** Max screenshot size accepted client-side. Mirrors the server's MAX_BYTES in lib/attachments.ts. */
export const FEEDBACK_MAX_BYTES = 15 * 1024 * 1024;

/** A screenshot pending or finished uploading to the `media` bucket. */
export interface PendingAttachment {
  key: string;
  name: string;
  url: string;        // '' until the upload resolves
  uploading: boolean;
}

/** Derive a filesystem-safe extension from a File's MIME type (e.g. `image/png` → `png`). */
export function extFromMime(mime: string): string {
  return (String(mime ?? '').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
}

/**
 * Storage path for a feedback screenshot in the public `media` bucket. Uses a dedicated
 * `se-feedback/` prefix (distinct from the Issues tab's `se-issues/` and chat's `se-runs/`) so the
 * three surfaces don't collide. Project id and extension are sanitised to keep the path safe.
 */
export function feedbackImagePath(projectId: string, key: string, ext: string): string {
  const safeProject = (String(projectId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')) || 'unknown';
  const safeExt = (String(ext ?? '').replace(/[^a-z0-9]/gi, '')) || 'png';
  return `se-feedback/${safeProject}/${key}.${safeExt}`;
}

/**
 * Client-side gate on a candidate screenshot. Non-images are silently ignored (`ok:false`, no
 * error); an oversized image returns a user-facing error string. Matches the Issues-tab behaviour.
 */
export function validateImageFile(file: { type?: string; size?: number } | null | undefined): { ok: boolean; error?: string } {
  if (!file || !(file.type ?? '').startsWith('image/')) return { ok: false };
  if ((file.size ?? 0) > FEEDBACK_MAX_BYTES) return { ok: false, error: 'image too large (max 15MB)' };
  return { ok: true };
}

/** The `attachments` array the POST /issues body expects — only fully-uploaded (url present) items. */
export function attachmentsPayload(atts: PendingAttachment[]): Array<{ url: string }> {
  return (atts ?? []).filter((a) => a && a.url).map((a) => ({ url: a.url }));
}

/**
 * Human warning when the server drops N attachment URLs (its SSRF allowlist rejected them). On a
 * localhost dev deploy the storage URL is `http://…localhost`, not https-reachable, so it's dropped
 * — expected locally, works in staging/production. Returns null when nothing was dropped.
 */
export function droppedAttachmentsWarning(dropped: number | undefined | null): string | null {
  if (!dropped || dropped <= 0) return null;
  return `${dropped} image(s) couldn't be attached — the storage URL isn't publicly reachable over https (expected on localhost; works in staging/production).`;
}
