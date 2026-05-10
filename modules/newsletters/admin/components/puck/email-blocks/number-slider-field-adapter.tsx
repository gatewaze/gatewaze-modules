/**
 * Slider-style custom Puck fields for px-valued numeric inputs.
 *
 * Two exports:
 *
 *   - `NewsletterMaxWidthSliderField`: single-axis slider for the
 *     Container block's `maxWidth` (and any future numeric width).
 *     Stores the value as a string so it doesn't drift from the
 *     historical Container shape (`${maxWidth}px` in the renderer).
 *
 *   - `NewsletterPaddingSliderField`: slider for uniform padding,
 *     plus an "advanced" toggle that drops to a free-form text
 *     input. The Container block's `padding` prop is a CSS string —
 *     usually `"24px"` (single value) but operators occasionally
 *     want shorthand like `"40px 16px"`. The slider handles the
 *     uniform case; advanced lets them author the rest. If the
 *     saved value isn't parseable as a single px number, advanced
 *     opens by default so the operator sees what's actually stored.
 *
 * Both are wired as Puck `type: 'custom'` fields. Same pattern as
 * `NewsletterImageFieldAdapter` — Puck passes `{ value, onChange }`,
 * we render whatever UI we want, and emit string values back.
 */

import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

interface PuckCustomFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
  name?: string;
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const READOUT_STYLE: React.CSSProperties = {
  minWidth: 56,
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--gray-12, inherit)',
};

const RANGE_STYLE: React.CSSProperties = {
  flex: 1,
  accentColor: 'var(--accent-9, #2563eb)',
};

const LINK_BTN_STYLE: React.CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 12,
  color: 'var(--accent-11, #2563eb)',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
};

const TEXT_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--gray-a6, #d1d5db)',
  borderRadius: 4,
  fontSize: 13,
  boxSizing: 'border-box',
};

export function NewsletterMaxWidthSliderField({ value, onChange }: PuckCustomFieldProps): ReactElement {
  return (
    <PxSlider
      value={value}
      onChange={onChange}
      min={320}
      max={800}
      step={1}
      fallback={600}
      emit={(v) => String(v)}
      parse={(raw) => (typeof raw === 'number' ? raw : Number(raw))}
    />
  );
}

export function NewsletterPaddingSliderField({ value, onChange }: PuckCustomFieldProps): ReactElement {
  const str = typeof value === 'string' ? value : '24px';
  // Match a value of the form Npx (single number, single unit) —
  // anything else ("40px 16px", "2em", "var(--gap)", "calc(...)")
  // goes into advanced mode.
  const uniformMatch = str.trim().match(/^(\d+(?:\.\d+)?)px$/);
  const isUniform = !!uniformMatch;

  const [advanced, setAdvanced] = useState(!isUniform);

  if (advanced) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          type="text"
          value={str}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. 24px or 40px 16px"
          style={TEXT_INPUT_STYLE}
        />
        <button
          type="button"
          onClick={() => {
            // Drop back into slider mode with whatever number we can
            // parse from the current value (so the slider doesn't
            // fight the operator's intent).
            const m = str.trim().match(/^(\d+(?:\.\d+)?)/);
            const fallback = m ? Number(m[1]) : 24;
            onChange(`${fallback}px`);
            setAdvanced(false);
          }}
          style={LINK_BTN_STYLE}
        >
          ← back to slider
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <PxSlider
        value={value}
        onChange={onChange}
        min={0}
        max={80}
        step={1}
        fallback={24}
        emit={(v) => `${v}px`}
        parse={(raw) => {
          if (typeof raw === 'number') return raw;
          const m = (typeof raw === 'string' ? raw : '').trim().match(/^(\d+(?:\.\d+)?)px$/);
          return m ? Number(m[1]) : NaN;
        }}
      />
      <button
        type="button"
        onClick={() => setAdvanced(true)}
        style={LINK_BTN_STYLE}
      >
        Advanced (CSS shorthand)
      </button>
    </div>
  );
}

/**
 * Internal px-slider primitive used by both Container slider fields.
 *
 * Why a primitive instead of two copy-pasted implementations: getting
 * the sync logic right is the whole point of this file, and we want
 * one source of truth. The behaviour:
 *
 *   - The input is a fully controlled React `<input type="range">`.
 *   - `value` derives the displayed position via `parse(value)` →
 *     numeric, or `fallback` if the parse fails.
 *   - On every change we call `onChange(emit(v))` so Puck gets the
 *     formatted external value (`"42"` for width, `"42px"` for
 *     padding) AND we update local `draft` state immediately so the
 *     thumb tracks the pointer without waiting for Puck's async
 *     dispatch to round-trip.
 *   - `draft` only re-syncs from `value` when the user is NOT
 *     actively dragging (`draggingRef`). Otherwise every async
 *     echo from Puck would yank the thumb back to the last
 *     committed value — read as "only jumps in single increments"
 *     when the operator tries to drag continuously.
 *   - We listen for pointerdown on the `wrapperRef` (the row that
 *     contains the input + the px readout) AND a global
 *     pointerup/pointercancel on the document. Native range
 *     inputs don't always re-fire pointerup if the operator's
 *     cursor leaves the thumb during a drag, so document-level
 *     teardown is safer than relying on the input's own events.
 */
function PxSlider({
  value,
  onChange,
  min,
  max,
  step,
  fallback,
  parse,
  emit,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  min: number;
  max: number;
  step: number;
  fallback: number;
  parse: (raw: unknown) => number;
  emit: (n: number) => string;
}): ReactElement {
  const parsed = parse(value);
  const externalNum = Number.isFinite(parsed) ? parsed : fallback;

  const [draft, setDraft] = useState(externalNum);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) setDraft(externalNum);
  }, [externalNum]);

  // Document-level drag teardown — see component-level docblock.
  useEffect(() => {
    const stopDrag = () => { draggingRef.current = false; };
    document.addEventListener('pointerup', stopDrag);
    document.addEventListener('pointercancel', stopDrag);
    return () => {
      document.removeEventListener('pointerup', stopDrag);
      document.removeEventListener('pointercancel', stopDrag);
    };
  }, []);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setDraft(v);
    onChange(emit(v));
  };

  return (
    <div
      style={ROW_STYLE}
      onPointerDown={() => { draggingRef.current = true; }}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={handleChange}
        style={RANGE_STYLE}
      />
      <span style={READOUT_STYLE}>{draft}px</span>
    </div>
  );
}
