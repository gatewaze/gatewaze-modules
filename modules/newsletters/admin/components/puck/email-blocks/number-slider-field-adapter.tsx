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
        <AdvancedPaddingInput value={str} onChange={onChange} />
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
/**
 * Advanced padding text input. Same uncontrolled-with-focus-aware-sync
 * pattern as PxSlider, for the same reason: a controlled `value={...}`
 * input loses the user's keystroke on every onChange because Puck's
 * dispatch is async — by the time React commits, the value prop is
 * still the old string and React resets the DOM value. The reset is
 * harsh enough that focus is lost (the operator can only type one
 * character before having to re-click).
 *
 * Uncontrolled input + ref-based imperative sync only when the input
 * isn't currently focused. The operator's typing always wins until
 * they tab/click away; external resets (going back to slider mode
 * and back) sync the new value into the field.
 */
function AdvancedPaddingInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: unknown) => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const initialRef = useRef<string | null>(null);
  if (initialRef.current === null) initialRef.current = value;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Don't fight the operator's typing — only sync when they're
    // not focused on the input. External resets (mode-switch,
    // undo, programmatic) land outside an active typing session.
    if (document.activeElement === input) return;
    if (input.value !== value) {
      input.value = value;
    }
  }, [value]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onInput = () => {
      onChangeRef.current(input.value);
    };
    input.addEventListener('input', onInput);
    return () => input.removeEventListener('input', onInput);
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={initialRef.current}
      placeholder="e.g. 24px or 40px 16px"
      style={TEXT_INPUT_STYLE}
    />
  );
}

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
  // Commit-on-release implementation. Calling Puck's onChange on
  // every pointermove kicks off resolveComponentData + dispatch +
  // subscribers re-rendering the whole canvas/fields panel — that
  // chain runs on the main thread, and the time it takes per move
  // event is longer than the time between moves on a fast drag.
  // Pointer events queue, the browser starves the slider, the drag
  // appears to stall after 1-2 pixels.
  //
  // The fix is to let the browser own the drag entirely: the slider
  // updates its own position natively, the readout updates via
  // textContent on every input event, but we only commit the final
  // value to Puck on pointerup. Trade-off: no live canvas preview
  // during drag, but the slider is fully responsive and the canvas
  // updates the instant the operator releases.
  //
  // The input is uncontrolled with a stable defaultValue captured
  // once via a ref. External resets (undo, programmatic) sync the
  // input value imperatively, gated on the not-currently-dragging
  // state.

  const initialRef = useRef<number | null>(null);
  if (initialRef.current === null) {
    const p = parse(value);
    initialRef.current = Number.isFinite(p) ? p : fallback;
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);
  const pendingValueRef = useRef<number | null>(null);

  const onChangeRef = useRef(onChange);
  const emitRef = useRef(emit);
  onChangeRef.current = onChange;
  emitRef.current = emit;

  const parsed = parse(value);
  const externalNum = Number.isFinite(parsed) ? parsed : fallback;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onInput = () => {
      const v = Number(input.value);
      pendingValueRef.current = v;
      if (readoutRef.current) {
        readoutRef.current.textContent = `${v}px`;
      }
    };
    const commit = () => {
      const v = pendingValueRef.current;
      pendingValueRef.current = null;
      draggingRef.current = false;
      if (v === null) return;
      onChangeRef.current(emitRef.current(v));
    };
    const onDown = () => { draggingRef.current = true; };
    const onKey = (e: KeyboardEvent) => {
      // Keyboard nudges (arrow keys / page up/down / home/end)
      // commit immediately — there's no "release" gesture.
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
        queueMicrotask(() => {
          const v = Number(input.value);
          onChangeRef.current(emitRef.current(v));
          pendingValueRef.current = null;
        });
      }
    };
    input.addEventListener('input', onInput);
    input.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', commit);
    document.addEventListener('pointercancel', commit);
    input.addEventListener('keyup', onKey);
    return () => {
      input.removeEventListener('input', onInput);
      input.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', commit);
      document.removeEventListener('pointercancel', commit);
      input.removeEventListener('keyup', onKey);
    };
  }, []);

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
