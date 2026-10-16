/**
 * The studio for one video.
 *
 * After a master is uploaded the worker samples it, cuts the speaker out,
 * picks slide panels and drafts headlines. This page shows what it found and
 * lets the editor choose: which speaker frame, which headline (or type one),
 * how big and where the speaker sits, whether the slides show, where the
 * video starts and ends, and whether the talk card goes in front. Approve
 * renders the thumbnail and, if asked, cuts the master.
 *
 * The thumbnail preview is the same markup the worker renders, from
 * lib/artboard.ts, so what is on screen is what is produced.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import { ARTBOARD_CSS, artboardHtml, clampSelection, type ArtboardSelection } from '../../lib/artboard';
import { getPlaybackUrl } from '../utils/videosEditorService';
import {
  getStudio, startStudio, saveSelection, approveStudio, mmss,
  type StudioRow, type StudioMaster, type StudioBrand, type StudioSelection, type StudioCut,
} from '../utils/videosStudioService';

const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;900&family=Figtree:wght@400;500;600&display=swap';
const CARD_SECONDS = 4.24;

const CARD_CSS = `
.cardbox { position: relative; aspect-ratio: 16 / 9; background: #1e2337; border-radius: 6px; overflow: hidden; container-type: inline-size; border: 1px solid var(--gray-a6); }
.cardbox img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cardbox .ct { position: absolute; left: 10.4%; right: 12%; color: #fff; font-family: "Figtree", "Helvetica Neue", Arial, sans-serif; }
.cardbox .ct .t { font-weight: 500; font-size: 4.7cqw; line-height: 1.15; letter-spacing: -.012em; text-wrap: balance; }
.cardbox .ct .w { font-weight: 400; font-size: 2.6cqw; margin-top: 1.5cqw; color: rgba(255,255,255,.82); }
.cardbox .ct .w b { font-weight: 600; color: #fff; }
.cuts-pick button { width: 72px; height: 72px; border-radius: 8px; border: 2px solid var(--gray-a6); background-color: #0b0d12; cursor: pointer; padding: 0; }
.cuts-pick button[aria-pressed="true"] { border-color: var(--accent-9); }
.film { position: relative; display: flex; overflow-x: auto; gap: 1px; background: #0b0d12; border-radius: 6px; padding: 4px 0; cursor: pointer; }
.film .cell { flex: 0 0 80px; height: 45px; background-repeat: no-repeat; opacity: .6; }
.film .cell.in { opacity: 1; }
.film .mark { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; pointer-events: none; }
.film .mark.io { background: var(--accent-9); width: 3px; }
`;

function ensureFonts() {
  if (typeof document === 'undefined' || document.querySelector(`link[href="${FONTS_HREF}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = FONTS_HREF;
  document.head.appendChild(l);
}

/** A square crop of the cut-out around the figure's own bounds, for the chooser. */
function thumbStyle(c: StudioCut): CSSProperties {
  if (!c.url || !c.bbox) return { backgroundImage: c.url ? `url(${c.url})` : undefined, backgroundSize: 'cover' };
  const [x0, y0, x1, y1] = c.bbox;
  const bw = Math.max(0.05, x1 - x0); const box = 72;
  const imgW = box / bw; const imgH = imgW * 9 / 16;
  const px = imgW > box ? (x0 * imgW) / (imgW - box) * 100 : 0;
  const py = imgH > box ? (y0 * imgH) / (imgH - box) * 100 : 0;
  return { backgroundImage: `url(${c.url})`, backgroundSize: `${imgW.toFixed(0)}px auto`, backgroundPosition: `${px.toFixed(1)}% ${py.toFixed(1)}%` };
}

export default function VideoStudio() {
  const { videoId = '' } = useParams<{ videoId: string }>();
  const [row, setRow] = useState<StudioRow | null>(null);
  const [master, setMaster] = useState<StudioMaster | null>(null);
  const [brand, setBrand] = useState<StudioBrand | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<StudioSelection | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [playback, setPlayback] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  // The latest selection, for the debounced save, which runs outside the
  // render that produced it.
  const selRef = useRef<StudioSelection | null>(null);
  useEffect(() => { selRef.current = sel; }, [sel]);

  useEffect(() => { ensureFonts(); }, []);

  const brandLoaded = useRef(false);
  const load = useCallback(async () => {
    const r = await getStudio(videoId, { withBrand: !brandLoaded.current });
    setRow(r.studio); setMaster(r.master); setConfigured(r.configured);
    if (r.brand) { setBrand(r.brand); brandLoaded.current = true; }
    if (r.studio && !dirty.current) {
      const s = r.studio.selection ?? {};
      setSel({
        cut: s.cut ?? r.studio.analysis.cuts?.[0]?.key ?? null,
        scale: s.scale ?? 1, x: s.x ?? 0.62,
        lead: s.lead ?? r.studio.headlines?.[0]?.lead ?? '', emph: s.emph ?? r.studio.headlines?.[0]?.emph ?? '',
        panels: s.panels !== false, trim_in: s.trim_in ?? null, trim_out: s.trim_out ?? null,
        preroll: s.preroll === true, card_title: s.card_title ?? r.studio.analysis.context?.title ?? null,
        card_speakers: s.card_speakers ?? null,
      });
    }
    return r.studio;
  }, [videoId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { await load(); } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not load the studio'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [load]);

  // Poll while the worker is busy.
  const state = row?.state;
  useEffect(() => {
    if (!state || !['queued', 'analysing', 'finalising'].includes(state)) return;
    const h = setInterval(() => { void load().catch(() => {}); }, 3000);
    return () => clearInterval(h);
  }, [state, load]);

  // A playable URL for the master, for the trim timeline.
  useEffect(() => {
    if (!master?.id) return;
    let cancelled = false;
    void getPlaybackUrl(master.id).then((u) => { if (!cancelled) setPlayback(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [master?.id]);

  const analysis = row?.analysis ?? {};
  const cuts = analysis.cuts ?? [];
  const panels = analysis.panels ?? [];
  const duration = analysis.duration ?? master?.duration_seconds ?? 0;
  const context = analysis.context;
  const cut = useMemo(() => cuts.find((c) => c.key === sel?.cut) ?? cuts[0] ?? null, [cuts, sel?.cut]);

  const update = (patch: Partial<StudioSelection>) => {
    dirty.current = true;
    setSel((s) => (s ? { ...s, ...patch } : s));
    setSaved('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush(); }, 800);
  };

  const flush = async () => {
    const latest = selRef.current;
    if (!latest) return;
    try {
      await saveSelection(videoId, latest);
      dirty.current = false;
      setSaved('saved');
    } catch (err) {
      setSaved('idle');
      toast.error(err instanceof Error ? err.message : 'Could not save');
    }
  };

  const analyse = async () => {
    setBusy(true);
    try {
      dirty.current = false;
      const r = await startStudio(videoId);
      setRow(r);
      toast.success('Analysis queued');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the analysis');
    } finally { setBusy(false); }
  };

  const approve = async () => {
    const latest = selRef.current;
    if (!latest) return;
    setBusy(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const r = await approveStudio(videoId, latest);
      dirty.current = false;
      setRow(r);
      toast.success('Approved. Rendering now.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not approve');
    } finally { setBusy(false); }
  };

  const artSelection: ArtboardSelection | null = sel ? clampSelection({ scale: sel.scale, x: sel.x, lead: sel.lead, emph: sel.emph, panels: sel.panels }) : null;
  const artHtml = useMemo(() => {
    if (!artSelection || !brand) return '';
    return artboardHtml({
      backgroundSrc: brand.thumbnail_bg, logoSrc: brand.logo,
      cutSrc: cut?.url ?? null, panelSrcs: panels.slice(0, 2).map((p) => p.url ?? '').filter(Boolean),
      markName: context?.org ?? null, cutBounds: cut?.bbox ?? null, selection: artSelection,
    });
  }, [artSelection, brand, cut, panels, context?.org]);

  // ── Trim helpers ───────────────────────────────────────────────────────────
  const seek = (t: number) => {
    const v = videoRef.current;
    if (v) { v.currentTime = Math.max(0, Math.min(duration, t)); setTime(v.currentTime); }
  };
  const trimIn = sel?.trim_in ?? 0;
  const trimOut = sel?.trim_out ?? duration;
  const keeps = Math.max(0, trimOut - trimIn);

  const cardSpeakers = sel?.card_speakers ?? context?.speakers ?? [];
  const cardTitle = sel?.card_title ?? context?.title ?? '';
  // Once a cut master has been written, the filmstrip and the timings belong
  // to the master that was replaced. Trim and card are closed until a new
  // analysis is run on the new master.
  const cutApplied = Boolean(row?.outputs?.master_asset_id);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;

  const title = context?.title || 'Video studio';
  const who = context?.speakers?.map((s) => s.name).join(', ');
  const working = state && ['queued', 'analysing', 'finalising'].includes(state);

  return (
    <WorkspaceLayout title="Video studio">
      <style>{ARTBOARD_CSS}{CARD_CSS}</style>
      <div className="p-6 max-w-6xl">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-[var(--gray-11)]">
              {[who, context?.org, context?.eventName].filter(Boolean).join(' · ')}
              {master ? ` · master ${master.filename ?? ''}${master.duration_seconds ? ` ${mmss(master.duration_seconds)}` : ''}` : ' · no master uploaded yet'}
            </p>
            <Link to="/videos" className="text-xs text-[var(--accent-11)] hover:underline">Back to videos</Link>
          </div>
          <div className="flex items-center gap-2">
            {state && <Badge color={state === 'approved' ? 'green' : state === 'failed' ? 'red' : state === 'ready' ? 'blue' : 'amber'} variant="soft">{state}</Badge>}
            {saved === 'saving' && <span className="text-xs text-[var(--gray-9)]">saving…</span>}
            {saved === 'saved' && <span className="text-xs text-[var(--green-11)]">saved</span>}
            <Button size="sm" variant="outline" disabled={busy || !master || !!working || !configured} onClick={() => void analyse()}>
              {row ? 'Analyse again' : 'Analyse this video'}
            </Button>
            <Button size="sm" variant="solid" disabled={busy || !sel || !!working || !['ready', 'approved'].includes(state ?? '')} onClick={() => void approve()}>
              {state === 'approved' ? 'Approve again' : 'Approve'}
            </Button>
          </div>
        </div>

        {!configured && (
          <Card variant="surface" className="p-4 mb-4 text-sm">
            The studio needs <code>FAL_API_KEY</code> on the API and the worker. Nothing can be analysed until it is set.
          </Card>
        )}

        {!row && (
          <Card variant="surface" className="p-6 text-sm text-[var(--gray-11)]">
            {master
              ? 'Nothing analysed yet. Analyse this video to get speaker cut-outs, slide panels and headline drafts.'
              : 'Upload a recording for this talk first, then come back here.'}
          </Card>
        )}

        {row && working && (
          <Card variant="surface" className="p-6 flex items-center gap-3">
            <LoadingSpinner />
            <div>
              <div className="text-sm font-medium">{state === 'finalising' ? 'Producing the approved outputs' : 'Analysing the master'}</div>
              <div className="text-xs text-[var(--gray-11)]">{row.progress ?? 'Working'}</div>
            </div>
          </Card>
        )}

        {row && state === 'failed' && (
          <Card variant="surface" className="p-4 mb-4 text-sm border border-[var(--red-a6)]">
            The analysis failed: {row.error ?? 'unknown error'}. Fix the cause and analyse again.
          </Card>
        )}
        {row && row.error && state !== 'failed' && (
          <Card variant="surface" className="p-4 mb-4 text-sm border border-[var(--amber-a6)]">
            The last approval did not finish: {row.error}. Your choices are kept; approve again when ready.
          </Card>
        )}

        {row && state === 'approved' && (
          <Card variant="surface" className="p-4 mb-4">
            <div className="text-sm font-medium mb-2">Approved</div>
            <div className="grid sm:grid-cols-2 gap-4 items-start">
              {row.outputs.thumbnail_url && <img src={row.outputs.thumbnail_url} alt="Thumbnail" className="rounded border border-[var(--gray-a6)] w-full" />}
              <div className="text-sm text-[var(--gray-11)] space-y-1">
                <div>The thumbnail is set on the video.</div>
                {row.outputs.master_asset_id
                  ? <div>A new master was written{row.outputs.trimmed ? ', trimmed' : ''}{row.outputs.prerolled ? ', with the talk card in front' : ''}{row.outputs.reencoded ? ' (the join had to be re-encoded)' : ''}{row.outputs.duration_seconds ? `, ${mmss(row.outputs.duration_seconds)} long` : ''}. The previous master is kept as superseded.</div>
                  : <div>The master was left as uploaded.</div>}
                <div><Link to="/videos" className="text-[var(--accent-11)] hover:underline">Schedule it from the videos workspace</Link>.</div>
              </div>
            </div>
          </Card>
        )}

        {row && sel && ['ready', 'approved'].includes(state ?? '') && (
          <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 items-start">
            {/* ── Thumbnail ── */}
            <Card variant="surface" className="p-4">
              <h3 className="text-sm font-semibold mb-2">Thumbnail</h3>
              <div className="rounded overflow-hidden border border-[var(--gray-a6)]" dangerouslySetInnerHTML={{ __html: artHtml }} />

              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <div className="text-xs text-[var(--gray-9)] mb-1">Headline drafts</div>
                  <div className="flex flex-wrap gap-2">
                    {(row.headlines ?? []).map((h, i) => (
                      <button key={i} type="button" onClick={() => update({ lead: h.lead, emph: h.emph })}
                        className={`text-xs rounded-full border px-3 py-1.5 ${sel.lead === h.lead && sel.emph === h.emph ? 'border-[var(--accent-9)] bg-[var(--accent-a3)]' : 'border-[var(--gray-a6)]'}`}>
                        {h.lead} / {h.emph}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-[var(--gray-9)] mt-1">Drafted from the programme. Any number in a draft comes from the abstract; check the words against the talk before publishing.</p>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <label className="text-xs text-[var(--gray-9)]">Lead line
                    <input value={sel.lead} maxLength={60} onChange={(e) => update({ lead: e.target.value })}
                      className="mt-1 w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-surface)]" />
                  </label>
                  <label className="text-xs text-[var(--gray-9)]">Big words
                    <input value={sel.emph} maxLength={40} onChange={(e) => update({ emph: e.target.value })}
                      className="mt-1 w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-surface)]" />
                  </label>
                </div>

                <div>
                  <div className="text-xs text-[var(--gray-9)] mb-1">Speaker frame</div>
                  {cuts.length === 0 ? (
                    <p className="text-xs text-[var(--gray-11)]">No usable speaker frame was found. The thumbnail will show the backdrop and the words only.</p>
                  ) : (
                    <div className="cuts-pick flex items-center gap-2 flex-wrap">
                      {cuts.map((c) => (
                        <button key={c.key} type="button" aria-pressed={sel.cut === c.key || (!sel.cut && c === cuts[0])}
                          title={`frame at ${mmss(c.t)}: ${c.meta?.note ?? ''}`} style={thumbStyle(c)} onClick={() => update({ cut: c.key })} />
                      ))}
                      <span className="text-xs text-[var(--gray-9)]">
                        {cuts.length} frame{cuts.length > 1 ? 's' : ''} passed the size, glare and screen checks.
                      </span>
                    </div>
                  )}
                  {cut && (
                    <p className="text-xs text-[var(--gray-11)] mt-1">
                      Frame at {mmss(cut.t)} of {mmss(duration)}{cut.meta?.note ? ` · ${cut.meta.note}` : ''}
                      {` · screen behind head ${Math.round((cut.screen ?? 0) * 100)}%, glare ${Math.round((cut.glare ?? 0) * 100)}%`}
                      {cut.camera_crop ? ' · cut from the camera panel of the composite' : ''}
                      {cut.lectern_joined ? ' · lectern joined' : ''}
                      {cut.gamma > 1 ? ` · exposure lifted (gamma ${cut.gamma})` : ''}
                      {cut.flagged ? <span className="text-[var(--amber-11)]"> · flagged: {cut.flagged}</span> : null}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center text-xs text-[var(--gray-9)]">
                  <label htmlFor="st-scale">Speaker size</label>
                  <input id="st-scale" type="range" min={70} max={150} value={Math.round(sel.scale * 100)} onChange={(e) => update({ scale: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent-9)]" />
                  <label htmlFor="st-x">Speaker position</label>
                  <input id="st-x" type="range" min={40} max={85} value={Math.round(sel.x * 100)} onChange={(e) => update({ x: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent-9)]" />
                </div>

                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={sel.panels} onChange={(e) => update({ panels: e.target.checked })} disabled={panels.length === 0} />
                  Show the slide panels behind the speaker
                  <span className="text-[var(--gray-9)]">
                    {panels.length ? `(${panels.map((p) => `${p.note} at ${mmss(p.t)}`).join('; ')})` : '(no slide passed the check: legible, interesting, nobody in it)'}
                  </span>
                </label>
              </div>
            </Card>

            {/* ── Trim and pre-roll ── */}
            <div className="space-y-6">
              {cutApplied && (
                <Card variant="surface" className="p-4 text-sm text-[var(--gray-11)]">
                  The trim and the card are already in the new master, so the timeline below is closed. Approve again to re-render the thumbnail only, or analyse again to trim the new master.
                </Card>
              )}
              <Card variant="surface" className={`p-4 ${cutApplied ? 'opacity-60 pointer-events-none' : ''}`}>
                <h3 className="text-sm font-semibold mb-2">Trim</h3>
                {playback ? (
                  <video ref={videoRef} src={playback} controls preload="metadata" className="w-full rounded bg-black"
                    onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
                ) : <p className="text-xs text-[var(--gray-11)]">Loading the master…</p>}

                {analysis.filmstrip?.url && (
                  <Filmstrip strip={analysis.filmstrip} duration={duration} time={time} trimIn={trimIn} trimOut={trimOut} onSeek={seek} />
                )}

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>Start <b>{mmss(trimIn)}</b></div>
                  <div className="text-right">End <b>{mmss(trimOut)}</b></div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="xs" variant="outline" onClick={() => update({ trim_in: Math.min(time, trimOut - 1) })}>Set start to playhead</Button>
                  <Button size="xs" variant="outline" onClick={() => update({ trim_out: Math.max(time, trimIn + 1) })}>Set end to playhead</Button>
                  <Button size="xs" variant="outline" onClick={() => seek(trimIn)}>Play from start</Button>
                  <Button size="xs" variant="outline" onClick={() => update({ trim_in: null, trim_out: null })}>Clear trim</Button>
                </div>
                <p className="text-xs text-[var(--gray-11)] mt-2">
                  Keeps <b>{mmss(keeps)}</b> of {mmss(duration)}. The cut is made from the master by stream copy, so it lands on the nearest keyframe, within about a second of the point you set.
                </p>
              </Card>

              <Card variant="surface" className={`p-4 ${cutApplied ? 'opacity-60 pointer-events-none' : ''}`}>
                <h3 className="text-sm font-semibold mb-2">Pre-roll card</h3>
                <label className="flex items-center gap-2 text-sm mb-3">
                  <input type="checkbox" checked={sel.preroll} onChange={(e) => update({ preroll: e.target.checked })} />
                  Put the talk card in front ({CARD_SECONDS}s, with the music sting)
                </label>
                <div className="cardbox">
                  {brand?.card_bg && <img src={brand.card_bg} alt="" />}
                  <div className="ct" style={{ top: `${cardTitle.length <= 34 ? 39 : cardTitle.length <= 70 ? 32 : 26.5}%` }}>
                    <div className="t">{cardTitle}</div>
                    <div className="w">
                      {cardSpeakers.filter((s) => s.name).map((s, i) => (
                        <span key={i}>{i > 0 ? ' · ' : ''}<b>{s.name}</b>{s.role ? `, ${s.role}` : ''}{s.company ? `, ${s.company}` : ''}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-3 space-y-2 text-xs">
                  <label className="block text-[var(--gray-9)]">Card title
                    <input value={cardTitle} maxLength={200} onChange={(e) => update({ card_title: e.target.value })}
                      className="mt-1 w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-surface)]" />
                  </label>
                  {cardSpeakers.map((s, i) => (
                    <div key={i} className="grid grid-cols-3 gap-2">
                      {(['name', 'role', 'company'] as const).map((k) => (
                        <input key={k} value={s[k] ?? ''} placeholder={k} maxLength={80}
                          onChange={(e) => {
                            const next = cardSpeakers.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x));
                            update({ card_speakers: next.map((x) => ({ name: x.name, role: x.role ?? null, company: x.company ?? null })) });
                          }}
                          className="px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-surface)]" />
                      ))}
                    </div>
                  ))}
                  <p className="text-[var(--gray-11)]">Title and names come from the agenda. Edit them here for the card only.</p>
                </div>
              </Card>

              <Card variant="surface" className="p-4 text-xs text-[var(--gray-11)]">
                Analysed {analysis.sampled ?? 0} frames every {analysis.sample_every ?? 0}s
                {analysis.layout ? `; ${analysis.layout.strip + analysis.layout.overlay} composite, ${analysis.layout.plain} plain` : ''}
                {analysis.model_calls ? `; ${analysis.model_calls} model calls` : ''}.
              </Card>
            </div>
          </div>
        )}
      </div>
    </WorkspaceLayout>
  );
}

/** The sampled frames as a strip; click to seek, with the playhead and the trim marked. */
function Filmstrip(props: {
  strip: NonNullable<StudioRow['analysis']['filmstrip']>;
  duration: number; time: number; trimIn: number; trimOut: number; onSeek: (t: number) => void;
}) {
  const { strip, duration, time, trimIn, trimOut, onSeek } = props;
  const cellW = 80; const cellH = 45;
  const scale = cellW / strip.cell_w;
  const cells = Array.from({ length: strip.count }, (_, k) => {
    const t = strip.start + k * strip.every;
    const col = k % strip.columns; const r = Math.floor(k / strip.columns);
    return { t, col, r };
  });
  const totalW = cells.length * (cellW + 1);
  const xOf = (t: number) => (duration ? (t / duration) * totalW : 0);
  return (
    <div className="film mt-3" role="group" aria-label="Filmstrip">
      {cells.map((c) => (
        <div key={c.t} className={`cell ${c.t >= trimIn && c.t <= trimOut ? 'in' : ''}`} title={mmss(c.t)}
          onClick={() => onSeek(c.t)}
          style={{
            backgroundImage: `url(${strip.url})`,
            backgroundSize: `${strip.columns * strip.cell_w * scale}px ${strip.rows * strip.cell_h * scale}px`,
            backgroundPosition: `-${c.col * cellW}px -${c.r * cellH}px`,
            width: cellW, height: cellH,
          }} />
      ))}
      <div className="mark io" style={{ left: xOf(trimIn) }} />
      <div className="mark io" style={{ left: xOf(trimOut) }} />
      <div className="mark" style={{ left: xOf(time) }} />
    </div>
  );
}
