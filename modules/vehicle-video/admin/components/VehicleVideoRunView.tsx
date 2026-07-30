/**
 * Vehicle Video — run view. Two gates:
 *   GATE 1 (ready_for_review): style panel (character/knobs) + shot plan review
 *           (keep/drop, edit narration/camera) → Approve & generate.
 *   GATE 2 (clips_in_progress): per-shot clip review → approve / regenerate each.
 *   Finalize → voiceover + compose → final MP4 player + download.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Badge, Button, Input, Select, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  getRun,
  patchStyle,
  patchShots,
  rescript,
  approvePlan,
  generateShot,
  approveShot,
  regenerateShot,
  listPromoThemes,
  generatePromo,
  type PromoTheme,
  getBranding,
  uploadLogo,
  autopullLogo,
  updateWatermark,
  previewRun,
  finalizeRun,
  type Watermark,
  mediaUrl,
  ACTIVE_SCRIPT,
  ACTIVE_VIDEO,
  type Run,
  type Shot,
} from '../utils/vehicleVideoService';

const CHARACTERS = ['heritage', 'performance', 'executive', 'family', 'rugged', 'eco'];
const PACING = ['classic_slow', 'balanced', 'edgy_fast'];
const ENERGY = ['gentle', 'moderate', 'dynamic'];

export default function VehicleVideoRunView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loading, setLoading] = useState(true);
  // Shots the operator just clicked Generate/Regenerate on — show instant
  // feedback before the worker flips clip_status.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [promoThemes, setPromoThemes] = useState<PromoTheme[]>([]);
  const [promoTheme, setPromoTheme] = useState('');
  const [wm, setWm] = useState<Watermark | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [busyBrand, setBusyBrand] = useState(false);
  const pollRef = useRef<any>(null);

  async function loadBranding() {
    try { const b = await getBranding(); setWm(b.watermark); setLogoUrl(b.logo_url); } catch { /* ignore */ }
  }
  async function saveWm(patch: Partial<Watermark>) {
    try { setWm((await updateWatermark(patch)).watermark); } catch (e) { toast.error((e as Error).message); }
  }
  async function onLogoFile(file: File) {
    setBusyBrand(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = reject; r.readAsDataURL(file);
      });
      const b = await uploadLogo(base64); setWm(b.watermark); await loadBranding();
      toast.success('Logo uploaded');
    } catch (e) { toast.error((e as Error).message); } finally { setBusyBrand(false); }
  }

  const markPending = (shotId: string) => setPending((p) => new Set(p).add(shotId));
  async function startGenerate(shotId: string) {
    markPending(shotId);
    try {
      await generateShot(shotId);
    } catch (e) {
      toast.error((e as Error).message);
      setPending((p) => { const n = new Set(p); n.delete(shotId); return n; });
    }
    load();
  }
  async function startRegenerate(shotId: string, useAlt: boolean) {
    markPending(shotId);
    try {
      await regenerateShot(shotId, useAlt);
    } catch (e) {
      toast.error((e as Error).message);
      setPending((p) => { const n = new Set(p); n.delete(shotId); return n; });
    }
    load();
  }

  async function load() {
    try {
      const r = await getRun(id);
      setRun(r.run);
      setShots(r.shots);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadBranding();
    listPromoThemes()
      .then((r) => { setPromoThemes(r.themes); setPromoTheme((t) => t || r.themes[0]?.id || ''); })
      .catch(() => { /* themes are optional */ });
    return () => clearInterval(pollRef.current);
  }, [id]);

  // Poll while any phase is active.
  useEffect(() => {
    const active =
      run &&
      (ACTIVE_SCRIPT.includes(run.script_status) || ACTIVE_VIDEO.includes(run.video_status) ||
        run.preview_status === 'generating' ||
        shots.some((s) => ['prompting', 'submitted', 'polling'].includes(s.clip_status)));
    clearInterval(pollRef.current);
    if (active) pollRef.current = setInterval(load, 5000);
    return () => clearInterval(pollRef.current);
  }, [run, shots]);

  // Clear the optimistic flag once the worker has moved the shot off 'planned'.
  useEffect(() => {
    setPending((p) => {
      if (p.size === 0) return p;
      const n = new Set(p);
      for (const s of shots) if (s.clip_status !== 'planned') n.delete(s.id);
      return n;
    });
  }, [shots]);

  if (loading || !run) return <LoadingSpinner />;

  const v = run.vehicle ?? {};
  const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle';
  const sp = run.style_profile;
  const atGate1 = run.script_status === 'ready_for_review';
  const generating = run.video_status === 'clips_in_progress';
  const readyToFinalize = run.video_status === 'ready_to_finalize';

  async function saveStyle(patch: any) {
    try { setRun((await patchStyle(id, patch)).run); } catch (e) { toast.error((e as Error).message); }
  }
  async function toggleKeep(shot: Shot) {
    const r = await patchShots(id, [{ id: shot.id, kept: !shot.kept }]);
    setShots(r.shots);
  }
  async function saveShotText(shot: Shot, field: 'narration' | 'camera_prompt', value: string) {
    const r = await patchShots(id, [{ id: shot.id, [field]: value } as any]);
    setShots(r.shots);
  }

  return (
    <WorkspaceLayout title={title} subtitle={run.video_title as any} onBack={() => navigate('/vehicle-video')}>
      <div style={{ marginBottom: 12 }}>
        <Badge>{run.script_status}</Badge> <Badge color={run.video_status === 'complete' ? 'green' : undefined}>{run.video_status}</Badge>
        {run.error && <span style={{ color: '#c00', marginLeft: 8 }}>{run.error.code}: {run.error.message}</span>}
      </div>

      {/* Vehicle details (from the Auto Trader listing) */}
      {(v.make || v.description) && (
        <section style={{ marginBottom: 20, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Vehicle</h3>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')}</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '6px 0', color: '#333' }}>
              {v.price && <span><strong>{String(v.price)}</strong></span>}
              {v.mileage && <span>{String(v.mileage)} miles</span>}
              {v.body && <span>{String(v.body)}</span>}
              {v.seller_name && <span>· {String(v.seller_name)}</span>}
              {v.seller_location && <span>· {String(v.seller_location)}</span>}
            </div>
            {Array.isArray(v.specs) && (v.specs as string[]).length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {(v.specs as string[]).map((s, i) => <Badge key={i}>{s}</Badge>)}
              </div>
            )}
            <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>
              identified via {String(v.id_source ?? '—')} ({String(v.id_confidence ?? '—')})
            </div>
          </div>
          {typeof v.description === 'string' && (
            <details style={{ flex: '1 1 320px', border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Dealer description (feeds audience + closing line)</summary>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: '#444', marginTop: 8, maxHeight: 260, overflow: 'auto' }}>{String(v.description)}</div>
            </details>
          )}
        </section>
      )}

      {/* Free motion preview (no Veo) */}
      {shots.length > 0 && (
        <section style={{ marginBottom: 20, border: '1px solid #d8e6ff', background: '#f5f9ff', borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Free preview <small style={{ fontWeight: 400 }}>— pan/zoom over the photos + the real voiceover, ~£0 (no AI video spend)</small></h3>
          {run.preview_status === 'ready' && run.preview_path ? (
            <>
              <video src={mediaUrl(run.preview_path)} controls style={{ maxWidth: 640, width: '100%', borderRadius: 4 }} />
              <div style={{ marginTop: 6 }}>
                <Button variant="secondary" onClick={async () => { await previewRun(id); load(); }}>Regenerate preview</Button>
              </div>
            </>
          ) : run.preview_status === 'generating' ? (
            <p>Generating free preview… <LoadingSpinner /></p>
          ) : (
            <Button onClick={async () => { try { await previewRun(id); load(); } catch (e) { toast.error((e as Error).message); } }}>
              Generate free preview
            </Button>
          )}
          {run.preview_status === 'failed' && run.error && <p style={{ color: '#c00' }}>{run.error.message}</p>}
        </section>
      )}

      {/* Promo — the single short, self-aware social clip (Kling, silent, kinetic captions) */}
      {shots.length > 0 && promoThemes.length > 0 && (() => {
        const busyPromo = run.video_status === 'clips_in_progress' || run.video_status === 'finalizing';
        const selected = promoThemes.find((t) => t.id === promoTheme);
        return (
          <section style={{ marginBottom: 20, border: '2px solid #111', borderRadius: 8, padding: 12 }}>
            <h3 style={{ marginTop: 0 }}>Promo <small style={{ fontWeight: 400 }}>— one short, high-energy social clip to drive click-throughs to the listing (silent; add music downstream)</small></h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={promoTheme} onChange={(e) => setPromoTheme(e.target.value)} disabled={busyPromo}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', maxWidth: 320 }}>
                {promoThemes.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <Button disabled={busyPromo} onClick={async () => {
                try { await generatePromo(id, promoTheme); toast.success('Generating promo'); load(); }
                catch (e) { toast.error((e as Error).message); }
              }}>{busyPromo ? 'Generating…' : 'Generate promo'}</Button>
              {busyPromo && <LoadingSpinner />}
            </div>
            {selected && (
              <p style={{ fontSize: 13, color: '#555', marginTop: 8 }}>
                {selected.description}
                {selected.best_for && <> <span style={{ color: '#999' }}>· {selected.best_for}</span></>}
                {selected.title_card && <> <span style={{ color: '#999' }}>· caption “{selected.title_card.headline}” → {selected.title_card.cta}</span></>}
              </p>
            )}
            <p style={{ fontSize: 11, color: '#999', marginTop: 8 }}>
              Generates {selected?.shots ?? 2}–3 exact-car Kling shots from the real photos, then cuts them into one graded, captioned short. The result appears under “Final video”.
            </p>
            {run.video_status === 'failed' && run.error && <p style={{ color: '#c00' }}>{run.error.message}</p>}
          </section>
        );
      })()}

      {/* Branding / logo watermark (module-level: applies to all this dealer's videos) */}
      {wm && (
        <section style={{ marginBottom: 20, border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Logo watermark <small style={{ fontWeight: 400 }}>— applies to the preview and every final video for this dealer</small></h3>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={wm.enabled} onChange={(e) => saveWm({ enabled: e.target.checked })} /> Show logo watermark
            </label>
            {logoUrl ? (
              <img src={logoUrl} alt="logo" style={{ height: 40, background: '#eee', padding: 4, borderRadius: 4 }} />
            ) : <span style={{ color: '#999' }}>No logo yet</span>}
            <label style={{ cursor: 'pointer', color: '#06c' }}>
              {busyBrand ? 'Uploading…' : 'Upload logo'}
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && onLogoFile(e.target.files[0])} />
            </label>
            <Button variant="secondary" disabled={busyBrand} onClick={async () => { setBusyBrand(true); try { const b = await autopullLogo(); setWm(b.watermark); await loadBranding(); toast.success('Pulled logo from Auto Trader'); } catch (e) { toast.error((e as Error).message); } finally { setBusyBrand(false); } }}>
              Auto-pull from Auto Trader
            </Button>
          </div>
          {wm.enabled && (
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <label>Position
                <Select value={wm.position} onChange={(e: any) => saveWm({ position: e.target.value })}>
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                  <option value="top-right">Top right</option>
                  <option value="top-left">Top left</option>
                </Select>
              </label>
              <label>Size
                <input type="range" min={0.05} max={0.3} step={0.01} value={wm.scale} onChange={(e) => saveWm({ scale: Number(e.target.value) })} />
                <span style={{ fontSize: 12 }}> {Math.round(wm.scale * 100)}%</span>
              </label>
              <label>Opacity
                <input type="range" min={0.2} max={1} step={0.05} value={wm.opacity} onChange={(e) => saveWm({ opacity: Number(e.target.value) })} />
                <span style={{ fontSize: 12 }}> {Math.round(wm.opacity * 100)}%</span>
              </label>
            </div>
          )}
          <p style={{ fontSize: 11, color: '#999', marginTop: 8 }}>Regenerate the free preview after changing these to see the watermark applied.</p>
        </section>
      )}

      {/* Final video */}
      {run.video_status === 'complete' && run.video_path && (
        <section style={{ marginBottom: 24 }}>
          <h3>Final video</h3>
          <video src={mediaUrl(run.video_path)} controls style={{ maxWidth: 640, width: '100%' }} />
          <div><a href={mediaUrl(run.video_path)} download>Download MP4</a></div>
        </section>
      )}

      {/* Style panel */}
      {sp && (atGate1 || generating || readyToFinalize) && (
        <section style={{ marginBottom: 24, border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
          <h3>Style &amp; audience {atGate1 && <small style={{ fontWeight: 400 }}>(auto-inferred — adjust below if needed)</small>}</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <Badge color="green">{sp.vehicle_character}</Badge>
            {sp.audience?.age_lean && <Badge>age {sp.audience.age_lean}</Badge>}
            <Badge>{sp.style?.pacing}</Badge><Badge>{sp.style?.camera_energy} camera</Badge><Badge>{sp.style?.tone} tone</Badge>
          </div>
          <p style={{ color: '#333', margin: '4px 0' }}><strong>Who it's for:</strong> {sp.audience?.summary}</p>
          {sp.audience?.market_read && <p style={{ color: '#555', margin: '4px 0' }}><strong>Market read:</strong> {sp.audience.market_read}</p>}
          {Array.isArray(sp.audience?.buyer_motivations) && (sp.audience!.buyer_motivations as string[]).length > 0 && (
            <p style={{ color: '#555', margin: '4px 0' }}><strong>Motivations:</strong> {(sp.audience!.buyer_motivations as string[]).join(' · ')}</p>
          )}
          <p style={{ fontStyle: 'italic', color: '#777', margin: '4px 0' }}>{sp.rationale}</p>
          {sp.style?.voice && <p style={{ color: '#555', margin: '4px 0', fontSize: 13 }}><strong>Voice:</strong> {sp.style.voice}</p>}
          {atGate1 && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label>Template
                <Select value={sp.vehicle_character} onChange={(e: any) => saveStyle({ vehicle_character: e.target.value })}>
                  {CHARACTERS.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </label>
              <label>Pace
                <Select value={sp.style?.pacing} onChange={(e: any) => saveStyle({ style: { pacing: e.target.value } })}>
                  {PACING.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </label>
              <label>Camera
                <Select value={sp.style?.camera_energy} onChange={(e: any) => saveStyle({ style: { camera_energy: e.target.value } })}>
                  {ENERGY.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </label>
              <label>Voice
                <Input value={sp.style?.voice ?? ''} onChange={(e: any) => saveStyle({ style: { voice: e.target.value } })} />
              </label>
              <label>Market
                <Input value={run.market ?? ''} onChange={(e: any) => saveStyle({ market: e.target.value })} />
              </label>
              <Button variant="secondary" onClick={async () => { await rescript(id); load(); }}>Re-script with this style</Button>
            </div>
          )}
        </section>
      )}

      {/* Shots — review, generate & preview each clip individually, approve */}
      <section>
        <h3>Shots ({shots.filter((s) => s.kept).length} kept · {shots.filter((s) => s.kept && s.approval_status === 'approved').length} approved)</h3>
        <p style={{ color: '#666', fontSize: 13, marginTop: -4 }}>
          Generate any shot on its own to preview it before committing to the whole set. Approve each when it looks &amp; sounds right.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          {shots.map((s) => {
            const generating = ['prompting', 'submitted', 'polling'].includes(s.clip_status);
            const busy = generating || pending.has(s.id);
            const hasClip = s.clip_status === 'generated' && s.clip_path;
            return (
              <div key={s.id} style={{ display: 'flex', gap: 12, border: '1px solid #eee', borderRadius: 8, padding: 10, opacity: s.kept ? 1 : 0.45 }}>
                <div style={{ width: 220, flexShrink: 0 }}>
                  {hasClip ? (
                    <video src={mediaUrl(s.clip_path!)} controls style={{ width: '100%', borderRadius: 4 }} />
                  ) : (
                    <img src={mediaUrl(s.photo_path)} alt={s.scene_title ?? ''} style={{ width: '100%', borderRadius: 4 }} />
                  )}
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <Badge>{s.beat}</Badge>{' '}
                    <Badge color={busy ? 'amber' : undefined}>{busy ? 'generating…' : s.clip_status}</Badge>{' '}
                    {s.clip_status === 'generated' && <Badge color={s.approval_status === 'approved' ? 'green' : undefined}>{s.approval_status}</Badge>}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <strong>{s.scene_title}</strong>
                  {atGate1 && !hasClip ? (
                    <>
                      <textarea defaultValue={s.narration ?? ''} onBlur={(e) => saveShotText(s, 'narration', e.target.value)} style={{ width: '100%', minHeight: 44 }} />
                      <textarea defaultValue={s.camera_prompt ?? ''} onBlur={(e) => saveShotText(s, 'camera_prompt', e.target.value)} style={{ width: '100%', minHeight: 30 }} />
                    </>
                  ) : (
                    <>
                      <p style={{ margin: '4px 0' }}>{s.narration}</p>
                      <p style={{ color: '#888', fontSize: 13 }}>{s.camera_prompt}</p>
                    </>
                  )}
                  {s.error && <p style={{ color: '#c00', fontSize: 13 }}>{s.error.message}</p>}
                  {s.needs_more_images && (
                    <p style={{ fontSize: 12, color: '#8a6d00', background: '#fff8e1', border: '1px solid #ffe08a', borderRadius: 4, padding: '4px 8px', margin: '4px 0' }}>
                      ⚠ Limited motion for accuracy — {s.fidelity_note || 'this shot needs more photos of this angle to do a fuller camera move without inventing detail.'}
                    </p>
                  )}
                  {s.kept && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                      {!hasClip && !busy && (
                        <Button onClick={() => startGenerate(s.id)}>Generate clip (~$1.20)</Button>
                      )}
                      {busy && <span style={{ color: '#a60', display: 'inline-flex', alignItems: 'center', gap: 6 }}><LoadingSpinner /> Generating clip… (this takes a few minutes)</span>}
                      {hasClip && s.approval_status !== 'approved' && (
                        <Button onClick={async () => { await approveShot(s.id); load(); }}>Approve</Button>
                      )}
                      {hasClip && (
                        <Button variant="secondary" onClick={() => startRegenerate(s.id, false)}>Regenerate</Button>
                      )}
                      {hasClip && (s.alt_photo_paths?.length ?? 0) > 0 && (
                        <Button variant="ghost" onClick={() => startRegenerate(s.id, true)}>Try another photo</Button>
                      )}
                      {atGate1 && !hasClip && !busy && (
                        <Button variant="ghost" onClick={() => toggleKeep(s)}>Drop shot</Button>
                      )}
                    </div>
                  )}
                  {!s.kept && atGate1 && <Button variant="ghost" onClick={() => toggleKeep(s)}>Keep shot</Button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Gates */}
      <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {(() => {
          const plannedKept = shots.filter((s) => s.kept && ['planned', 'failed'].includes(s.clip_status)).length;
          return plannedKept > 0 ? (
            <Button onClick={async () => { try { plannedKept > 0 && shots.forEach((s) => s.kept && ['planned', 'failed'].includes(s.clip_status) && markPending(s.id)); await approvePlan(id); toast.success('Generating remaining clips'); load(); } catch (e) { toast.error((e as Error).message); } }}>
              Generate all remaining clips ({plannedKept} × ~$1.20)
            </Button>
          ) : null;
        })()}
        {readyToFinalize && (
          <Button onClick={async () => { try { await finalizeRun(id); toast.success('Producing final video'); load(); } catch (e) { toast.error((e as Error).message); } }}>
            Produce final video
          </Button>
        )}
      </div>
    </WorkspaceLayout>
  );
}
