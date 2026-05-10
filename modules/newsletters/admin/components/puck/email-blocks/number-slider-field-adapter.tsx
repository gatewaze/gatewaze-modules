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

import { useEffect, useRef, useState, type ReactElement } from 'react';

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
 * The input is UNCONTROLLED (defaultValue + ref) instead of controlled
 * (value={...}). The history that forced this:
 *
 *   - We started with `value={draft}` and synced draft<-prop in a
 *     useEffect. Fast drags rubber-banded because Puck's async
 *     onChange echoed back stale values mid-drag.
 *   - Added a draggingRef to skip the sync during active drags.
 *     The rubber-band stopped but the drag itself stalled after 1-2
 *     pixels: React 19's reconciler sets `value` on the DOM element
 *     on every render, and doing so on `<input type="range">` while
 *     the browser holds implicit pointer capture on the thumb
 *     breaks the capture — the drag silently ends. Each pointer
 *     move starts a tiny new drag, hence "moves 1-2px and stops".
 *
 * Uncontrolled inputs avoid the issue entirely. React never touches
 * the input's `value` after mount; the browser owns the drag from
 * start to finish. Two extra pieces:
 *
 *   - The px readout next to the slider has its own `draft` state so
 *     it can update on every onChange without rerendering the
 *     input. Updating the span doesn't disturb the drag.
 *   - For external resets (undo, reset, programmatic), a useEffect
 *     imperatively writes `inputRef.current.value` when the prop
 *     changes — but only when not currently dragging, so undo
 *     mid-drag doesn't fight the operator.
 *
 * Document-level pointerup tears down draggingRef even if the cursor
 * leaves the thumb mid-gesture (native range inputs don't always
 * fire pointerup on the input element in that case).
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
  // This component does NOT use React's synthetic event system for
  // the input. The drag interaction is wired up imperatively via
  // native addEventListener in a useEffect, and the input is fully
  // uncontrolled (no value prop, no React onChange). Reasoning:
  //
  //   - React 19 reconciling an <input type="range"> during a drag
  //     breaks the browser's implicit pointer capture on the thumb.
  //     The drag stalls after 1-2 pixels.
  //   - Even with an uncontrolled input + stable defaultValue,
  //     ANY React state change during drag forces a render of this
  //     component, and the React reconciler still touches the
  //     input's prop bag enough to disrupt the pointer capture.
  //   - Going fully native bypasses React's render cycle for the
  //     drag. The browser handles the slider, our 'input' listener
  //     reads the new value, and we call Puck's onChange via a
  //     ref-stored reference so the listener identity is stable.
  //
  // External resets (undo, programmatic) still flow through: the
  // second useEffect imperatively syncs `inputRef.current.value`
  // when the prop changes, but only when the operator isn't
  // actively dragging.

  const initialRef = useRef<number | null>(null);
  if (initialRef.current === null) {
    const p = parse(value);
    initialRef.current = Number.isFinite(p) ? p : fallback;
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);

  // Keep latest callbacks accessible to the native event listener
  // without needing to re-attach it (which would happen on every
  // render of the parent given the inline lambdas it passes).
  const onChangeRef = useRef(onChange);
  const emitRef = useRef(emit);
  onChangeRef.current = onChange;
  emitRef.current = emit;

  const parsed = parse(value);
  const externalNum = Number.isFinite(parsed) ? parsed : fallback;

  // Native input listener — attached once on mount, never re-attached.
  // 'input' fires on every value change, including during a drag.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onInput = () => {
      const v = Number(input.value);
      if (readoutRef.current) {
        readoutRef.current.textContent = `${v}px`;
      }
      onChangeRef.current(emitRef.current(v));
    };
    input.addEventListener('input', onInput);
    return () => input.removeEventListener('input', onInput);
  }, []);

  // Drag-state tracking + document-level pointerup teardown.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onDown = () => { draggingRef.current = true; };
    input.addEventListener('pointerdown', onDown);
    const stopDrag = () => { draggingRef.current = false; };
    document.addEventListener('pointerup', stopDrag);
    document.addEventListener('pointercancel', stopDrag);
    return () => {
      input.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', stopDrag);
      document.removeEventListener('pointercancel', stopDrag);
    };
  }, []);

  // External sync — write input.value imperatively when the prop
  // changes and the operator isn't currently dragging.
  useEffect(() => {
    if (draggingRef.current) return;
    const input = inputRef.current;
    const readout = readoutRef.current;
    if (!input) return;
    if (Number(input.value) !== externalNum) {
      input.value = String(externalNum);
      if (readout) readout.textContent = `${externalNum}px`;
    }
  }, [externalNum]);

  return (
    <div style={ROW_STYLE}>
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={initialRef.current}
        style={RANGE_STYLE}
      />
      <span ref={readoutRef} style={READOUT_STYLE}>
        {initialRef.current}px
      </span>
    </div>
  );
}
