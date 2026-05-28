import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import { Button, Badge } from '@/components/ui';
import { PlusIcon, TrashIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  createTemplate, updateTemplate, getAssetsForEvent, uploadAsset, getAssetPublicUrl,
  type InviteTemplate, type TemplateAsset, type PdfField,
} from './utils/inviteTemplateService';
import { getAvailableVariables, buildInviteContext, resolveVariable } from './utils/inviteVariables';
import { wrapText } from './utils/wrapText';
import type { TemplateEditorHandle } from './utils/templateEditorHandle';

const SAMPLE_CONTEXT = buildInviteContext(
  { name: 'The Smiths', short_code: 'sb7gcr', members: [
    { first_name: 'Dan', last_name: 'Baker', email: 'dan@example.com', is_lead_booker: true },
    { first_name: 'Sarah', last_name: 'Swift', email: null, is_lead_booker: false },
  ]},
  { event_title: 'Baker-Swift Wedding', event_start: '2026-06-15T14:30:00Z', event_location: "St Mary's Church" },
  { name: 'Day Ceremony', description: 'Join us for the ceremony', starts_at: '2026-06-15T14:30:00Z' },
  'https://example.com',
);

interface Props {
  eventUuid: string;
  template: InviteTemplate | null;
  subEventId: string | null;
  onSave: () => void;
}

// Background PDFs are rendered to a <canvas> via pdf.js so that we control
// the render scale precisely. Text/QR field handles are overlaid using
// absolute positioning in the same coordinate system.

const PdfTemplateEditor = forwardRef<TemplateEditorHandle, Props>(function PdfTemplateEditor(
  { eventUuid, template, subEventId, onSave }: Props,
  ref,
) {
  const [name, setName] = useState(template?.name || '');
  const [fields, setFields] = useState<PdfField[]>(template?.pdf_fields || []);
  const [bgPath, setBgPath] = useState(template?.pdf_background_path || '');
  const [bgHidden, setBgHidden] = useState<boolean>(template?.pdf_background_hidden ?? false);
  const [assets, setAssets] = useState<TemplateAsset[]>([]);
  const [uploading, setUploading] = useState(false);

  // Visual editor state
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [pdfSize, setPdfSize] = useState({ width: 297.75, height: 419.25 }); // PDF pts
  const [displaySize, setDisplaySize] = useState({ width: 450, height: 633 }); // CSS px (A5 ratio)
  const [bgReady, setBgReady] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  // Off-screen canvas 2D context for measuring text width during wrapping.
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  if (!measureCtxRef.current && typeof document !== 'undefined') {
    measureCtxRef.current = document.createElement('canvas').getContext('2d');
  }

  const variables = getAvailableVariables();
  const fontAssets = assets.filter(a => a.asset_type === 'font');

  const loadAssets = useCallback(async () => {
    const data = await getAssetsForEvent(eventUuid);
    setAssets(data);
  }, [eventUuid]);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  // Inject @font-face declarations for all uploaded fonts so they can render in the preview
  useEffect(() => {
    if (fontAssets.length === 0) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'invite-template-fonts';
    const faces = fontAssets.map(f => {
      const url = getAssetPublicUrl(f);
      const family = `invite-font-${f.id}`;
      return `@font-face { font-family: '${family}'; src: url('${url}') format('truetype'); }`;
    }).join('\n');
    styleEl.textContent = faces;
    document.head.appendChild(styleEl);
    return () => {
      document.getElementById('invite-template-fonts')?.remove();
    };
  }, [fontAssets]);

  // Resolve the background PDF URL when path/assets change.
  useEffect(() => {
    if (!bgPath || assets.length === 0) { setBgUrl(null); return; }
    const bgAsset = assets.find(a => a.storage_path === bgPath);
    if (!bgAsset) { setBgUrl(null); return; }
    setBgUrl(getAssetPublicUrl(bgAsset));
    setBgReady(false);
  }, [bgPath, assets]);

  // Render the first page of the background PDF to a canvas via pdf.js.
  // Using pdf.js (instead of an <iframe>) lets us control the render scale
  // precisely, so the background and the overlay coordinates stay in sync.
  useEffect(() => {
    if (!bgUrl) return;
    let cancelled = false;

    (async () => {
      try {
        const pdfjsLib: any = await import('pdfjs-dist');
        // Worker URL — loaded from CDN to avoid Vite worker-loader issues
        // when this module is resolved from an external module directory.
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        }

        const loadingTask = pdfjsLib.getDocument(bgUrl);
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        const page = await pdf.getPage(1);
        if (cancelled) return;

        const v1 = page.getViewport({ scale: 1 });
        const realW = v1.width;
        const realH = v1.height;

        // Fit to 450px wide, preserving the real aspect ratio.
        const targetWidth = 450;
        const targetHeight = Math.round(targetWidth * (realH / realW));
        const renderScale = targetWidth / realW;
        const viewport = page.getViewport({ scale: renderScale });

        const canvas = bgCanvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(viewport.width * dpr);
        canvas.height = Math.round(viewport.height * dpr);
        canvas.style.width = `${targetWidth}px`;
        canvas.style.height = `${targetHeight}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewport.width, viewport.height);

        await page.render({ canvasContext: ctx, viewport }).promise;

        if (cancelled) return;
        setPdfSize({ width: realW, height: realH });
        setDisplaySize({ width: targetWidth, height: targetHeight });
        setBgReady(true);
      } catch (err) {
        console.error('Failed to render background PDF:', err);
        if (!cancelled) {
          // Fall back to A5-ish defaults so the editor still works
          setPdfSize({ width: 297.75, height: 419.25 });
          setDisplaySize({ width: 450, height: Math.round(450 * (419.25 / 297.75)) });
          setBgReady(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [bgUrl]);

  // Convert PDF coordinates (bottom-left origin) to display coordinates (top-left origin)
  const pdfToDisplay = (x: number, y: number) => ({
    left: (x / pdfSize.width) * displaySize.width,
    top: ((pdfSize.height - y) / pdfSize.height) * displaySize.height,
  });

  // Convert display coordinates back to PDF coordinates
  const displayToPdf = (left: number, top: number) => ({
    x: (left / displaySize.width) * pdfSize.width,
    y: pdfSize.height - (top / displaySize.height) * pdfSize.height,
  });

  const handleMouseDown = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingIndex(index);
    setSelectedIndex(index);
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (draggingIndex === null || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const left = Math.max(0, Math.min(e.clientX - rect.left, displaySize.width));
    const top = Math.max(0, Math.min(e.clientY - rect.top, displaySize.height));
    const { x, y } = displayToPdf(left, top);

    setFields(prev => prev.map((f, i) => i === draggingIndex ? { ...f, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 } : f));
  }, [draggingIndex, displaySize, pdfSize]);

  const handleMouseUp = useCallback(() => {
    setDraggingIndex(null);
  }, []);

  useEffect(() => {
    if (draggingIndex !== null) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingIndex, handleMouseMove, handleMouseUp]);

  const handleUploadFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.match(/\.(ttf|otf)$/i)) { toast.error('Only TTF/OTF fonts'); return; }
    setUploading(true);
    try {
      await uploadAsset(eventUuid, file, 'font', { font_family: file.name.replace(/\.(ttf|otf)$/i, '') });
      await loadAssets();
      toast.success(`Font "${file.name}" uploaded`);
    } catch { toast.error('Failed to upload font'); }
    finally { setUploading(false); }
  };

  const handleUploadBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { toast.error('Only PDF files'); return; }
    setUploading(true);
    try {
      const asset = await uploadAsset(eventUuid, file, 'pdf_background');
      setBgPath(asset.storage_path);
      await loadAssets();
      toast.success('PDF background uploaded');
    } catch { toast.error('Failed to upload background'); }
    finally { setUploading(false); }
  };

  const addField = (type: 'text' | 'static' | 'qr') => {
    let newField: PdfField;
    if (type === 'text') {
      newField = { type: 'text', variable: 'party.name', x: pdfSize.width / 2, y: pdfSize.height - 50, fontSize: 20, color: '#000000', align: 'center' };
    } else if (type === 'static') {
      newField = { type: 'text', text: 'Your text here', x: pdfSize.width / 2, y: pdfSize.height - 50, fontSize: 20, color: '#000000', align: 'center' };
    } else {
      newField = { type: 'qr', variable: 'invite.rsvp_link', x: pdfSize.width - 80, y: 30, size: 52 };
    }
    setFields([...fields, newField]);
    setSelectedIndex(fields.length);
  };

  const updateField = (index: number, updates: Partial<PdfField>) => {
    setFields(fields.map((f, i) => i === index ? { ...f, ...updates } : f));
  };

  const removeField = (index: number) => {
    setFields(fields.filter((_, i) => i !== index));
    if (selectedIndex === index) setSelectedIndex(null);
  };

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!name.trim()) {
        toast.error('Name is required');
        throw new Error('Name is required');
      }
      const data = {
        event_id: eventUuid,
        sub_event_id: subEventId,
        channel: 'pdf' as const,
        name: name.trim(),
        pdf_background_path: bgPath || null,
        pdf_background_hidden: bgHidden,
        pdf_fields: fields,
      };
      if (template?.id) await updateTemplate(template.id, data);
      else await createTemplate(data);
      toast.success('PDF template saved');
      onSave();
    },
  }), [name, eventUuid, subEventId, bgPath, bgHidden, fields, template?.id, onSave]);

  const selectedField = selectedIndex !== null ? fields[selectedIndex] : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        {/* Template name */}
        <div className="px-4 pt-3 pb-2">
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Template Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Day Ceremony - Print Invite"
            className="w-full px-2 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]" />
        </div>

        {/* Background upload */}
        {!bgPath && (
          <div className="px-4 py-2">
            <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">PDF Background</label>
            <label className="flex items-center justify-center gap-2 p-6 border-2 border-dashed border-[var(--gray-6)] rounded-lg cursor-pointer hover:border-[var(--accent-8)] transition-colors">
              <input type="file" accept=".pdf" onChange={handleUploadBg} className="hidden" />
              <ArrowUpTrayIcon className="w-5 h-5 text-[var(--gray-9)]" />
              <span className="text-sm text-[var(--gray-9)]">{uploading ? 'Uploading...' : 'Upload your Canva PDF design'}</span>
            </label>
          </div>
        )}

        {/* Visual editor */}
        {bgUrl && (
          <div className="flex gap-3 px-4 py-2">
            {/* Canvas area */}
            <div className="flex-shrink-0">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--gray-9)]">Drag fields to position them</span>
                  <label className="flex items-center gap-1.5 text-xs text-[var(--gray-11)] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={bgHidden}
                      onChange={e => setBgHidden(e.target.checked)}
                      className="cursor-pointer"
                    />
                    Hide background in output
                  </label>
                </div>
                <div className="flex gap-1">
                  <Button variant="soft" size="1" onClick={() => addField('text')}><PlusIcon className="w-3 h-3 mr-0.5" />Variable</Button>
                  <Button variant="soft" size="1" onClick={() => addField('static')}><PlusIcon className="w-3 h-3 mr-0.5" />Static</Button>
                  <Button variant="soft" size="1" onClick={() => addField('qr')}><PlusIcon className="w-3 h-3 mr-0.5" />QR</Button>
                </div>
              </div>
              <div
                ref={overlayRef}
                className="relative border border-[var(--gray-6)] rounded overflow-hidden select-none bg-white"
                style={{ width: displaySize.width, height: displaySize.height, cursor: draggingIndex !== null ? 'grabbing' : 'default' }}
              >
                <canvas
                  ref={bgCanvasRef}
                  className="absolute inset-0"
                  style={{ pointerEvents: 'none', opacity: bgHidden ? 0.2 : 1 }}
                />
                {!bgReady && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--gray-9)] pointer-events-none">
                    Rendering background PDF...
                  </div>
                )}
                {bgHidden && bgReady && (
                  <div className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-[var(--gray-12)] text-[var(--gray-1)] pointer-events-none">
                    Background hidden in output
                  </div>
                )}

                {/* QR overlays — rendered as divs */}
                {fields.map((field, i) => {
                  if (field.type !== 'qr') return null;
                  const pos = pdfToDisplay(field.x, field.y);
                  const isSelected = selectedIndex === i;
                  const scale = displaySize.width / pdfSize.width;
                  const size = (field.size || 52) * scale;
                  const qrRotation = field.rotation || 0;
                  return (
                    <div
                      key={`qr-${i}`}
                      className={`absolute cursor-grab active:cursor-grabbing border-2 ${
                        isSelected ? 'border-blue-500 ring-2 ring-blue-300' : 'border-dashed border-orange-500/60 hover:border-orange-500'
                      }`}
                      style={{
                        left: pos.left,
                        top: pos.top - size,
                        width: size,
                        height: size,
                        backgroundColor: 'rgba(255,165,0,0.1)',
                        transform: qrRotation ? `rotate(${-qrRotation}deg)` : undefined,
                        transformOrigin: '0% 100%',
                      }}
                      onMouseDown={e => handleMouseDown(i, e)}
                      onClick={() => setSelectedIndex(i)}
                    >
                      <div className="absolute inset-0 flex items-center justify-center text-[10px] text-orange-700 font-semibold">
                        QR
                      </div>
                    </div>
                  );
                })}

                {/* Text overlays — rendered as SVG so the glyph baseline
                    lands exactly on the stored (x, y), matching pdf-lib. */}
                <svg
                  className="absolute inset-0"
                  width={displaySize.width}
                  height={displaySize.height}
                  style={{ pointerEvents: 'none', overflow: 'visible' }}
                >
                  {fields.map((field, i) => {
                    if (field.type !== 'text') return null;
                    const pos = pdfToDisplay(field.x, field.y);
                    const isSelected = selectedIndex === i;
                    const scale = displaySize.width / pdfSize.width;
                    const fontSize = (field.fontSize || 12) * scale;
                    const lineHeight = field.lineHeight ?? 1;
                    const fontFamily = field.fontAssetId ? `'invite-font-${field.fontAssetId}', sans-serif` : 'sans-serif';
                    const textAlign = field.align || 'left';
                    const rotation = field.rotation || 0;
                    const maxWidthDisplay = field.maxWidth ? field.maxWidth * scale : undefined;

                    const rawText = field.text !== undefined
                      ? field.text
                      : (resolveVariable(field.variable || '', SAMPLE_CONTEXT) || `{{${field.variable || ''}}}`);

                    // Measure widths with an off-screen canvas so the editor
                    // wraps the same way the output (roughly) will.
                    const lines = maxWidthDisplay && maxWidthDisplay > 0
                      ? wrapText(rawText, maxWidthDisplay, (s) => {
                          const ctx = measureCtxRef.current;
                          if (!ctx) return s.length * fontSize * 0.5;
                          ctx.font = `${fontSize}px ${fontFamily}`;
                          return ctx.measureText(s).width;
                        })
                      : [rawText];

                    const textAnchor = textAlign === 'center' ? 'middle' : textAlign === 'right' ? 'end' : 'start';
                    const transform = rotation ? `rotate(${-rotation} ${pos.left} ${pos.top})` : undefined;
                    const fill = field.color || '#000000';

                    return (
                      <g key={`text-${i}`} transform={transform}>
                        <text
                          x={pos.left}
                          y={pos.top}
                          fontSize={fontSize}
                          fontFamily={fontFamily}
                          fill={fill}
                          textAnchor={textAnchor}
                          style={{
                            pointerEvents: 'auto',
                            cursor: draggingIndex === i ? 'grabbing' : 'grab',
                            userSelect: 'none',
                            ...(isSelected ? { paintOrder: 'stroke fill', stroke: '#3b82f6', strokeWidth: 0.75 } : {}),
                          }}
                          onMouseDown={e => handleMouseDown(i, e as unknown as React.MouseEvent)}
                          onClick={() => setSelectedIndex(i)}
                        >
                          {lines.map((line, li) => (
                            <tspan key={li} x={pos.left} dy={li === 0 ? 0 : fontSize * lineHeight}>
                              {line}
                            </tspan>
                          ))}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Fonts */}
              <div className="mt-2 flex items-center gap-2">
                {fontAssets.map(f => <Badge key={f.id} color="blue" className="text-[10px]">{f.filename}</Badge>)}
                <label className="cursor-pointer">
                  <input type="file" accept=".ttf,.otf" onChange={handleUploadFont} className="hidden" />
                  <span className="text-[10px] text-[var(--accent-9)] hover:underline cursor-pointer">+ Add font</span>
                </label>
              </div>
            </div>

            {/* Field properties panel */}
            <div className="flex-1 min-w-[200px]">
              {selectedField ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-[var(--gray-12)]">
                      {selectedField.type === 'qr'
                        ? 'QR Code Field'
                        : selectedField.text !== undefined
                        ? 'Static Text Field'
                        : 'Variable Text Field'}
                    </h4>
                    <button onClick={() => removeField(selectedIndex!)} className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer">
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {selectedField.type === 'text' && (
                    <div>
                      <label className="text-[10px] text-[var(--gray-9)]">Source</label>
                      <select
                        value={selectedField.text !== undefined ? 'static' : 'variable'}
                        onChange={e => {
                          if (e.target.value === 'static') {
                            updateField(selectedIndex!, { text: selectedField.text ?? 'Your text here', variable: undefined });
                          } else {
                            updateField(selectedIndex!, { text: undefined, variable: selectedField.variable || 'party.name' });
                          }
                        }}
                        className="w-full px-2 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]"
                      >
                        <option value="variable">Variable</option>
                        <option value="static">Static Text</option>
                      </select>
                    </div>
                  )}

                  {selectedField.type === 'text' && selectedField.text !== undefined ? (
                    <div>
                      <label className="text-[10px] text-[var(--gray-9)]">Text</label>
                      <input
                        type="text"
                        value={selectedField.text}
                        onChange={e => updateField(selectedIndex!, { text: e.target.value })}
                        placeholder="Enter static text"
                        className="w-full px-2 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="text-[10px] text-[var(--gray-9)]">Variable</label>
                      <select value={selectedField.variable || ''} onChange={e => updateField(selectedIndex!, { variable: e.target.value })}
                        className="w-full px-2 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]">
                        {variables.map(v => <option key={v.variable} value={v.variable}>{v.variable}</option>)}
                      </select>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-1">
                    <div>
                      <label className="text-[10px] text-[var(--gray-9)]">X</label>
                      <input type="number" step="0.5" value={selectedField.x} onChange={e => updateField(selectedIndex!, { x: parseFloat(e.target.value) || 0 })}
                        className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--gray-9)]">Y</label>
                      <input type="number" step="0.5" value={selectedField.y} onChange={e => updateField(selectedIndex!, { y: parseFloat(e.target.value) || 0 })}
                        className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                    </div>
                  </div>

                  {selectedField.type === 'text' && (
                    <>
                      <div className="grid grid-cols-2 gap-1">
                        <div>
                          <label className="text-[10px] text-[var(--gray-9)]">Size</label>
                          <input
                            type="number"
                            step="0.1"
                            min="1"
                            value={selectedField.fontSize ?? 12}
                            onChange={e => {
                              const v = parseFloat(e.target.value);
                              updateField(selectedIndex!, { fontSize: Number.isFinite(v) ? v : 12 });
                            }}
                            className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--gray-9)]">Color</label>
                          <input type="color" value={selectedField.color || '#000000'} onChange={e => updateField(selectedIndex!, { color: e.target.value })}
                            className="w-full h-6 border border-[var(--gray-6)] rounded cursor-pointer" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        <div>
                          <label className="text-[10px] text-[var(--gray-9)]">Align</label>
                          <select value={selectedField.align || 'left'} onChange={e => updateField(selectedIndex!, { align: e.target.value as PdfField['align'] })}
                            className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]">
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                            <option value="right">Right</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--gray-9)]">Font</label>
                          <select value={selectedField.fontAssetId || ''} onChange={e => updateField(selectedIndex!, { fontAssetId: e.target.value || undefined })}
                            className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]">
                            <option value="">Helvetica</option>
                            {fontAssets.map(f => <option key={f.id} value={f.id}>{f.filename}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        <div>
                          <label className="text-[10px] text-[var(--gray-9)] block truncate" title="Max wrap width in points — 0 = no wrap">Max Width (pts)</label>
                          <input
                            type="number"
                            step="1"
                            min="0"
                            value={selectedField.maxWidth ?? 0}
                            onChange={e => {
                              const v = parseFloat(e.target.value);
                              updateField(selectedIndex!, { maxWidth: Number.isFinite(v) && v > 0 ? v : undefined });
                            }}
                            className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                          <p className="text-[9px] text-[var(--gray-9)] mt-0.5">0 = no wrap</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--gray-9)] block truncate" title="Line spacing multiplier applied to font size">Line Height</label>
                          <input
                            type="number"
                            step="0.05"
                            min="0.5"
                            value={selectedField.lineHeight ?? 1}
                            onChange={e => {
                              const v = parseFloat(e.target.value);
                              updateField(selectedIndex!, { lineHeight: Number.isFinite(v) && v > 0 ? v : undefined });
                            }}
                            className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                          <p className="text-[9px] text-[var(--gray-9)] mt-0.5">× font size (1.0 = tight)</p>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] text-[var(--gray-9)]">Rotation (degrees, counter-clockwise)</label>
                        <input type="number" step="1" value={selectedField.rotation || 0}
                          onChange={e => updateField(selectedIndex!, { rotation: parseFloat(e.target.value) || 0 })}
                          className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                      </div>
                    </>
                  )}

                  {selectedField.type === 'qr' && (
                    <>
                      <div>
                        <label className="text-[10px] text-[var(--gray-9)]">Size (pts)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="1"
                          value={selectedField.size ?? 52}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            updateField(selectedIndex!, { size: Number.isFinite(v) ? v : 52 });
                          }}
                          className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                      </div>
                      <div>
                        <label className="text-[10px] text-[var(--gray-9)]">Rotation (degrees)</label>
                        <input type="number" step="1" value={selectedField.rotation || 0}
                          onChange={e => updateField(selectedIndex!, { rotation: parseFloat(e.target.value) || 0 })}
                          className="w-full px-1.5 py-1 text-xs border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)]" />
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="text-xs text-[var(--gray-9)] py-4 text-center">
                  {fields.length === 0
                    ? 'Add text or QR code fields, then drag them onto the template'
                    : 'Click a field on the template to edit its properties'}
                </div>
              )}

              {/* Field list */}
              {fields.length > 0 && (
                <div className="mt-3 space-y-1">
                  <span className="text-[10px] font-medium text-[var(--gray-9)]">All Fields</span>
                  {fields.map((f, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between px-2 py-1 rounded text-xs cursor-pointer ${
                        selectedIndex === i ? 'bg-[var(--accent-3)] text-[var(--accent-11)]' : 'hover:bg-[var(--gray-3)] text-[var(--gray-11)]'
                      }`}
                      onClick={() => setSelectedIndex(i)}
                    >
                      <span className="truncate max-w-[140px]">
                        {f.type === 'qr'
                          ? '◻ QR'
                          : f.text !== undefined
                          ? `"${f.text}"`
                          : f.variable}
                      </span>
                      <button onClick={e => { e.stopPropagation(); removeField(i); }} className="text-[var(--gray-9)] hover:text-red-600">
                        <TrashIcon className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* No background yet — show upload options */}
        {bgPath && !bgUrl && (
          <div className="px-4 py-4 text-sm text-[var(--gray-9)] text-center">Loading PDF preview...</div>
        )}
      </div>

      {bgPath && (
        <div className="flex items-center px-4 py-2 border-t border-[var(--gray-6)] bg-[var(--color-background)]">
          <Button variant="ghost" size="1" onClick={() => { setBgPath(''); setBgUrl(null); }}>
            Change Background
          </Button>
        </div>
      )}
    </div>
  );
});

export default PdfTemplateEditor;
