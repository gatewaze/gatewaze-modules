/**
 * Put a file the browser has made beside the photograph it belongs to.
 *
 * The server chooses the path, inside the photograph's own folder, and
 * signs an upload into whichever store the photograph is in
 * (api/media-upload-url.ts). The browser then PUTs the bytes there with
 * exactly the headers it was given. Returns the stored path, which the
 * caller hands to the route that records it.
 */
export async function uploadBeside(
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>,
  eventId: string,
  mediaId: string,
  name: string,
  blob: Blob,
): Promise<string> {
  const contentType = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const minted = await authedFetch(`/api/admin/events/${eventId}/media/${mediaId}/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ name, content_type: contentType, bytes: blob.size }),
  });
  if (!minted.ok) {
    const body = await minted.json().catch(() => null);
    throw new Error(body?.message ?? 'could not prepare the upload');
  }
  const { storage_path, upload_url, upload_headers } = (await minted.json()) as {
    storage_path: string; upload_url: string; upload_headers?: Record<string, string>;
  };
  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: upload_headers && Object.keys(upload_headers).length ? upload_headers : { 'Content-Type': contentType },
    body: blob,
  });
  if (!put.ok) throw new Error(`upload failed (${put.status})`);
  return storage_path;
}
