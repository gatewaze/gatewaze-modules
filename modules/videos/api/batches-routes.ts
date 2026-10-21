// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * Upload batches, on the operator-only imports router
 * (/api/modules/videos/imports/batches).
 *
 * Create mints the key and returns the connection bundle ONCE. The row keeps
 * the key id only, so nothing here can hand the key out a second time; a
 * lost key means a new batch. Close deletes the key.
 */

import type { Request, Response, Router } from 'express';
import { createBatchKey, deleteKey, b2KeysConfigured, batchDays } from '../lib/b2-keys.js';
import { batchPrefix, connectionBundle } from '../lib/batches.js';
import { s3SettingsFromEnv } from '../lib/storage.js';
import { mediaUrl } from '../lib/studio-media.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface BatchesDeps {
  supabase: { from(t: string): any; storage: any };
  callerId: (req: Request) => Promise<string | null>;
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
}

/** The fields a create may set, cleaned. Null when the label is missing. */
export function sanitiseBatchInput(body: Record<string, unknown>): { label: string; eventId: string | null; name: string | null; email: string | null; days: number } | null {
  const label = String(body.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!label) return null;
  const eventId = typeof body.event_id === 'string' && UUID_RE.test(body.event_id) ? body.event_id.toLowerCase() : null;
  const name = String(body.issued_to_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  const emailRaw = String(body.issued_to_email ?? '').trim().toLowerCase().slice(0, 200);
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
  return { label, eventId, name, email, days: batchDays(body.days) };
}

export function mountBatchesRoutes(router: Router, deps: BatchesDeps): void {
  const { supabase, callerId, enqueueJob, logger } = deps;

  router.get('/', async (_req: Request, res: Response) => {
    const { data, error } = await supabase
      .from('video_upload_batches')
      .select('id, label, event_id, prefix, state, issued_to_name, issued_to_email, key_expires_at, objects_seen, adopted, flags, last_synced_at, created_at, closed_at')
      .order('created_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ batches: data ?? [], configured: b2KeysConfigured() && s3SettingsFromEnv() !== null });
  });

  router.post('/', async (req: Request, res: Response) => {
    const s3 = s3SettingsFromEnv();
    if (!s3) return res.status(503).json({ error: 'VIDEO_S3_* is not configured; batches need the S3 master store' });
    if (!b2KeysConfigured()) return res.status(503).json({ error: 'VIDEO_B2_KEY_ID / VIDEO_B2_KEY are not configured' });
    const input = sanitiseBatchInput((req.body ?? {}) as Record<string, unknown>);
    if (!input) return res.status(400).json({ error: 'label is required' });
    const uid = await callerId(req);

    // A user id for the person when the address belongs to an active admin
    // login, so their uploads carry uploaded_by like a browser upload would.
    // An exact match: the address is a value here, not a pattern.
    let issuedToUserId: string | null = null;
    if (input.email) {
      try {
        const { data: u } = await supabase.from('admin_profiles').select('user_id').eq('email', input.email).eq('is_active', true).limit(1).maybeSingle();
        if (u?.user_id) issuedToUserId = String(u.user_id);
      } catch { /* optional */ }
    }

    // The id is chosen here so the row is born with its final prefix; two
    // creates at once cannot collide on a placeholder.
    const id = globalThis.crypto.randomUUID();
    const prefix = batchPrefix(id);
    const ins = await supabase.from('video_upload_batches').insert({
      id, label: input.label, event_id: input.eventId, prefix, state: 'open',
      issued_to_name: input.name, issued_to_email: input.email, issued_to_user_id: issuedToUserId, created_by: uid,
    }).select('id').single();
    if (ins.error) return res.status(500).json({ error: ins.error.message });

    let minted;
    try {
      minted = await createBatchKey({ bucket: s3.bucket, prefix, days: input.days, name: `gatewaze-batch-${id.slice(0, 8)}` });
    } catch (err) {
      await supabase.from('video_upload_batches').delete().eq('id', id);
      logger.warn('could not mint a batch key', { error: String((err as Error)?.message ?? err) });
      return res.status(502).json({ error: 'could not create the upload key at Backblaze' });
    }
    // From here a live key exists. Anything that fails before the reply is
    // sent revokes it, so a key is never live without a row that knows it.
    try {
      const credentials = connectionBundle({ bucket: s3.bucket, prefix, keyId: minted.keyId, key: minted.key, endpoint: s3.endpoint, region: s3.region, label: input.label });
      const upd = await supabase.from('video_upload_batches')
        .update({ key_id: minted.keyId, key_expires_at: minted.expiresAt }).eq('id', id).select('*').single();
      if (upd.error) throw new Error(upd.error.message);
      logger.info('upload batch created', { batch: id, event: input.eventId, days: input.days });
      res.set('Cache-Control', 'no-store');
      // Once. The key is in this response and nowhere else.
      res.status(201).json({ batch: upd.data, credentials });
    } catch (err) {
      await deleteKey(minted.keyId);
      await supabase.from('video_upload_batches').delete().eq('id', id);
      logger.warn('batch create failed after minting; key revoked', { batch: id, error: String((err as Error)?.message ?? err) });
      res.status(500).json({ error: 'could not finish creating the batch; nothing was issued' });
    }
  });

  /** One batch with its videos, their masters and studio state. */
  router.get('/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid batch id' });
    const { data: batch } = await supabase.from('video_upload_batches').select('*').eq('id', id).maybeSingle();
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    const { data: assets } = await supabase
      .from('video_assets').select('id, video_id, filename, bytes, state, storage_path, created_at').eq('batch_id', id).order('created_at').limit(1000);
    const videoIds = [...new Set((assets ?? []).map((a) => String(a.video_id)))];
    let videos = []; let studios = []; let subjects = [];
    if (videoIds.length) {
      videos = (await supabase.from('videos').select('id, title, thumbnail_url, duration_seconds').in('id', videoIds)).data ?? [];
      studios = (await supabase.from('video_studio').select('id, video_id, state, progress, error, outputs, updated_at').in('video_id', videoIds)).data ?? [];
      subjects = (await supabase.from('video_subjects').select('video_id, subject_type, subject_id').in('video_id', videoIds)).data ?? [];
    }
    const url = (p: unknown) => (typeof p === 'string' && p ? mediaUrl(supabase, p) : null);
    res.json({
      batch,
      videos: videos.map((v) => {
        const st = studios.find((s) => s.video_id === v.id) ?? null;
        return {
          ...v,
          assets: (assets ?? []).filter((a) => a.video_id === v.id),
          subject: subjects.find((s) => s.video_id === v.id) ?? null,
          studio: st ? { id: st.id, state: st.state, progress: st.progress, error: st.error, thumbnail_url: url(st.outputs?.thumbnail_path) } : null,
        };
      }),
    });
  });

  /** Adopt what has landed, now rather than at the next tick. */
  router.post('/:id/sync', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid batch id' });
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const { data: batch } = await supabase.from('video_upload_batches').select('id, state').eq('id', id).maybeSingle();
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    if (batch.state !== 'open') return res.status(409).json({ error: `batch is ${batch.state}` });
    const job = await enqueueJob('jobs', 'videos:sync-batches', { batch_id: id }, { jobId: `videos-sync-batch-${id}-${Math.floor(Date.now() / 60_000)}` });
    res.status(202).json({ queued: true, job_id: job?.id ?? null });
  });

  /** Mark complete: the key is deleted; what has landed stays. */
  router.post('/:id/close', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid batch id' });
    const { data: batch } = await supabase.from('video_upload_batches').select('id, state, key_id').eq('id', id).maybeSingle();
    if (!batch) return res.status(404).json({ error: 'batch not found' });
    if (batch.state !== 'open') return res.json({ batch });
    // The key first. If Backblaze will not delete it now, the batch still
    // closes and the cron retries until key_revoked_at is set.
    const revoked = batch.key_id ? await deleteKey(String(batch.key_id)) : true;
    const upd = await supabase.from('video_upload_batches')
      .update({ state: 'closed', closed_at: new Date().toISOString(), ...(revoked ? { key_revoked_at: new Date().toISOString() } : {}) })
      .eq('id', id).eq('state', 'open').select('*').single();
    if (upd.error) return res.status(500).json({ error: upd.error.message });
    if (enqueueJob) {
      // One last sweep, in case a file landed between the last tick and now;
      // the worker sweeps a closed batch only when told it is the final one.
      await enqueueJob('jobs', 'videos:sync-batches', { batch_id: id, final: true }, { jobId: `videos-sync-batch-${id}-final-${Date.now()}` }).catch(() => {});
    }
    logger.info('upload batch closed', { batch: id, key_revoked: revoked });
    res.json({ batch: upd.data, key_revoked: revoked });
  });
}
