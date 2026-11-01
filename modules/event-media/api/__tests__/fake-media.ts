// @ts-nocheck — vitest harness.
/**
 * A MediaStorage for route tests: one in-memory store per location, whose
 * objects "exist" unless a test says they are missing. Records what was
 * put and removed, and builds recognisable addresses.
 */
export function fakeMedia(opts: { missing?: boolean; base?: string; unavailable?: boolean } = {}) {
  const base = opts.base ?? 'https://cdn.example';
  const state = { put: [], removed: [], headed: [], signed: [], rows: [] };
  const store = (provider = 'supabase', bucket = 'media') => ({
    provider,
    bucket,
    canResize: true,
    publicUrl: (p) => `${base}/${p}`,
    sizedUrl: (p, size) => `${base}/${p}?width=${size.width}`,
    put: async (path, body, o) => { state.put.push({ path, contentType: o.contentType, upsert: o.upsert }); return { bytes: body.byteLength }; },
    signUpload: async (path, o) => { state.signed.push({ path, ...o }); return { url: `${base}/upload/${path}`, method: 'PUT', headers: { 'content-type': o.contentType } }; },
    head: async (path) => { state.headed.push(path); return opts.missing ? { ok: false, bytes: 0, contentType: '' } : { ok: true, bytes: 1, contentType: 'image/jpeg' }; },
    remove: async (paths) => { state.removed.push(...paths); return { failed: [] }; },
  });
  const pair = (row) => {
    state.rows.push(row);
    if (opts.unavailable) throw new Error('provider unavailable');
    const s = store(row?.storage_provider || 'supabase', row?.storage_bucket || 'media');
    return { browser: s, direct: s };
  };
  const media = {
    forNew: async () => pair({}),
    forRow: async (row) => pair(row),
    columnsFor: (s) => (s.provider === 'supabase' && s.bucket === 'media' ? {} : { storage_provider: s.provider, storage_bucket: s.bucket }),
    forRows: async (rows) => (row) => { try { return pair(row); } catch { return null; } },
  };
  return { media, state };
}
