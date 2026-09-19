import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Modal } from '@/components/ui';
import { PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import {
  CARD_FOLD_PT,
  CARD_HEIGHT_PT,
  CARD_WIDTH_PT,
  SAMPLE_PLACE_CARD_CONTEXT,
  defaultPlaceCardFields,
  fontAssetPublicUrl,
  getFontAssets,
  getPlaceCardVariables,
  resolvePlaceCardVariable,
  savePlaceCardTemplate,
  uploadFontAsset,
  type CardFace,
  type FontAsset,
  type PlaceCardField,
  type PlaceCardTemplate,
} from '../utils/placeCards';
import { wrapLines } from '../utils/placeCardPdf';

/**
 * Visual editor for the folded place-card template. Two panels show the flat
 * 83 x 108mm card — the outside (front and back of the standing tent) and
 * the inside (the reverse of the sheet) — with the scored fold marked across
 * the middle. Fields drag into place; the panel a field sits on decides
 * which face it prints on. Layout, fonts and the field maths mirror the
 * invites PDF template editor, so a field behaves the same in both.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  eventUuid: string;
  /** The template the generator matched, or null to create the event default. */
  template: PlaceCardTemplate | null;
  /** Shown so the admin knows which scope they are editing. */
  scopeLabel: string;
  onSaved: (template: PlaceCardTemplate) => void;
}

const PANEL_WIDTH = 250;
const PANEL_HEIGHT = Math.round(PANEL_WIDTH * (CARD_HEIGHT_PT / CARD_WIDTH_PT));
const SCALE = PANEL_WIDTH / CARD_WIDTH_PT;
const FOLD_TOP = PANEL_HEIGHT - CARD_FOLD_PT * SCALE;

const FACES: Array<{ id: CardFace; label: string; topHint: string; bottomHint: string }> = [
  {
    id: 'outside',
    label: 'Outside',
    topHint: 'back of tent — prints upside-down',
    bottomHint: 'front of tent',
  },
  {
    id: 'inside',
    label: 'Inside (reverse side)',
    topHint: 'reads upright inside the standing card',
    bottomHint: 'inside of the front panel',
  },
];

export function PlaceCardTemplateEditor({ isOpen, onClose, eventUuid, template, scopeLabel, onSaved }: Props) {
  const [name, setName] = useState('Place cards');
  const [fields, setFields] = useState<PlaceCardField[]>([]);
  const [fontAssets, setFontAssets] = useState<FontAsset[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dragging, setDragging] = useState<{ index: number; face: CardFace } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const panelRefs = useRef<Partial<Record<CardFace, HTMLDivElement | null>>>({});
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  if (!measureCtxRef.current && typeof document !== 'undefined') {
    measureCtxRef.current = document.createElement('canvas').getContext('2d');
  }

  const variables = getPlaceCardVariables();

  useEffect(() => {
    if (!isOpen) return;
    setName(template?.name || 'Place cards');
    setFields(template?.pdf_fields?.length ? template.pdf_fields : defaultPlaceCardFields());
    setSelectedIndex(null);
    getFontAssets(eventUuid)
      .then(setFontAssets)
      .catch((err) => console.error('[event-seating] Failed to load fonts:', err));
  }, [isOpen, template, eventUuid]);

  // @font-face declarations for uploaded fonts, so the preview shows them.
  useEffect(() => {
    if (!isOpen || fontAssets.length === 0) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'place-card-template-fonts';
    styleEl.textContent = fontAssets
      .map((f) => `@font-face { font-family: 'pc-font-${f.id}'; src: url('${fontAssetPublicUrl(f)}') format('truetype'); }`)
      .join('\n');
    document.head.appendChild(styleEl);
    return () => { document.getElementById('place-card-template-fonts')?.remove(); };
  }, [isOpen, fontAssets]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return;
    const panel = panelRefs.current[dragging.face];
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const left = Math.max(0, Math.min(e.clientX - rect.left, PANEL_WIDTH));
    const top = Math.max(0, Math.min(e.clientY - rect.top, PANEL_HEIGHT));
    const x = Math.round((left / SCALE) * 10) / 10;
    const y = Math.round(((PANEL_HEIGHT - top) / SCALE) * 10) / 10;
    setFields((prev) => prev.map((f, i) => (i === dragging.index ? { ...f, x, y } : f)));
  }, [dragging]);

  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(null);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, handleMouseMove]);

  const addField = (face: CardFace, source: 'variable' | 'static') => {
    const base: PlaceCardField = {
      face,
      x: CARD_WIDTH_PT / 2,
      y: face === 'inside' ? CARD_FOLD_PT + 26 : 92,
      fontSize: 14,
      align: 'center',
      color: '#000000',
      ...(face === 'inside' ? { rotation: 180 } : {}),
    };
    const newField = source === 'variable'
      ? { ...base, variable: face === 'inside' ? 'meal.choices' : 'guest.first_name' }
      : { ...base, text: 'Your text here' };
    setFields((prev) => [...prev, newField]);
    setSelectedIndex(fields.length);
  };

  const updateField = (index: number, updates: Partial<PlaceCardField>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...updates } : f)));
  };

  const removeField = (index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex(null);
  };

  const handleUploadFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.match(/\.(ttf|otf)$/i)) { toast.error('Only TTF/OTF fonts'); return; }
    setUploading(true);
    try {
      await uploadFontAsset(eventUuid, file);
      setFontAssets(await getFontAssets(eventUuid));
      toast.success(`Font "${file.name}" uploaded`);
    } catch (err) {
      console.error('[event-seating] Font upload failed:', err);
      toast.error('Failed to upload font');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const saved = await savePlaceCardTemplate({
        id: template?.id,
        event_id: eventUuid,
        sub_event_id: template ? template.sub_event_id : null,
        name: name.trim(),
        pdf_fields: fields,
      });
      toast.success('Place-card template saved');
      onSaved(saved);
      onClose();
    } catch (err) {
      console.error('[event-seating] Failed to save the template:', err);
      toast.error('Could not save the template');
    } finally {
      setSaving(false);
    }
  };

  const selectedField = selectedIndex !== null ? fields[selectedIndex] : null;

  const renderPanel = (face: (typeof FACES)[number]) => (
    <div key={face.id}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--gray-11)]">{face.label}</span>
        <div className="flex gap-1">
          <Button variant="soft" size="1" onClick={() => addField(face.id, 'variable')}>
            <PlusIcon className="mr-0.5 h-3 w-3" />Variable
          </Button>
          <Button variant="soft" size="1" onClick={() => addField(face.id, 'static')}>
            <PlusIcon className="mr-0.5 h-3 w-3" />Static
          </Button>
        </div>
      </div>
      <div
        ref={(el) => { panelRefs.current[face.id] = el; }}
        className="relative select-none overflow-hidden rounded border border-[var(--gray-6)] bg-white"
        style={{ width: PANEL_WIDTH, height: PANEL_HEIGHT, cursor: dragging ? 'grabbing' : 'default' }}
      >
        {/* Fold line and face hints */}
        <div
          className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-[var(--gray-8)]"
          style={{ top: FOLD_TOP }}
        />
        <span className="pointer-events-none absolute left-1 top-1 text-[9px] text-[var(--gray-8)]">
          {face.topHint}
        </span>
        <span className="pointer-events-none absolute bottom-1 left-1 text-[9px] text-[var(--gray-8)]">
          {face.bottomHint}
        </span>

        <svg
          className="absolute inset-0"
          width={PANEL_WIDTH}
          height={PANEL_HEIGHT}
          style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
          {fields.map((field, i) => {
            if (field.face !== face.id) return null;
            const left = field.x * SCALE;
            const top = PANEL_HEIGHT - field.y * SCALE;
            const isSelected = selectedIndex === i;
            const fontSize = (field.fontSize || 12) * SCALE;
            const lineHeightMul = field.lineHeight ?? 1;
            const fontFamily = field.fontAssetId ? `'pc-font-${field.fontAssetId}', sans-serif` : 'sans-serif';
            const rotation = field.rotation || 0;

            const rawText = field.text !== undefined
              ? field.text
              : (resolvePlaceCardVariable(field.variable || '', SAMPLE_PLACE_CARD_CONTEXT) || `{{${field.variable || ''}}}`);
            const maxWidthDisplay = field.maxWidth ? field.maxWidth * SCALE : undefined;
            const lines = wrapLines(rawText, maxWidthDisplay, (s) => {
              const ctx = measureCtxRef.current;
              if (!ctx) return s.length * fontSize * 0.5;
              ctx.font = `${fontSize}px ${fontFamily}`;
              return ctx.measureText(s).width;
            });

            const textAnchor = field.align === 'center' ? 'middle' : field.align === 'right' ? 'end' : 'start';
            return (
              <g key={i} transform={rotation ? `rotate(${-rotation} ${left} ${top})` : undefined}>
                <text
                  x={left}
                  y={top}
                  fontSize={fontSize}
                  fontFamily={fontFamily}
                  fill={field.color || '#000000'}
                  textAnchor={textAnchor}
                  style={{
                    pointerEvents: 'auto',
                    cursor: dragging?.index === i ? 'grabbing' : 'grab',
                    userSelect: 'none',
                    ...(isSelected ? { paintOrder: 'stroke fill', stroke: '#3b82f6', strokeWidth: 0.75 } : {}),
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setDragging({ index: i, face: face.id });
                    setSelectedIndex(i);
                  }}
                  onClick={() => setSelectedIndex(i)}
                >
                  {lines.map((line, li) => (
                    <tspan key={li} x={left} dy={li === 0 ? 0 : fontSize * lineHeightMul}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Place-card template"
      size="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="ghost" size="1" onClick={() => setFields(defaultPlaceCardFields())}>
            Reset to default layout
          </Button>
          <div className="flex gap-2">
            <Button variant="soft" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save Template'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-[var(--gray-11)]">
          The card prints flat at 83 × 108mm and folds across the dashed line into a
          standing tent, 83 × 54mm per face. Drag fields into place — {scopeLabel}.
        </p>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--gray-11)]">Template Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1.5 text-sm text-[var(--gray-12)]"
          />
        </div>

        <div className="flex gap-4">
          <div className="flex flex-shrink-0 gap-4">
            {FACES.map(renderPanel)}
          </div>

          {/* Field properties */}
          <div className="min-w-[200px] flex-1">
            {selectedField ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-[var(--gray-12)]">
                    {selectedField.text !== undefined ? 'Static Text Field' : 'Variable Text Field'}
                  </h4>
                  <button
                    onClick={() => removeField(selectedIndex!)}
                    className="cursor-pointer text-[var(--gray-9)] hover:text-red-600"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div>
                  <label className="text-[10px] text-[var(--gray-9)]">Source</label>
                  <select
                    value={selectedField.text !== undefined ? 'static' : 'variable'}
                    onChange={(e) => {
                      if (e.target.value === 'static') {
                        updateField(selectedIndex!, { text: selectedField.text ?? 'Your text here', variable: undefined });
                      } else {
                        updateField(selectedIndex!, { text: undefined, variable: selectedField.variable || 'guest.first_name' });
                      }
                    }}
                    className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--gray-12)]"
                  >
                    <option value="variable">Variable</option>
                    <option value="static">Static Text</option>
                  </select>
                </div>

                {selectedField.text !== undefined ? (
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Text</label>
                    <input
                      type="text"
                      value={selectedField.text}
                      onChange={(e) => updateField(selectedIndex!, { text: e.target.value })}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--gray-12)]"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Variable</label>
                    <select
                      value={selectedField.variable || ''}
                      onChange={(e) => updateField(selectedIndex!, { variable: e.target.value })}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--gray-12)]"
                    >
                      {variables.map((v) => (
                        <option key={v.variable} value={v.variable} title={v.description}>{v.variable}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="text-[10px] text-[var(--gray-9)]">Face</label>
                  <select
                    value={selectedField.face}
                    onChange={(e) => updateField(selectedIndex!, { face: e.target.value as CardFace })}
                    className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--gray-12)]"
                  >
                    <option value="outside">Outside</option>
                    <option value="inside">Inside</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">X</label>
                    <input
                      type="number" step="0.5" value={selectedField.x}
                      onChange={(e) => updateField(selectedIndex!, { x: parseFloat(e.target.value) || 0 })}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Y</label>
                    <input
                      type="number" step="0.5" value={selectedField.y}
                      onChange={(e) => updateField(selectedIndex!, { y: parseFloat(e.target.value) || 0 })}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Size</label>
                    <input
                      type="number" step="0.1" min="1" value={selectedField.fontSize ?? 12}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        updateField(selectedIndex!, { fontSize: Number.isFinite(v) ? v : 12 });
                      }}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Color</label>
                    <input
                      type="color" value={selectedField.color || '#000000'}
                      onChange={(e) => updateField(selectedIndex!, { color: e.target.value })}
                      className="h-6 w-full cursor-pointer rounded border border-[var(--gray-6)]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Align</label>
                    <select
                      value={selectedField.align || 'left'}
                      onChange={(e) => updateField(selectedIndex!, { align: e.target.value as PlaceCardField['align'] })}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    >
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-[var(--gray-9)]">Font</label>
                    <select
                      value={selectedField.fontAssetId || ''}
                      onChange={(e) => updateField(selectedIndex!, { fontAssetId: e.target.value || undefined })}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    >
                      <option value="">Helvetica</option>
                      {fontAssets.map((f) => <option key={f.id} value={f.id}>{f.filename}</option>)}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <div>
                    <label className="block truncate text-[10px] text-[var(--gray-9)]" title="Max wrap width in points — 0 = no wrap">Max Width (pts)</label>
                    <input
                      type="number" step="1" min="0" value={selectedField.maxWidth ?? 0}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        updateField(selectedIndex!, { maxWidth: Number.isFinite(v) && v > 0 ? v : undefined });
                      }}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    />
                  </div>
                  <div>
                    <label className="block truncate text-[10px] text-[var(--gray-9)]" title="Line spacing multiplier applied to font size">Line Height</label>
                    <input
                      type="number" step="0.05" min="0.5" value={selectedField.lineHeight ?? 1}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        updateField(selectedIndex!, { lineHeight: Number.isFinite(v) && v > 0 ? v : undefined });
                      }}
                      className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-[var(--gray-9)]">Rotation (degrees, counter-clockwise)</label>
                  <input
                    type="number" step="1" value={selectedField.rotation || 0}
                    onChange={(e) => updateField(selectedIndex!, { rotation: parseFloat(e.target.value) || 0 })}
                    className="w-full rounded border border-[var(--gray-6)] bg-[var(--color-background)] px-1.5 py-1 text-xs text-[var(--gray-12)]"
                  />
                  <p className="mt-0.5 text-[9px] text-[var(--gray-9)]">
                    180 on the top half prints upside-down, so it reads upright once the card stands.
                  </p>
                </div>
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-[var(--gray-9)]">
                Click a field on either face to edit it, or add one with the buttons above each panel.
              </div>
            )}

            {/* Fonts */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {fontAssets.map((f) => <Badge key={f.id} color="blue" className="text-[10px]">{f.filename}</Badge>)}
              <label className="cursor-pointer">
                <input type="file" accept=".ttf,.otf" onChange={handleUploadFont} className="hidden" />
                <span className="cursor-pointer text-[10px] text-[var(--accent-9)] hover:underline">
                  {uploading ? 'Uploading…' : '+ Add font'}
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default PlaceCardTemplateEditor;
