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

import { useState, type ReactElement } from 'react';

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
  // Container.tsx renders `${maxWidth}px`, so we keep the storage
  // shape as a string — Number() coerces existing edition data.
  const num = typeof value === 'number' ? value : Number(value) || 600;
  return (
    <div style={ROW_STYLE}>
      <input
        type="range"
        min={320}
        max={800}
        step={10}
        value={num}
        onChange={(e) => onChange(String(Number(e.target.value)))}
        style={RANGE_STYLE}
      />
      <span style={READOUT_STYLE}>{num}px</span>
    </div>
  );
}

export function NewsletterPaddingSliderField({ value, onChange }: PuckCustomFieldProps): ReactElement {
  const str = typeof value === 'string' ? value : '24px';
  // Match a value of the form `Npx` (single number, single unit) —
  // anything else (`40px 16px`, `2em`, `var(--gap)`, `calc(...)`)
  // goes into advanced mode.
  const uniformMatch = str.trim().match(/^(\d+(?:\.\d+)?)px$/);
  const isUniform = !!uniformMatch;
  const num = uniformMatch ? Number(uniformMatch[1]) : 24;

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
      <div style={ROW_STYLE}>
        <input
          type="range"
          min={0}
          max={80}
          step={1}
          value={num}
          onChange={(e) => onChange(`${Number(e.target.value)}px`)}
          style={RANGE_STYLE}
        />
        <span style={READOUT_STYLE}>{num}px</span>
      </div>
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
